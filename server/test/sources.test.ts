import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { openDb } from '../src/db.ts';
import { makeJwt, mapEbTransaction } from '../src/importers/enableBanking.ts';
import { parseRevolutCsv } from '../src/importers/revolutCsv.ts';
import { monthlyReport, periodReport, reviewQueue } from '../src/reports.ts';
import { importTransactions } from '../src/store.ts';

const NEW_STYLE = `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
Card Payment,Current,2026-03-02 9:05:01,2026-03-03 10:00:00,Lidl,-23.10,0.00,EUR,COMPLETED,900.00
Transfer,Current,2026-03-03 08:00:00,2026-03-03 08:00:00,To EUR Japan trip,-100.00,0.00,EUR,COMPLETED,800.00
Transfer,Current,2026-03-04 08:00:00,2026-03-04 08:00:00,To Ron Weasley,-40.00,0.00,EUR,COMPLETED,760.00
Interest,Deposit,2026-03-05 02:00:00,2026-03-05 02:00:00,Interest earned - Savings,0.05,0.01,EUR,COMPLETED,5000.04
Transfer,Current,2026-03-06 08:00:00,2026-03-06 08:00:00,Revolut Vault | To EUR RoundUps,-0.70,0.00,EUR,COMPLETED,759.30
`;

test('newer CSV style: mixed-case types, unpadded hours, named vaults', () => {
  const rows = parseRevolutCsv(NEW_STYLE);
  assert.equal(rows[0]!.type, 'CARD_PAYMENT');
  assert.equal(rows[0]!.startedAt, '2026-03-02 09:05:01');
  const db = openDb(':memory:');
  importTransactions(db, rows);
  const kind = (d: string) => (db.prepare('SELECT kind FROM transactions WHERE description = ?').get(d) as { kind: string }).kind;
  assert.equal(kind('Lidl'), 'spend');
  assert.equal(kind('To EUR Japan trip'), 'internal');
  assert.equal(kind('To Ron Weasley'), 'spend'); // a person, not a vault
  assert.equal(kind('Interest earned - Savings'), 'internal');
  assert.equal(kind('Revolut Vault | To EUR RoundUps'), 'internal');
});

test('Enable Banking JWT is a valid RS256 token', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwt = makeJwt('app-123', privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
  const [h, p, sig] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h!, 'base64url').toString()), { typ: 'JWT', alg: 'RS256', kid: 'app-123' });
  const claims = JSON.parse(Buffer.from(p!, 'base64url').toString());
  assert.equal(claims.aud, 'api.enablebanking.com');
  assert.ok(claims.exp - claims.iat <= 86400);
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(sig!, 'base64url')));
});

const ACCOUNT = { uid: 'acc-1', currency: 'EUR' };

