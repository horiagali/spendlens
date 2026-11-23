import type { DB } from './db.ts';
import { tx } from './db.ts';
import { extractCounterparty, normalizeMerchant } from './merchant.ts';
import { reclassifyAll } from './rules.ts';
import type { ImportedTxn } from './types.ts';

export interface ImportResult { added: number; updated: number; unchanged: number; }

/**
 * Find a transaction from a *different* source that is the same real-world payment: same account
 * currency and amount, dated within 3 days, and not already matched to this source.
 */
function findCrossSourceMatch(db: DB, t: ImportedTxn): string | null {
  const row = db.prepare(`SELECT t.id FROM transactions t
    WHERE t.source != ? AND t.amount = ? AND t.currency = ?
      AND abs(julianday(substr(t.started_at, 1, 10)) - julianday(?)) <= 3
      AND NOT EXISTS (SELECT 1 FROM txn_aliases a WHERE a.txn_id = t.id AND a.alias_id LIKE ?)
    ORDER BY abs(julianday(substr(t.started_at, 1, 10)) - julianday(?)) LIMIT 1`)
    .get(t.source, t.amount, t.currency, t.startedAt.slice(0, 10), `${prefixOf(t.id)}%`, t.startedAt.slice(0, 10)) as { id: string } | undefined;
  return row?.id ?? null;
}
const prefixOf = (id: string) => id.slice(0, id.indexOf('_') + 1);

/**
 * Upsert imported transactions. New rows get merchant/counterparty derived; existing rows only
 * have their volatile fields (state, completion, balance) refreshed so manual edits survive.
 */
export function importTransactions(db: DB, txns: ImportedTxn[], label: string | null = null): ImportResult {
  const result: ImportResult = { added: 0, updated: 0, unchanged: 0 };
  const find = db.prepare('SELECT state, completed_at, balance FROM transactions WHERE id = ?');
  const insert = db.prepare(`INSERT INTO transactions
    (id, source, account, type, started_at, completed_at, date, description, merchant, merchant_key, counterparty,
     amount, fee, currency, state, balance, raw, kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'spend')`);
  const refresh = db.prepare('UPDATE transactions SET state = ?, completed_at = ?, balance = ?, raw = ? WHERE id = ?');
  const findAlias = db.prepare('SELECT txn_id FROM txn_aliases WHERE alias_id = ?');
  const addAlias = db.prepare('INSERT INTO txn_aliases (alias_id, txn_id) VALUES (?, ?)');
  tx(db, () => {
    for (const t of txns) {
      const existing = find.get(t.id) as { state: string; completed_at: string | null; balance: number | null } | undefined;
      if (existing) {
        if (existing.state !== t.state || existing.completed_at !== t.completedAt || existing.balance !== t.balance) {
          refresh.run(t.state, t.completedAt, t.balance, JSON.stringify(t.raw), t.id);
          result.updated++;
        } else result.unchanged++;
        continue;
      }
      if (findAlias.get(t.id)) { result.unchanged++; continue; }
      // Never double count a payment seen by both the CSV export and bank sync.
      const twin = t.state === 'COMPLETED' ? findCrossSourceMatch(db, t) : null;
      if (twin) {
        addAlias.run(t.id, twin);
        result.unchanged++;
        continue;
      }
      const counterparty = extractCounterparty(t.type, t.description);
      const m = counterparty ? { name: counterparty, key: counterparty.toLowerCase() } : normalizeMerchant(t.description);
      insert.run(t.id, t.source, t.account, t.type, t.startedAt, t.completedAt, t.startedAt.slice(0, 10), t.description,
        m.name, m.key, counterparty, t.amount, t.fee, t.currency, t.state, t.balance, JSON.stringify(t.raw));
      result.added++;
    }
    db.prepare('INSERT INTO imports (source, label, added, updated) VALUES (?, ?, ?, ?)')
      .run(txns[0]?.source ?? 'unknown', label, result.added, result.updated);
  });
  reclassifyAll(db);
  return result;
}
