import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { openDb } from '../src/db.ts';
import { parseRevolutCsv } from '../src/importers/revolutCsv.ts';
import { extractCounterparty, normalizeMerchant, splitMerchant } from '../src/merchant.ts';
import { parseCents } from '../src/money.ts';
import { monthlyReport } from '../src/reports.ts';
import { reclassifyAll, upsertMerchantRule } from '../src/rules.ts';
import { linkReimbursement, suggestSplits } from '../src/splits.ts';
import { importTransactions } from '../src/store.ts';

const csv = readFileSync(new URL('./fixtures/sample-statement.csv', import.meta.url), 'utf8');

function freshDb() {
  const db = openDb(':memory:');
  importTransactions(db, parseRevolutCsv(csv));
  return db;
}
const byDesc = (db: ReturnType<typeof openDb>, d: string) =>
  db.prepare('SELECT * FROM transactions WHERE description = ?').get(d) as Record<string, any>;
const catId = (db: ReturnType<typeof openDb>, name: string) =>
  (db.prepare('SELECT id FROM categories WHERE name = ?').get(name) as { id: number }).id;

test('parseCents', () => {
  assert.equal(parseCents('-12.34'), -1234);
  assert.equal(parseCents('2,500.00'), 250000);
  assert.equal(parseCents('12,5'), 1250);
  assert.equal(parseCents('-0.00'), 0);
  assert.equal(parseCents('3'), 300);
  assert.equal(parseCents('1.005'), 101);
});

test('merchant normalization', () => {
  assert.equal(normalizeMerchant('SumUp *Coffee Lab 0231').name, 'Coffee Lab');
  assert.equal(normalizeMerchant('Albert Heijn 1234').name, 'Albert Heijn');
  assert.equal(normalizeMerchant('Uber *Trip Help.Uber.Com').name, 'Uber Trip');
  assert.equal(normalizeMerchant('Uber *Eats').name, 'Uber Eats');
  assert.equal(normalizeMerchant('Amzn Mktp *2K4L19XQ5').name, 'Amzn Mktp');
  assert.equal(normalizeMerchant('Bol.com').key, 'bol com');
  assert.equal(normalizeMerchant('Bck*kobis Grill').name, 'kobis Grill');
  assert.equal(normalizeMerchant('Zettle_*Koffie En Zo').name, 'Koffie En Zo');
  assert.equal(normalizeMerchant('Https://www.ns.nl/').key, 'ns nl');
  assert.equal(splitMerchant('For Too Good To Go To JOHN DOE'), 'Too Good To Go');
  assert.equal(splitMerchant('For To Regionale Belasting Groep From JOHN DOE'), 'Regionale Belasting Groep');
  assert.equal(splitMerchant('Rent for October To JOHN DOE'), null);
  assert.equal(extractCounterparty('TRANSFER', 'Transfer from JOHN DOE'), 'John Doe');
  assert.equal(extractCounterparty('CARD_PAYMENT', 'Transfer from JOHN DOE'), null);
});

test('import is idempotent and refreshes pending rows', () => {
  const db = freshDb();
  const again = importTransactions(db, parseRevolutCsv(csv));
  assert.equal(again.added, 0);
  const completed = csv.replace(',,Uber *Trip Help.Uber.Com,-14.20,0.00,EUR,PENDING,', ',2026-02-13 08:00:00,Uber *Trip Help.Uber.Com,-14.20,0.00,EUR,COMPLETED,1501.91');
  const third = importTransactions(db, parseRevolutCsv(completed));
  assert.deepEqual([third.added, third.updated], [0, 1]);
  assert.equal(byDesc(db, 'Uber *Trip Help.Uber.Com').state, 'COMPLETED');
});

test('noise is classified as internal / excluded', () => {
  const db = freshDb();
  assert.equal(byDesc(db, 'Spare change').kind, 'internal');
  assert.equal(byDesc(db, 'To EUR Round Up').kind, 'internal');
  assert.equal(byDesc(db, 'To EUR Savings').kind, 'internal');
  assert.equal(byDesc(db, 'From EUR Current').kind, 'internal'); // Savings product row
  assert.equal(byDesc(db, 'Exchanged to USD').kind, 'internal');
  assert.equal(byDesc(db, 'Bol.com').kind, 'excluded');
  assert.equal(byDesc(db, 'Albert Heijn 1234').kind, 'spend');
  assert.equal(byDesc(db, 'Zalando').kind, 'spend'); // refund reduces spending
  assert.equal(byDesc(db, 'Payment from ACME BV').kind, 'income');
});

test('merchant rule labels all visits; manual override wins', () => {
  const db = freshDb();
  const groceries = catId(db, 'Groceries');
  upsertMerchantRule(db, 'albert heijn', 'Albert Heijn', groceries, null);
  reclassifyAll(db);
  assert.equal(byDesc(db, 'Albert Heijn 1234').category_id, groceries);
  const other = catId(db, 'Other');
  db.prepare("UPDATE transactions SET category_id = ?, category_source = 'manual' WHERE description = 'Albert Heijn 1234'").run(other);
  reclassifyAll(db);
  assert.equal(byDesc(db, 'Albert Heijn 1234').category_id, other);
});

test('roommate half is suggested, linked, and nets spending', () => {
  const db = freshDb();
  const groceries = catId(db, 'Groceries');
  upsertMerchantRule(db, 'albert heijn', 'Albert Heijn', groceries, null);
  reclassifyAll(db);
  const incoming = byDesc(db, 'Transfer from JOHN DOE');
  const ah = byDesc(db, 'Albert Heijn 1234');
  const s = suggestSplits(db);
  assert.equal(s[0]?.incomingId, incoming.id);
  assert.deepEqual(s[0]?.expenseIds, [ah.id]);
  assert.equal(s[0]?.fraction, 0.5);

  linkReimbursement(db, incoming.id, [ah.id]);
  assert.equal(byDesc(db, 'Transfer from JOHN DOE').kind, 'reimbursement');
  const feb = monthlyReport(db).find((m) => m.month === '2026-02')!;
  assert.equal(feb.byCategory[String(groceries)], 3000);
  assert.equal(feb.income, 0);
  // 30 groceries + 3.50 coffee + 549.99 PS5 + 14.20 uber - 19.99 refund
  assert.equal(feb.spending, 3000 + 350 + 54999 + 1420 - 1999);
  assert.equal(feb.savedInternally, 50000 + 40 + 10000);
});

test('labeled income is never suggested as a payback', () => {
  const db = freshDb();
  const incoming = byDesc(db, 'Transfer from JOHN DOE');
  db.prepare('UPDATE transactions SET category_id = ? WHERE id = ?').run(catId(db, 'Other income'), incoming.id);
  assert.equal(suggestSplits(db).length, 0);
});
