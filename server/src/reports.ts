import type { DB } from './db.ts';
import { getSetting } from './db.ts';
import type { Bucket } from './types.ts';

const SPREAD_FIELDS = ['amount', 'fee', 'reimbursed', 'allocated'] as const;
const addMonths = (month: string, n: number) => {
  const d = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};

/**
 * A transaction with spread_months = n becomes n equal parts, one per month starting with its own;
 * later parts are dated the 1st of their month. Leftover cents go to the first part.
 */
function spread<T extends Record<string, any>>(t: T): (T & { part: number; parts: number })[] {
  const n = Math.max(1, Number(t.spread_months ?? 1));
  if (n === 1) return [{ ...t, part: 1, parts: 1 }];
  return Array.from({ length: n }, (_, i) => {
    const p: Record<string, any> = { ...t, part: i + 1, parts: n };
    if (i > 0) { p.date = `${addMonths(t.date.slice(0, 7), i)}-01`; }
    p.month = p.date.slice(0, 7);
    for (const f of SPREAD_FIELDS) {
      if (typeof t[f] !== 'number') continue;
      const base = Math.trunc(t[f] / n);
      p[f] = i === 0 ? t[f] - base * (n - 1) : base;
    }
    return p as T & { part: number; parts: number };
  });
}

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

  const rows = db.prepare(`SELECT t.id, t.date, substr(t.date, 1, 7) AS month, t.amount, t.fee, t.kind, t.category_id, t.one_off, t.account, t.spread_months,
      COALESCE((SELECT c.bucket FROM categories c WHERE c.id = t.category_id), 'lifestyle') AS bucket,
      COALESCE((SELECT SUM(r.amount) FROM reimbursements r WHERE r.expense_id = t.id), 0) AS reimbursed,
      COALESCE((SELECT SUM(r.amount) FROM reimbursements r WHERE r.incoming_id = t.id), 0) AS allocated
    FROM transactions t WHERE t.currency = ?`).all(currency).flatMap((t) => spread(t as Record<string, any>));

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
        if (leftover > 0) { m.income += leftover; add(m.incomeByCategory, cat, leftover); }
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

export interface PeriodItem {
  id: string; date: string; merchant: string; description: string; amount: number; oneOff: boolean;
  part?: string; // "1/2" when the payment is spread over several months
}
export interface PeriodGroup {
  categoryId: number | null;
  name: string;
  bucket: Bucket;
  total: number; // cents: spent (expenses) or received (income), net of refunds and paybacks
  byMonth: Record<string, number>;
  items: PeriodItem[]; // biggest first
}
export interface PeriodReport {
  from: string;
  to: string;
  months: string[];
  income: { total: number; byMonth: Record<string, number>; sources: PeriodGroup[] };
  spending: { total: number; byMonth: Record<string, number>; byBucket: Record<Bucket, number>; categories: PeriodGroup[] };
}

/**
 * Everything that came in and went out between two dates, grouped by category with the
 * transactions behind each total. Counting is the same as in monthlyReport.
 */
