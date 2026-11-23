import type { DB } from './db.ts';
import { getSetting, setSetting } from './db.ts';
import { HttpError, Router } from './http.ts';
import { parseRevolutCsv } from './importers/revolutCsv.ts';
import { compareAround, monthlyReport } from './reports.ts';
import type { Condition } from './rules.ts';
import { loadRules, matchesRule, reclassifyAll, upsertMerchantRule } from './rules.ts';
import { acceptAllSuggestions, dismissSuggestion, linkReimbursement, suggestSplits, unlinkReimbursement } from './splits.ts';
import { importTransactions } from './store.ts';
import { syncEnableBanking, syncStatus } from './sync.ts';
import { KINDS, type Kind } from './types.ts';

const TXN_COLUMNS = `t.id, t.source, t.account, t.type, t.started_at AS startedAt, t.date, t.description, t.merchant,
  t.merchant_key AS merchantKey, t.counterparty, t.amount, t.fee, t.currency, t.state, t.kind, t.kind_source AS kindSource,
  t.category_id AS categoryId, t.category_source AS categorySource, t.rule_id AS ruleId, t.one_off AS oneOff, t.note,
  COALESCE((SELECT SUM(r.amount) FROM reimbursements r WHERE r.expense_id = t.id), 0) AS reimbursed,
  COALESCE((SELECT SUM(r.amount) FROM reimbursements r WHERE r.incoming_id = t.id), 0) AS allocated`;

function assertKind(k: unknown): asserts k is Kind {
  if (!KINDS.includes(k as Kind)) throw new HttpError(400, `Invalid kind: ${String(k)}`);
}

function ruleSubjects(db: DB) {
  return db.prepare(`SELECT id, date, description, merchant, merchant_key AS merchantKey, counterparty, type, account, state, currency, amount
    FROM transactions ORDER BY date DESC`).all() as any[];
}

