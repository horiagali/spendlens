import type { DB } from './db.ts';
import { getSetting } from './db.ts';
import type { Bucket } from './types.ts';

export interface MonthReport {
  month: string; // YYYY-MM
  income: number; // cents
  spending: number; // cents, net of refunds and reimbursements, including fees
  oneOff: number; // part of spending flagged as one-off purchases
  byBucket: Record<Bucket, number>; // spending split into day-to-day, fixed costs and set-apart costs
  lifestyleOneOff: number; // one-offs within the lifestyle bucket
  savedInternally: number; // net moved from the current account into savings/vaults
  byCategory: Record<string, number>; // category id (or "uncategorized") -> spending cents
  incomeByCategory: Record<string, number>;
}

/**
 * Monthly totals in the base currency. Reimbursements count against the month and category
 * of the expense they pay back, so a €60 shop with €30 returned shows as €30 of groceries.
 * Any part of a reimbursement not allocated to an expense counts as income.
 */
export function monthlyReport(db: DB): MonthReport[] {
  const currency = getSetting(db, 'base_currency') ?? 'EUR';
  const months = new Map<string, MonthReport>();
  const get = (m: string) => {
    let r = months.get(m);
    if (!r) months.set(m, (r = {
      month: m, income: 0, spending: 0, oneOff: 0, byBucket: { lifestyle: 0, fixed: 0, separate: 0 }, lifestyleOneOff: 0,
      savedInternally: 0, byCategory: {}, incomeByCategory: {},
    }));
    return r;
  };
  const add = (rec: Record<string, number>, key: string, v: number) => { rec[key] = (rec[key] ?? 0) + v; };

  const rows = db.prepare(`SELECT t.id, substr(t.date, 1, 7) AS month, t.amount, t.fee, t.kind, t.category_id, t.one_off, t.account,
      COALESCE((SELECT c.bucket FROM categories c WHERE c.id = t.category_id), 'lifestyle') AS bucket,
      COALESCE((SELECT SUM(r.amount) FROM reimbursements r WHERE r.expense_id = t.id), 0) AS reimbursed,
      COALESCE((SELECT SUM(r.amount) FROM reimbursements r WHERE r.incoming_id = t.id), 0) AS allocated
    FROM transactions t WHERE t.currency = ?`).all(currency) as Record<string, any>[];

  for (const t of rows) {
    const m = get(t.month);
    const cat = t.category_id === null ? 'uncategorized' : String(t.category_id);
    switch (t.kind) {
      case 'spend': {
        const cost = -t.amount + t.fee - t.reimbursed;
        m.spending += cost;
        add(m.byCategory, cat, cost);
        m.byBucket[t.bucket as Bucket] += cost;
        if (t.one_off) m.oneOff += cost;
        if (t.one_off && t.bucket === 'lifestyle') m.lifestyleOneOff += cost;
        break;
      }
      case 'income':
        m.income += t.amount - t.fee;
        add(m.incomeByCategory, cat, t.amount - t.fee);
        break;
      case 'reimbursement': {
        const leftover = t.amount - t.allocated;
        if (leftover > 0) { m.income += leftover; add(m.incomeByCategory, 'uncategorized', leftover); }
        break;
      }
      case 'internal':
        if (/^current$/i.test(t.account)) m.savedInternally += -t.amount;
        break;
    }
  }
  return [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
}

export interface PeriodSummary {
  months: number;
  avgIncome: number;
  avgSpending: number;
  avgRecurringSpending: number; // excluding one-offs
  avgByBucket: Record<Bucket, number>;
  avgRecurringLifestyle: number; // day-to-day spending excluding one-offs: the "am I spending more?" number
  avgByCategory: Record<string, number>;
}

/** Average per-month figures before and after a date (e.g. starting a job). Partial months are left out. */
export function compareAround(db: DB, cutoff: string): { before: PeriodSummary; after: PeriodSummary } {
  const all = monthlyReport(db);
  const first = all[0]?.month;
  const current = new Date().toISOString().slice(0, 7);
  const cutoffMonth = cutoff.slice(0, 7);
  const full = all.filter((m) => m.month !== first && m.month !== current && m.month !== cutoffMonth);
  const summarize = (ms: MonthReport[]): PeriodSummary => {
    const n = ms.length || 1;
    const avgByCategory: Record<string, number> = {};
    for (const m of ms) for (const [k, v] of Object.entries(m.byCategory)) avgByCategory[k] = (avgByCategory[k] ?? 0) + v / n;
    return {
      months: ms.length,
      avgIncome: ms.reduce((s, m) => s + m.income, 0) / n,
      avgSpending: ms.reduce((s, m) => s + m.spending, 0) / n,
      avgRecurringSpending: ms.reduce((s, m) => s + m.spending - m.oneOff, 0) / n,
      avgByBucket: {
        lifestyle: ms.reduce((s, m) => s + m.byBucket.lifestyle, 0) / n,
        fixed: ms.reduce((s, m) => s + m.byBucket.fixed, 0) / n,
        separate: ms.reduce((s, m) => s + m.byBucket.separate, 0) / n,
      },
      avgRecurringLifestyle: ms.reduce((s, m) => s + m.byBucket.lifestyle - m.lifestyleOneOff, 0) / n,
      avgByCategory,
    };
  };
  return {
    before: summarize(full.filter((m) => m.month < cutoffMonth)),
    after: summarize(full.filter((m) => m.month > cutoffMonth)),
  };
}