test('Enable Banking transactions map onto CSV-style descriptions', () => {
  const card = mapEbTransaction({
    entry_reference: 'r1', transaction_amount: { amount: '23.10', currency: 'EUR' }, credit_debit_indicator: 'DBIT',
    status: 'BOOK', booking_date: '2026-03-02', creditor: { name: 'Lidl' }, merchant_category_code: '5411',
  }, ACCOUNT);
  assert.equal(card.amount, -2310);
  assert.equal(card.description, 'Lidl');
  assert.equal(card.type, 'CARD_PAYMENT');
  const incoming = mapEbTransaction({
    entry_reference: 'r2', transaction_amount: { amount: '30.00', currency: 'EUR' }, credit_debit_indicator: 'CRDT',
    status: 'BOOK', booking_date: '2026-03-04', debtor: { name: 'JOHN DOE' }, creditor: { name: 'Jane Me' },
    bank_transaction_code: { code: 'TRANSFER' }, remittance_information: ['For Albert Heijn From JOHN DOE'],
  }, ACCOUNT);
  assert.equal(incoming.description, 'Transfer from JOHN DOE');
  assert.equal(incoming.reference, 'For Albert Heijn From JOHN DOE');
  const company = mapEbTransaction({
    entry_reference: 'r4', transaction_amount: { amount: '672.12', currency: 'EUR' }, credit_debit_indicator: 'DBIT',
    status: 'BOOK', booking_date: '2026-03-05', creditor: { name: 'Stichting DUWO' }, bank_transaction_code: { code: 'TRANSFER' },
    remittance_information: ['7499473965 0020008700372340 To Stichting DUWO'],
  }, ACCOUNT);
  assert.equal(company.description, 'Stichting DUWO'); // not a person, so no counterparty
  const request = mapEbTransaction({
    entry_reference: 'r5', transaction_amount: { amount: '12.50', currency: 'EUR' }, credit_debit_indicator: 'DBIT',
    status: 'BOOK', booking_date: '2026-03-05', creditor: { name: 'Hr J Doe via ING Betaalverzoek' }, bank_transaction_code: { code: 'TRANSFER' },
  }, ACCOUNT);
  assert.equal(request.description, 'To J Doe');
  const refund = mapEbTransaction({
    entry_reference: 'r6', transaction_amount: { amount: '2.87', currency: 'EUR' }, credit_debit_indicator: 'CRDT',
    status: 'BOOK', booking_date: '2026-03-05', debtor: { name: 'JANE ME' }, bank_transaction_code: { code: 'CARD_REFUND' },
    remittance_information: ['Refund from Nlovb85yya6kded5ve'],
  }, ACCOUNT);
  assert.equal(refund.description, 'Nlovb85yya6kded5ve');
  const vault = mapEbTransaction({
    entry_reference: 'r3', transaction_amount: { amount: '0.70', currency: 'EUR' }, credit_debit_indicator: 'DBIT',
    status: 'BOOK', booking_date: '2026-03-06', creditor: { name: 'Jane Me' }, bank_transaction_code: { code: 'TRANSFER' },
    remittance_information: ['To pocket EUR Savings'],
  }, ACCOUNT);
  assert.equal(vault.description, 'To pocket EUR Savings');
});

test('the same payment from CSV and bank sync is counted once', () => {
  const db = openDb(':memory:');
  importTransactions(db, parseRevolutCsv(NEW_STYLE));
  const eb = mapEbTransaction({
    entry_reference: 'r1', transaction_amount: { amount: '23.10', currency: 'EUR' }, credit_debit_indicator: 'DBIT',
    status: 'BOOK', booking_date: '2026-03-03', transaction_date: '2026-03-02', creditor: { name: 'LIDL NL' },
  }, ACCOUNT);
  const r1 = importTransactions(db, [eb]);
  assert.deepEqual([r1.added, r1.unchanged], [0, 1]);
  const r2 = importTransactions(db, [eb]); // re-sync: alias is remembered
  assert.deepEqual([r2.added, r2.unchanged], [0, 1]);
  const newer = { ...eb, id: 'eb_other', startedAt: '2026-03-20 00:00:00' };
  assert.equal(importTransactions(db, [newer]).added, 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n, 6);
});

