/** How a transaction counts in reports. */
export type Kind =
  | 'spend' // counts toward spending (negative = purchase, positive = refund)
  | 'income' // money coming in from outside
  | 'reimbursement' // someone paying you back; nets against the linked expenses
  | 'internal' // moving your own money around: savings, round-ups, exchanges
  | 'excluded'; // explicitly ignored by you

export const KINDS: Kind[] = ['spend', 'income', 'reimbursement', 'internal', 'excluded'];

/** A transaction as produced by an importer, before classification. */
export interface ImportedTxn {
  /** Stable dedup key, unique per source. */
  id: string;
  source: 'revolut_csv' | 'enable_banking';
  account: string; // e.g. "Current", "Savings"
  type: string; // e.g. CARD_PAYMENT, TRANSFER
  startedAt: string; // ISO-ish "YYYY-MM-DD HH:MM:SS"
  completedAt: string | null;
  description: string;
  amount: number; // cents, signed, excluding fee
  fee: number; // cents, positive = charged to you
  currency: string;
  state: string; // COMPLETED, PENDING, REVERTED, ...
  balance: number | null;
  raw: Record<string, unknown>;
}

export interface Txn extends ImportedTxn {
  date: string; // YYYY-MM-DD used for month attribution
  merchant: string; // display name
  merchantKey: string; // normalized lowercase key used by rules
  counterparty: string | null; // person name for transfers
  kind: Kind;
  kindSource: 'auto' | 'rule' | 'manual';
  categoryId: number | null;
  categorySource: 'rule' | 'manual' | null;
  ruleId: number | null;
  oneOff: boolean;
  note: string | null;
}