export function buildApi(db: DB): Router {
  const r = new Router();

  r.get('/api/summary', () => ({
    months: monthlyReport(db),
    baseCurrency: getSetting(db, 'base_currency'),
    counts: db.prepare(`SELECT
        COUNT(*) AS total,
        SUM(kind IN ('spend','income') AND category_id IS NULL) AS uncategorized,
        MIN(date) AS firstDate, MAX(date) AS lastDate FROM transactions`).get(),
  }));

  r.get('/api/compare', ({ url }) => {
    const cutoff = url.searchParams.get('cutoff') ?? getSetting(db, 'compare_date');
    if (!cutoff || !/^\d{4}-\d{2}/.test(cutoff)) throw new HttpError(400, 'cutoff=YYYY-MM-DD required');
    return compareAround(db, cutoff);
  });

  // --- transactions ---
  r.get('/api/transactions', ({ url }) => {
    const p = url.searchParams;
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (p.get('month')) { where.push('t.date LIKE ?'); args.push(`${p.get('month')}%`); }
    if (p.get('kind')) { where.push('t.kind = ?'); args.push(p.get('kind')!); }
    if (p.get('category') === 'none') where.push('t.category_id IS NULL');
    else if (p.get('category')) { where.push('t.category_id = ?'); args.push(Number(p.get('category'))); }
    if (p.get('merchantKey')) { where.push('t.merchant_key = ?'); args.push(p.get('merchantKey')!); }
    if (p.get('q')) { where.push('(t.description LIKE ? OR t.merchant LIKE ? OR t.note LIKE ?)'); const q = `%${p.get('q')}%`; args.push(q, q, q); }
    const sql = `FROM transactions t ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
    const limit = Math.min(Number(p.get('limit') ?? 200), 2000);
    const offset = Number(p.get('offset') ?? 0);
    return {
      total: (db.prepare(`SELECT COUNT(*) AS n ${sql}`).get(...args) as { n: number }).n,
      items: db.prepare(`SELECT ${TXN_COLUMNS} ${sql} ORDER BY t.started_at DESC, t.id LIMIT ? OFFSET ?`).all(...args, limit, offset),
    };
  });

  r.patch('/api/transactions/:id', async ({ params, body }) => {
    const b = await body();
    const t = db.prepare('SELECT id FROM transactions WHERE id = ?').get(params.id!);
    if (!t) throw new HttpError(404, 'Not found');
    if ('kind' in b) {
      if (b.kind === null) db.prepare("UPDATE transactions SET kind_source = 'auto' WHERE id = ?").run(params.id!);
      else { assertKind(b.kind); db.prepare("UPDATE transactions SET kind = ?, kind_source = 'manual' WHERE id = ?").run(b.kind, params.id!); }
    }
    if ('categoryId' in b) {
      if (b.categoryId === null) db.prepare('UPDATE transactions SET category_id = NULL, category_source = NULL WHERE id = ?').run(params.id!);
      else db.prepare("UPDATE transactions SET category_id = ?, category_source = 'manual' WHERE id = ?").run(Number(b.categoryId), params.id!);
    }
    if ('oneOff' in b) db.prepare('UPDATE transactions SET one_off = ? WHERE id = ?').run(b.oneOff ? 1 : 0, params.id!);
    if ('note' in b) db.prepare('UPDATE transactions SET note = ? WHERE id = ?').run(b.note || null, params.id!);
    reclassifyAll(db);
    return db.prepare(`SELECT ${TXN_COLUMNS} FROM transactions t WHERE t.id = ?`).get(params.id!);
  });

  // --- inbox: merchants still needing a label, most frequent first ---
  r.get('/api/inbox', () => db.prepare(`SELECT merchant_key AS merchantKey, MAX(merchant) AS merchant, kind,
      COUNT(*) AS count, SUM(amount) AS total, MAX(date) AS lastDate, MAX(description) AS sampleDescription
    FROM transactions WHERE kind IN ('spend', 'income') AND category_id IS NULL
    GROUP BY merchant_key, kind ORDER BY count DESC, ABS(SUM(amount)) DESC`).all());

  r.post('/api/inbox/label', async ({ body }) => {
    const b = await body();
    if (!b.merchantKey) throw new HttpError(400, 'merchantKey required');
    if (b.kind != null) assertKind(b.kind);
    const ruleId = upsertMerchantRule(db, b.merchantKey, b.merchant ?? b.merchantKey, b.categoryId ?? null, b.kind ?? null);
    return { ruleId, ...reclassifyAll(db) };
  });

  // --- categories ---
  r.get('/api/categories', () => db.prepare('SELECT id, name, color, is_income AS isIncome FROM categories ORDER BY is_income, name').all());
  r.post('/api/categories', async ({ body }) => {
    const b = await body();
    if (!b.name) throw new HttpError(400, 'name required');
    const res = db.prepare('INSERT INTO categories (name, color, is_income) VALUES (?, ?, ?)').run(b.name, b.color ?? null, b.isIncome ? 1 : 0);
    return { id: Number(res.lastInsertRowid) };
  });
  r.patch('/api/categories/:id', async ({ params, body }) => {
    const b = await body();
    db.prepare('UPDATE categories SET name = COALESCE(?, name), color = COALESCE(?, color), is_income = COALESCE(?, is_income) WHERE id = ?')
      .run(b.name ?? null, b.color ?? null, b.isIncome == null ? null : b.isIncome ? 1 : 0, Number(params.id));
  });
  r.delete('/api/categories/:id', ({ params }) => {
    db.prepare('DELETE FROM categories WHERE id = ?').run(Number(params.id));
    reclassifyAll(db);
  });

  // --- rules ---
  r.get('/api/rules', () => {
    const subjects = ruleSubjects(db);
    return loadRules(db).map((rule) => ({ ...rule, matchCount: subjects.filter((s) => matchesRule(s, rule)).length }));
  });
  r.post('/api/rules/preview', async ({ body }) => {
    const b = await body();
    const probe = { id: 0, name: '', priority: 0, enabled: true, conditions: b.conditions as Condition[], setKind: null, setCategoryId: null, system: false };
    const matches = ruleSubjects(db).filter((s) => matchesRule(s, probe));
    return { count: matches.length, sample: matches.slice(0, 20) };
  });
  r.post('/api/rules', async ({ body }) => {
    const b = await body();
    if (!Array.isArray(b.conditions) || b.conditions.length === 0) throw new HttpError(400, 'conditions required');
    if (b.setKind != null) assertKind(b.setKind);
    const res = db.prepare('INSERT INTO rules (name, priority, conditions, set_kind, set_category_id) VALUES (?, ?, ?, ?, ?)')
      .run(b.name ?? 'Rule', b.priority ?? 100, JSON.stringify(b.conditions), b.setKind ?? null, b.setCategoryId ?? null);
    reclassifyAll(db);
    return { id: Number(res.lastInsertRowid) };
  });
  r.patch('/api/rules/:id', async ({ params, body }) => {
    const b = await body();
    const cur = loadRules(db).find((x) => x.id === Number(params.id));
    if (!cur) throw new HttpError(404, 'Not found');
    const next = { ...cur, ...b };
    if (next.setKind != null) assertKind(next.setKind);
    db.prepare('UPDATE rules SET name = ?, priority = ?, enabled = ?, conditions = ?, set_kind = ?, set_category_id = ? WHERE id = ?')
      .run(next.name, next.priority, next.enabled ? 1 : 0, JSON.stringify(next.conditions), next.setKind ?? null, next.setCategoryId ?? null, cur.id);
    reclassifyAll(db);
  });
  r.delete('/api/rules/:id', ({ params }) => {
    db.prepare('DELETE FROM rules WHERE id = ?').run(Number(params.id));
    reclassifyAll(db);
  });

  // --- splits / reimbursements ---
  r.get('/api/splits/suggestions', () => {
    const suggestions = suggestSplits(db);
    const ids = [...new Set(suggestions.flatMap((s) => [s.incomingId, ...s.expenseIds]))];
    const txns = ids.length
      ? db.prepare(`SELECT ${TXN_COLUMNS} FROM transactions t WHERE t.id IN (${ids.map(() => '?').join(',')})`).all(...ids)
      : [];
    return { suggestions, transactions: Object.fromEntries((txns as any[]).map((t) => [t.id, t])) };
  });
  r.get('/api/splits', () => db.prepare(`SELECT r.incoming_id AS incomingId, r.expense_id AS expenseId, r.amount,
      i.date AS incomingDate, i.counterparty, i.amount AS incomingAmount, e.date AS expenseDate, e.merchant AS expenseMerchant, e.amount AS expenseAmount
    FROM reimbursements r JOIN transactions i ON i.id = r.incoming_id JOIN transactions e ON e.id = r.expense_id
    ORDER BY i.date DESC`).all());
  r.post('/api/splits/link', async ({ body }) => {
    const b = await body();
    if (!b.incomingId || !Array.isArray(b.expenseIds) || b.expenseIds.length === 0) throw new HttpError(400, 'incomingId and expenseIds required');
    linkReimbursement(db, b.incomingId, b.expenseIds);
  });
  r.post('/api/splits/accept-all', () => acceptAllSuggestions(db));
  r.post('/api/splits/dismiss', async ({ body }) => {
    const b = await body();
    dismissSuggestion(db, b.incomingId, b.expenseIds ?? []);
  });
  r.delete('/api/splits/:incomingId', ({ params }) => unlinkReimbursement(db, params.incomingId!));

  // --- import ---
  r.post('/api/import/revolut-csv', async ({ text, url }) => {
    const txns = parseRevolutCsv(await text());
    if (txns.length === 0) throw new HttpError(400, 'No rows found in CSV');
    return importTransactions(db, txns, url.searchParams.get('name'));
  });
  r.get('/api/imports', () => db.prepare('SELECT * FROM imports ORDER BY id DESC LIMIT 50').all());

  // --- bank sync ---
  r.get('/api/sync/status', () => syncStatus());
  r.post('/api/sync', () => syncEnableBanking(db));

  // --- settings ---
  r.get('/api/settings', () => Object.fromEntries((db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]).map((s) => [s.key, s.value])));
  r.put('/api/settings', async ({ body }) => {
    const b = await body();
    for (const [k, v] of Object.entries(b)) {
      if (!/^[a-z_]+$/.test(k)) throw new HttpError(400, `Invalid setting ${k}`);
      setSetting(db, k, v === null ? null : String(v));
    }
  });

  return r;
}