test('split-bill memos, company transfers and buckets', () => {
  const db = openDb(':memory:');
  const tx = (ref: string, amount: string, dbit: boolean, extra: Record<string, unknown>) => mapEbTransaction({
    entry_reference: ref, transaction_amount: { amount, currency: 'EUR' }, credit_debit_indicator: dbit ? 'DBIT' : 'CRDT',
    status: 'BOOK', booking_date: '2026-03-10', bank_transaction_code: { code: 'TRANSFER' }, ...extra,
  }, ACCOUNT);
  importTransactions(db, [
    tx('a', '20.00', true, { creditor: { name: 'John Doe' }, debtor: { name: 'Jane Me' }, remittance_information: ['For Albert Heijn To JOHN DOE'] }),
    tx('b', '5.00', false, { debtor: { name: 'John Doe' }, creditor: { name: 'Jane Me' }, remittance_information: ['For Albert Heijn From JOHN DOE'] }),
    tx('c', '672.12', true, { creditor: { name: 'Stichting DUWO' }, remittance_information: ['7499473965 To Stichting DUWO'] }),
    tx('d', '2530.00', true, { creditor: { name: 'TU DELFT' }, remittance_information: ['VFS277923 To Tu Delft'] }),
    tx('e', '3.00', true, { creditor: { name: 'John Doe' }, debtor: { name: 'Jane Me' }, remittance_information: ['For SPAR University To JOHN DOE'] }),
  ]);
  const row = (ref: string) => ({ ...db.prepare(`SELECT t.kind, t.merchant, t.counterparty, c.name AS category FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id WHERE t.raw LIKE ?`).get(`%"entry_reference":"${ref}"%`) as Record<string, any> });
  assert.deepEqual(row('a'), { kind: 'spend', merchant: 'Albert Heijn', counterparty: 'John Doe', category: 'Groceries' });
  assert.deepEqual(row('b'), { kind: 'spend', merchant: 'Albert Heijn', counterparty: 'John Doe', category: 'Groceries' }); // a refund
  assert.deepEqual(row('c'), { kind: 'spend', merchant: 'Stichting DUWO', counterparty: null, category: 'Rent' });
  assert.equal(row('d').category, 'Tuition');
  assert.equal(row('e').category, 'Groceries'); // not tuition
  const [m] = monthlyReport(db);
  assert.deepEqual(m!.byBucket, { lifestyle: 2000 - 500 + 300, fixed: 67212, separate: 253000 });
});

test('period report groups money in and out; review queue flags big transfers with people', () => {
  const db = openDb(':memory:');
  const tx = (ref: string, amount: string, dbit: boolean, date: string, extra: Record<string, unknown>) => mapEbTransaction({
    entry_reference: ref, transaction_amount: { amount, currency: 'EUR' }, credit_debit_indicator: dbit ? 'DBIT' : 'CRDT',
    status: 'BOOK', booking_date: date, bank_transaction_code: { code: 'TRANSFER' }, ...extra,
  }, ACCOUNT);
  importTransactions(db, [
    tx('s', '1600.00', false, '2026-10-26', { debtor: { name: 'ACME BV' }, bank_transaction_code: { code: 'TOPUP' }, remittance_information: ['Oct 2026 salary'] }),
    tx('l', '40.00', true, '2026-10-02', { creditor: { name: 'Lidl 263 Delft' }, bank_transaction_code: { code: 'CARD_PAYMENT' } }),
    tx('f', '300.00', false, '2026-10-05', { debtor: { name: 'John Doe' }, creditor: { name: 'Jane Me' } }),
    tx('old', '50.00', true, '2026-08-02', { creditor: { name: 'Lidl 263 Delft' }, bank_transaction_code: { code: 'CARD_PAYMENT' } }),
  ]);
  const p = periodReport(db, '2026-09-01');
  assert.deepEqual(p.months, ['2026-10']);
  assert.equal(p.income.sources.find((g) => g.name === 'Salary')?.total, 160000);
  assert.equal(p.spending.categories.find((g) => g.name === 'Groceries')?.total, 4000);
  const queue = reviewQueue(db, '2026-09-01');
  assert.equal(queue.length, 1);
  assert.match(queue[0]!.reasons[0]!, /from a person/);
});

test('a payment spread over two months counts half in each', () => {
  const db = openDb(':memory:');
  importTransactions(db, [mapEbTransaction({
    entry_reference: 'x', transaction_amount: { amount: '523.01', currency: 'EUR' }, credit_debit_indicator: 'CRDT',
    status: 'BOOK', booking_date: '2026-09-23', debtor: { name: 'BELASTINGDIENST' }, bank_transaction_code: { code: 'TOPUP' },
  }, ACCOUNT)]);
  db.prepare('UPDATE transactions SET spread_months = 2').run();
  assert.deepEqual(monthlyReport(db).map((m) => [m.month, m.income]), [['2026-09', 26151], ['2026-10', 26150]]);
  const p = periodReport(db, '2026-10-01');
  assert.deepEqual([p.income.total, p.income.sources[0]!.items[0]!.part], [26150, '2/2']);
});
