import { createHash } from 'node:crypto';
import { parseCsvRecords } from '../csv.ts';
import { parseCents } from '../money.ts';
import type { ImportedTxn } from '../types.ts';

const REQUIRED = ['Type', 'Started Date', 'Description', 'Amount', 'Currency'];

/**
 * Parse a Revolut personal account statement export (Statements -> Excel/CSV).
 * Columns: Type, Product, Started Date, Completed Date, Description, Amount, Fee, Currency, State, Balance.
 *
 * The dedup key deliberately ignores Completed Date, State and Balance, because a row
 * exported while PENDING gets those filled in later; re-importing then updates the row.
 */
export function parseRevolutCsv(text: string): ImportedTxn[] {
  const records = parseCsvRecords(text);
  if (records.length === 0) return [];
  const missing = REQUIRED.filter((k) => !(k in records[0]!));
  if (missing.length) throw new Error(`Not a Revolut statement CSV, missing columns: ${missing.join(', ')}`);

  const seen = new Map<string, number>();
  return records.map((r) => {
    const base = [r['Product'] ?? '', r['Type'], r['Started Date'], r['Description'], r['Amount'], r['Currency']].join('|');
    const n = (seen.get(base) ?? 0) + 1; // identical rows in the same second stay distinct
    seen.set(base, n);
    return {
      id: 'rcsv_' + createHash('sha256').update(`${base}|${n}`).digest('hex').slice(0, 24),
      source: 'revolut_csv',
      account: r['Product'] || 'Current',
      type: (r['Type'] ?? '').toUpperCase().replace(/\s+/g, '_'),
      startedAt: normalizeDateTime(r['Started Date']!),
      completedAt: r['Completed Date'] ? normalizeDateTime(r['Completed Date']) : null,
      description: r['Description'] ?? '',
      reference: r['Reference'] ?? '',
      amount: parseCents(r['Amount'] ?? '0'),
      fee: parseCents(r['Fee'] ?? '0'),
      currency: r['Currency'] ?? 'EUR',
      state: (r['State'] || 'COMPLETED').toUpperCase(),
      balance: r['Balance'] ? parseCents(r['Balance']) : null,
      raw: r,
    };
  });
}

/** "2021-09-06 6:11:59" -> "2021-09-06 06:11:59" so timestamps sort as strings. */
export function normalizeDateTime(s: string): string {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s.trim());
  if (!m) throw new Error(`Unrecognized date: ${s}`);
  const p = (x: string | undefined) => (x ?? '0').padStart(2, '0');
  return `${m[1]}-${p(m[2])}-${p(m[3])} ${p(m[4])}:${p(m[5])}:${p(m[6])}`;
}
