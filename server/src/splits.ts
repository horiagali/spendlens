import type { DB } from './db.ts';
import { tx } from './db.ts';
import { reclassifyAll } from './rules.ts';

export interface SplitSuggestion {
  incomingId: string;
  expenseIds: string[];
  fraction: number; // share of the expense(s) the incoming payment covers
  score: number; // lower is better
}

interface Row { id: string; date: string; amount: number; counterparty: string | null; category_id: number | null; }

const FRACTIONS = [1 / 2, 1 / 3, 2 / 3, 1 / 4, 3 / 4, 1];
const WINDOW_BEFORE_DAYS = 45;
const WINDOW_AFTER_DAYS = 3;

const days = (a: string, b: string) => (Date.parse(a) - Date.parse(b)) / 86_400_000;
const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(5, Math.round(b * 0.01)); // 5 cents or 1%

/**
 * Find expenses that an incoming transfer (e.g. "Transfer from Roommate", €30) probably pays back
 * part of (e.g. €60 groceries two days earlier). Single expenses and pairs are considered.
 */
export function suggestSplits(db: DB, limitPerIncoming = 3): SplitSuggestion[] {
  const incoming = db.prepare(`SELECT id, date, amount, counterparty, category_id FROM transactions t
    WHERE kind = 'income' AND kind_source != 'manual' AND amount > 0 AND counterparty IS NOT NULL
      AND category_id IS NULL -- income you labeled (salary, grants...) is never a payback
      AND NOT EXISTS (SELECT 1 FROM reimbursements r WHERE r.incoming_id = t.id)
    ORDER BY date DESC`).all() as unknown as Row[];
  if (incoming.length === 0) return [];
  const expenses = db.prepare(`SELECT t.id, t.date, -t.amount - COALESCE((SELECT SUM(r.amount) FROM reimbursements r WHERE r.expense_id = t.id), 0) AS amount,
      t.counterparty, t.category_id
    FROM transactions t WHERE kind = 'spend' AND amount < 0 ORDER BY date`).all() as unknown as Row[];
  const dismissed = new Set(
    (db.prepare('SELECT incoming_id, expense_ids FROM dismissed_suggestions').all() as { incoming_id: string; expense_ids: string }[])
      .map((d) => `${d.incoming_id}|${d.expense_ids}`),
  );
  const partners = new Set(
    (db.prepare(`SELECT DISTINCT lower(t.counterparty) AS c FROM reimbursements r JOIN transactions t ON t.id = r.incoming_id`)
      .all() as { c: string }[]).map((r) => r.c),
  );

  const out: SplitSuggestion[] = [];
  for (const inc of incoming) {
    const window = expenses.filter((e) => e.amount > 0 && days(inc.date, e.date) <= WINDOW_BEFORE_DAYS && days(e.date, inc.date) <= WINDOW_AFTER_DAYS);
    const partnerBonus = partners.has((inc.counterparty ?? '').toLowerCase()) ? -1 : 0;
    const found: SplitSuggestion[] = [];
    const consider = (group: Row[]) => {
      const total = group.reduce((s, e) => s + e.amount, 0);
      for (const [i, f] of FRACTIONS.entries()) {
        if (f === 1 && group.length > 1) continue; // full payback of several expenses is too loose a match
        if (!close(inc.amount, Math.round(total * f))) continue;
        const ids = group.map((e) => e.id).sort();
        if (dismissed.has(`${inc.id}|${ids.join(',')}`)) continue;
        const gap = Math.max(...group.map((e) => Math.abs(days(inc.date, e.date))));
        // Prefer even splits, recent expenses, single expenses, and people you've split with before.
        found.push({ incomingId: inc.id, expenseIds: ids, fraction: f, score: i * 0.4 + gap * 0.05 + (group.length - 1) * 0.6 + partnerBonus });
        break;
      }
    };
    for (let a = 0; a < window.length; a++) {
      consider([window[a]!]);
      for (let b = a + 1; b < window.length; b++) {
        if (window[a]!.amount + window[b]!.amount >= inc.amount) consider([window[a]!, window[b]!]);
      }
    }
    found.sort((x, y) => x.score - y.score);
    out.push(...found.slice(0, limitPerIncoming));
  }
  return out;
}

/**
 * Allocate an incoming payment across expenses, proportionally to their remaining
 * (not yet reimbursed) amounts, never allocating more than the payment or the expenses.
 */
export function linkReimbursement(db: DB, incomingId: string, expenseIds: string[]) {
  const inc = db.prepare('SELECT amount FROM transactions WHERE id = ?').get(incomingId) as { amount: number } | undefined;
  if (!inc || inc.amount <= 0) throw new Error('Incoming transaction must be a positive amount');
  const remainingOf = db.prepare(`SELECT -t.amount - COALESCE((SELECT SUM(amount) FROM reimbursements WHERE expense_id = t.id AND incoming_id != ?), 0) AS remaining
    FROM transactions t WHERE t.id = ? AND t.amount < 0`);
  const remaining = expenseIds.map((id) => {
    const r = remainingOf.get(incomingId, id) as { remaining: number } | undefined;
    if (!r) throw new Error(`Expense ${id} not found or not an outgoing payment`);
    return Math.max(0, r.remaining);
  });
  const totalRemaining = remaining.reduce((a, b) => a + b, 0);
  const toAllocate = Math.min(inc.amount, totalRemaining);
  tx(db, () => {
    db.prepare('DELETE FROM reimbursements WHERE incoming_id = ?').run(incomingId);
    const ins = db.prepare('INSERT INTO reimbursements (incoming_id, expense_id, amount) VALUES (?, ?, ?)');
    let left = toAllocate;
    expenseIds.forEach((id, i) => {
      const share = i === expenseIds.length - 1 ? left : Math.round((toAllocate * remaining[i]!) / (totalRemaining || 1));
      const amt = Math.min(share, remaining[i]!, left);
      if (amt > 0) ins.run(incomingId, id, amt);
      left -= amt;
    });
  });
  reclassifyAll(db);
}

/** Link the best suggestion for every incoming payment, without reusing an expense twice per round. */
export function acceptAllSuggestions(db: DB): { linked: number } {
  let linked = 0;
  for (;;) {
    const best = suggestSplits(db, 1);
    if (best.length === 0) break;
    const used = new Set<string>();
    const before = linked;
    for (const s of best) {
      if (s.expenseIds.some((id) => used.has(id))) continue;
      linkReimbursement(db, s.incomingId, s.expenseIds);
      s.expenseIds.forEach((id) => used.add(id));
      linked++;
    }
    if (linked === before) break;
  }
  return { linked };
}

export function unlinkReimbursement(db: DB, incomingId: string) {
  db.prepare('DELETE FROM reimbursements WHERE incoming_id = ?').run(incomingId);
  reclassifyAll(db);
}

export function dismissSuggestion(db: DB, incomingId: string, expenseIds: string[]) {
  db.prepare('INSERT OR IGNORE INTO dismissed_suggestions (incoming_id, expense_ids) VALUES (?, ?)')
    .run(incomingId, [...expenseIds].sort().join(','));
}
