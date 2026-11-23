export type Kind = 'spend' | 'income' | 'reimbursement' | 'internal' | 'excluded';
export const KINDS: Kind[] = ['spend', 'income', 'reimbursement', 'internal', 'excluded'];

export type Bucket = 'lifestyle' | 'fixed' | 'separate';
export const BUCKETS: Bucket[] = ['lifestyle', 'fixed', 'separate'];
export const BUCKET_LABEL: Record<Bucket, string> = { lifestyle: 'Day-to-day', fixed: 'Fixed costs', separate: 'Set apart' };
export interface Category { id: number; name: string; color: string | null; isIncome: number; bucket: Bucket; }
export interface Txn {
  id: string; source: string; account: string; type: string; startedAt: string; date: string; description: string; reference: string;
  merchant: string; merchantKey: string; counterparty: string | null; amount: number; fee: number; currency: string;
  state: string; kind: Kind; kindSource: string; categoryId: number | null; categorySource: string | null;
  ruleId: number | null; oneOff: number; note: string | null; reimbursed: number; allocated: number; reviewed: number;
}
export interface PeriodItem { id: string; date: string; merchant: string; description: string; amount: number; oneOff: boolean; }
export interface PeriodGroup { categoryId: number | null; name: string; bucket: Bucket; total: number; byMonth: Record<string, number>; items: PeriodItem[]; }
export interface PeriodReport {
  from: string; to: string; months: string[];
  income: { total: number; byMonth: Record<string, number>; sources: PeriodGroup[] };
  spending: { total: number; byMonth: Record<string, number>; byBucket: Record<Bucket, number>; categories: PeriodGroup[] };
}
export type ReviewItem = Txn & { reasons: string[] };
export interface MonthReport {
  month: string; income: number; spending: number; oneOff: number; savedInternally: number;
  byBucket: Record<Bucket, number>; lifestyleOneOff: number;
  byCategory: Record<string, number>; incomeByCategory: Record<string, number>;
}
export interface Summary {
  months: MonthReport[]; baseCurrency: string;
  counts: { total: number; uncategorized: number | null; firstDate: string | null; lastDate: string | null };
}
export interface PeriodSummary {
  months: number; avgIncome: number; avgSpending: number; avgRecurringSpending: number; avgByCategory: Record<string, number>;
  avgByBucket: Record<Bucket, number>; avgRecurringLifestyle: number;
}
export interface InboxItem { merchantKey: string; merchant: string; kind: Kind; count: number; total: number; lastDate: string; sampleDescription: string; }
export type ConditionField = 'merchant' | 'merchantKey' | 'description' | 'reference' | 'counterparty' | 'type' | 'account' | 'state' | 'currency' | 'direction' | 'amount';
export interface Condition { field: ConditionField; op: string; value: string | number; }
export interface Rule {
  id: number; name: string; priority: number; enabled: boolean; conditions: Condition[];
  setKind: Kind | null; setCategoryId: number | null; system: boolean; matchCount: number;
}
export interface SplitSuggestion { incomingId: string; expenseIds: string[]; fraction: number; score: number; }
export interface SplitLink {
  incomingId: string; expenseId: string; amount: number; incomingDate: string; counterparty: string | null;
  incomingAmount: number; expenseDate: string; expenseMerchant: string; expenseAmount: number;
}

async function req<T>(method: string, path: string, body?: unknown, raw = false): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': raw ? 'text/csv' : 'application/json' },
    body: body === undefined ? undefined : raw ? (body as string) : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data as T;
}

const qs = (p: Record<string, string | number | undefined>) =>
  new URLSearchParams(Object.entries(p).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)])).toString();

export const api = {
  summary: () => req<Summary>('GET', '/api/summary'),
  compare: (cutoff: string) => req<{ before: PeriodSummary; after: PeriodSummary }>('GET', `/api/compare?${qs({ cutoff })}`),
  transactions: (p: Record<string, string | number | undefined>) => req<{ total: number; items: Txn[] }>('GET', `/api/transactions?${qs(p)}`),
  period: (from?: string) => req<PeriodReport>('GET', `/api/period?${qs({ from })}`),
  review: () => req<ReviewItem[]>('GET', '/api/review'),
  updateTxn: (id: string, patch: Partial<{ kind: Kind | null; categoryId: number | null; oneOff: boolean; note: string; reviewed: boolean }>) =>
    req<Txn>('PATCH', `/api/transactions/${encodeURIComponent(id)}`, patch),
  inbox: () => req<InboxItem[]>('GET', '/api/inbox'),
  label: (b: { merchantKey: string; merchant: string; categoryId?: number | null; kind?: Kind | null }) => req('POST', '/api/inbox/label', b),
  categories: () => req<Category[]>('GET', '/api/categories'),
  addCategory: (b: { name: string; isIncome: boolean; bucket?: Bucket }) => req<{ id: number }>('POST', '/api/categories', b),
  updateCategory: (id: number, b: Partial<{ name: string; isIncome: boolean; bucket: Bucket }>) => req('PATCH', `/api/categories/${id}`, b),
  deleteCategory: (id: number) => req('DELETE', `/api/categories/${id}`),
  rules: () => req<Rule[]>('GET', '/api/rules'),
  previewRule: (conditions: Condition[]) => req<{ count: number; sample: Txn[] }>('POST', '/api/rules/preview', { conditions }),
  addRule: (b: Partial<Rule>) => req<{ id: number }>('POST', '/api/rules', b),
  updateRule: (id: number, b: Partial<Rule>) => req('PATCH', `/api/rules/${id}`, b),
  deleteRule: (id: number) => req('DELETE', `/api/rules/${id}`),
  splitSuggestions: () => req<{ suggestions: SplitSuggestion[]; transactions: Record<string, Txn> }>('GET', '/api/splits/suggestions'),
  splits: () => req<SplitLink[]>('GET', '/api/splits'),
  link: (incomingId: string, expenseIds: string[]) => req('POST', '/api/splits/link', { incomingId, expenseIds }),
  acceptAll: () => req<{ linked: number }>('POST', '/api/splits/accept-all'),
  dismiss: (incomingId: string, expenseIds: string[]) => req('POST', '/api/splits/dismiss', { incomingId, expenseIds }),
  unlink: (incomingId: string) => req('DELETE', `/api/splits/${encodeURIComponent(incomingId)}`),
  importCsv: (text: string, name: string) => req<{ added: number; updated: number; unchanged: number }>('POST', `/api/import/revolut-csv?${qs({ name })}`, text, true),
  imports: () => req<{ id: number; source: string; label: string | null; added: number; updated: number; at: string }[]>('GET', '/api/imports'),
  syncStatus: () => req<{ configured: boolean; linked: boolean; validUntil: string | null; daysLeft: number | null; lastSync: string | null; accounts: number }>('GET', '/api/sync/status'),
  sync: () => req<{ added: number; updated: number; unchanged: number }>('POST', '/api/sync'),
  settings: () => req<Record<string, string>>('GET', '/api/settings'),
  saveSettings: (b: Record<string, string | null>) => req('PUT', '/api/settings', b),
};

export function money(cents: number, currency = 'EUR', opts: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, ...opts }).format(cents / 100);
}
export const moneyShort = (cents: number, currency = 'EUR') => money(cents, currency, { maximumFractionDigits: 0 });

export function monthLabel(m: string, style: 'short' | 'long' = 'short'): string {
  const [y, mo] = m.split('-').map(Number);
  return new Date(y!, mo! - 1, 1).toLocaleDateString(undefined, { month: style, year: style === 'long' ? 'numeric' : '2-digit' });
}