export function periodReport(db: DB, from: string, to: string | null = null): PeriodReport {
  const currency = getSetting(db, 'base_currency') ?? 'EUR';
  const until = to ?? '9999-12-31';
  const raw = db.prepare(`SELECT t.id, t.date, t.merchant, t.description, t.amount, t.fee, t.kind, t.one_off, t.spread_months,
      t.category_id, c.name AS category, COALESCE(c.bucket, 'lifestyle') AS bucket,
      COALESCE((SELECT SUM(r.amount) FROM reimbursements r WHERE r.expense_id = t.id), 0) AS reimbursed,
      COALESCE((SELECT SUM(r.amount) FROM reimbursements r WHERE r.incoming_id = t.id), 0) AS allocated
    FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.currency = ? AND t.date <= ? AND date(t.date, '+' || (t.spread_months - 1) || ' months', 'start of month') >= date(?, 'start of month')
      AND t.kind IN ('spend', 'income', 'reimbursement')`)
    .all(currency, until, from) as Record<string, any>[];
  // Parts of a spread payment that fall after the latest real transaction (a later month) wait until that month has data.
  const lastReal = to ?? raw.reduce((max, t) => (t.date > max ? t.date : max), from);
  const rows = raw.flatMap((t) => spread(t)).filter((t) => t.date >= from && t.date <= lastReal);

  const income = new Map<string, PeriodGroup>();
  const spending = new Map<string, PeriodGroup>();
  const months = new Set<string>();
  const add = (groups: Map<string, PeriodGroup>, t: Record<string, any>, value: number, name: string | null) => {
    const key = String(t.category_id ?? 'none');
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { categoryId: t.category_id, name: name ?? 'Uncategorized', bucket: t.bucket, total: 0, byMonth: {}, items: [] }));
    const month = t.date.slice(0, 7);
    months.add(month);
    g.total += value;
    g.byMonth[month] = (g.byMonth[month] ?? 0) + value;
    g.items.push({ id: t.id, date: t.date, merchant: t.merchant, description: t.description, amount: value, oneOff: !!t.one_off,
      ...(t.parts > 1 ? { part: `${t.part}/${t.parts}` } : {}) });
  };
  for (const t of rows) {
    if (t.kind === 'spend') add(spending, t, -t.amount + t.fee - t.reimbursed, t.category);
    else if (t.kind === 'income') add(income, t, t.amount - t.fee, t.category);
    else if (t.amount - t.allocated > 0) add(income, t, t.amount - t.allocated, t.category ?? 'Paybacks not linked to an expense');
  }
  const finish = (groups: Map<string, PeriodGroup>) => {
    // Fully paid back (a tuition fee your parents covered): nothing left to show.
    const list = [...groups.values()].filter((g) => g.items.some((i) => i.amount !== 0)).sort((a, b) => b.total - a.total);
    for (const g of list) g.items.sort((a, b) => b.amount - a.amount);
    const byMonth: Record<string, number> = {};
    for (const g of list) for (const [m, v] of Object.entries(g.byMonth)) byMonth[m] = (byMonth[m] ?? 0) + v;
    return { list, total: list.reduce((s, g) => s + g.total, 0), byMonth };
  };
  const inc = finish(income);
  const sp = finish(spending);
  const byBucket: Record<Bucket, number> = { lifestyle: 0, fixed: 0, separate: 0 };
  for (const g of sp.list) byBucket[g.bucket] += g.total;
  return {
    from,
    to: lastReal,
    months: [...months].sort(),
    income: { total: inc.total, byMonth: inc.byMonth, sources: inc.list },
    spending: { total: sp.total, byMonth: sp.byMonth, byBucket, categories: sp.list },
  };
}

const BIG_FROM_PERSON = 10000; // €100
const BIG_UNLABELED = 5000;
const BIG_PURCHASE = 25000;

/**
 * Transactions worth a human look: big transfers with people (a payback? a gift? rent?),
 * big payments without a category, odd income, and big purchases (one-off?).
 * Anything you changed by hand or marked as reviewed is left out.
 */
export function reviewQueue(db: DB, from: string): { id: string; reasons: string[] }[] {
  const rows = db.prepare(`SELECT t.id, t.amount, t.kind, t.counterparty, t.category_id, t.one_off,
      c.is_income, COALESCE(c.bucket, 'lifestyle') AS bucket
    FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.date >= ? AND t.reviewed = 0 AND t.kind_source != 'manual' AND COALESCE(t.category_source, '') != 'manual'
      AND t.kind IN ('spend', 'income', 'reimbursement')
    ORDER BY t.date DESC`).all(from) as Record<string, any>[];
  const out: { id: string; reasons: string[] }[] = [];
  for (const t of rows) {
    const reasons: string[] = [];
    const fixedOrApart = t.bucket !== 'lifestyle';
    if (t.counterparty && t.amount >= BIG_FROM_PERSON && !t.is_income) reasons.push('Big transfer from a person: payback, gift or something else?');
    if (t.counterparty && t.amount <= -BIG_FROM_PERSON && !fixedOrApart) reasons.push('Big transfer to a person: what was it for?');
    if (t.kind === 'spend' && t.category_id === null && Math.abs(t.amount) >= BIG_UNLABELED && reasons.length === 0) reasons.push('No category yet');
    if (t.kind === 'income' && t.category_id === null) reasons.push('Income from an unknown source');
    if (t.kind === 'income' && t.amount < 0) reasons.push('Negative income (paid back?)');
    if (t.kind === 'spend' && !t.counterparty && t.amount <= -BIG_PURCHASE && !fixedOrApart && reasons.length === 0) {
      reasons.push(t.one_off ? 'Big purchase, marked one-off' : 'Big purchase: one-off?');
    }
    if (reasons.length) out.push({ id: t.id, reasons });
  }
  return out;
}
