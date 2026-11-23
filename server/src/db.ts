import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { STARTER_RULES } from './starterRules.ts';
import type { Bucket } from './types.ts';

const MIGRATIONS: (string | ((db: DB) => void))[] = [
  `
  CREATE TABLE categories (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    color TEXT,
    is_income INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE rules (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 100, -- lower runs first; first match per field wins
    enabled INTEGER NOT NULL DEFAULT 1,
    conditions TEXT NOT NULL, -- JSON Condition[] (AND)
    set_kind TEXT,
    set_category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    system INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE transactions (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    account TEXT NOT NULL,
    type TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    date TEXT NOT NULL,
    description TEXT NOT NULL,
    merchant TEXT NOT NULL,
    merchant_key TEXT NOT NULL,
    counterparty TEXT,
    amount INTEGER NOT NULL,
    fee INTEGER NOT NULL DEFAULT 0,
    currency TEXT NOT NULL,
    state TEXT NOT NULL,
    balance INTEGER,
    raw TEXT NOT NULL,
    kind TEXT NOT NULL,
    kind_source TEXT NOT NULL DEFAULT 'auto',
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    category_source TEXT,
    rule_id INTEGER REFERENCES rules(id) ON DELETE SET NULL,
    one_off INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    imported_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX tx_date ON transactions(date);
  CREATE INDEX tx_merchant ON transactions(merchant_key);

  -- An incoming payment (e.g. roommate's half) allocated against one or more expenses.
  CREATE TABLE reimbursements (
    id INTEGER PRIMARY KEY,
    incoming_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    expense_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL, -- cents allocated, positive
    UNIQUE (incoming_id, expense_id)
  );

  -- Suggestions the user rejected, so they are not proposed again.
  CREATE TABLE dismissed_suggestions (
    incoming_id TEXT NOT NULL,
    expense_ids TEXT NOT NULL,
    PRIMARY KEY (incoming_id, expense_ids)
  );

  -- The same real-world transaction seen by another source (CSV export vs bank sync) under a different id.
  CREATE TABLE txn_aliases (
    alias_id TEXT PRIMARY KEY,
    txn_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE
  );

  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE imports (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    label TEXT,
    added INTEGER NOT NULL,
    updated INTEGER NOT NULL,
    at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  (db) => {
    db.exec(`ALTER TABLE transactions ADD COLUMN reference TEXT NOT NULL DEFAULT '';
      UPDATE transactions SET reference = COALESCE(json_extract(raw, '$.remittance'), json_extract(raw, '$.Reference'), '');
      ALTER TABLE categories ADD COLUMN bucket TEXT NOT NULL DEFAULT 'lifestyle';`);
    // Databases created before buckets existed: keep their categories, add what is new.
    if ((db.prepare('SELECT COUNT(*) AS n FROM categories').get() as { n: number }).n === 0) return;
    db.exec(`UPDATE categories SET bucket = 'fixed' WHERE name IN ('Rent & bills', 'Rent', 'Bills & insurance')`);
    insertCategories(db, DEFAULT_CATEGORIES.filter(([name]) => !name.startsWith('Rent') && !name.startsWith('Bills')));
    upsertSystemRules(db);
  },
  // Set once you have looked at a transaction on the Review page (or changed it by hand).
  `ALTER TABLE transactions ADD COLUMN reviewed INTEGER NOT NULL DEFAULT 0;`,
];

export type DB = DatabaseSync;

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = version; v < MIGRATIONS.length; v++) {
    tx(db, () => {
      const m = MIGRATIONS[v]!;
      if (typeof m === 'string') db.exec(m); else m(db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
  if (version === 0) seed(db);
  return db;
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const DEFAULT_CATEGORIES: [name: string, color: string, isIncome: number, bucket: Bucket][] = [
  ['Groceries', '#3a9e5f', 0, 'lifestyle'],
  ['Eating out', '#e07a2e', 0, 'lifestyle'],
  ['Going out', '#d4477a', 0, 'lifestyle'],
  ['Transport', '#3b7dd8', 0, 'lifestyle'],
  ['Subscriptions', '#8a63b8', 0, 'lifestyle'],
  ['Shopping', '#c9a227', 0, 'lifestyle'],
  ['Electronics & games', '#2aa3a3', 0, 'lifestyle'],
  ['Health', '#d0503c', 0, 'lifestyle'],
  ['Sport', '#5aa02c', 0, 'lifestyle'],
  ['Travel', '#4f9bd9', 0, 'lifestyle'],
  ['Gifts', '#b86b9e', 0, 'lifestyle'],
  ['Friends & splits', '#c46a4f', 0, 'lifestyle'],
  ['Cash', '#888888', 0, 'lifestyle'],
  ['Other', '#9a9a9a', 0, 'lifestyle'],
  ['Rent', '#6b5bd2', 0, 'fixed'],
  ['Bills & insurance', '#5a6fa8', 0, 'fixed'],
  ['Tuition', '#7a4fa0', 0, 'separate'],
  ['Salary', '#2f8f4e', 1, 'lifestyle'],
  ['Benefits', '#4e9a6a', 1, 'lifestyle'],
  ['Other income', '#6aa84f', 1, 'lifestyle'],
];

function insertCategories(db: DB, cats: typeof DEFAULT_CATEGORIES) {
  const ins = db.prepare('INSERT OR IGNORE INTO categories (name, color, is_income, bucket) VALUES (?, ?, ?, ?)');
  for (const c of cats) ins.run(...c);
}

/**
 * System rules that strip Revolut noise before anything else. They are ordinary rules,
 * visible and editable in the UI, so they can be tuned once real data is in.
 */
const SYSTEM_RULES: { name: string; priority: number; conditions: unknown[]; kind: string }[] = [
  { name: 'Failed / reverted transactions', priority: 0, kind: 'excluded',
    conditions: [{ field: 'state', op: 'regex', value: '^(REVERTED|DECLINED|FAILED)$' }] },
  { name: 'Savings & other non-current accounts', priority: 1, kind: 'internal',
    conditions: [{ field: 'account', op: 'regex', value: '^(?!current$).+' }] },
  { name: 'Currency exchanges', priority: 2, kind: 'internal',
    conditions: [{ field: 'type', op: 'equals', value: 'EXCHANGE' }] },
  { name: 'Spare change / round-ups', priority: 3, kind: 'internal',
    conditions: [{ field: 'description', op: 'regex', value: 'round[ -]?ups?\\b|spare change' }] },
  { name: 'Transfers to/from savings, vaults & pockets', priority: 4, kind: 'internal',
    conditions: [{ field: 'description', op: 'regex', value: '\\b(savings?|vault|pockets?|pocket withdrawal|flexible (cash funds|account)|instant access)\\b' }] },
  // Revolut names vault transfers "To EUR <vault name>" / "From EUR <vault name>"; people never start with a currency code.
  { name: 'Transfers to/from named vaults ("To EUR Japan trip")', priority: 5, kind: 'internal',
    conditions: [{ field: 'description', op: 'regex', caseSensitive: true,
      value: '^(To|From) (EUR|USD|GBP|CHF|PLN|RON|CZK|HUF|SEK|NOK|DKK|BGN|AUD|CAD|JPY|TRY|ILS|NZD|SGD|HKD|MXN|ZAR|AED|INR|THB)( \\S|$)' }] },
  { name: 'Investing (brokers, investment account)', priority: 6, kind: 'internal',
    conditions: [{ field: 'description', op: 'regex',
      value: '\\b(investment account|ibkr|interactive brokers|etoro|degiro|trading ?212|trade republic|scalable capital|saxo bank)\\b' }] },
  // Paying someone's Revolut request shows "For <merchant> To <name>"; being paid back shows "For <merchant> From <name>".
  // The merchant is taken from the memo, so the payback lands in that merchant's category as a refund.
  { name: 'Paybacks for a split bill ("For Lidl From Alex")', priority: 7, kind: 'spend',
    conditions: [{ field: 'direction', op: 'equals', value: 'in' }, { field: 'reference', op: 'regex', value: '^For\\s.+\\sFrom\\s' }] },
];

/** Insert missing built-in rules and bring existing ones (matched by name) up to date. */
function upsertSystemRules(db: DB) {
  const find = db.prepare('SELECT id FROM rules WHERE system = 1 AND name = ?');
  const update = db.prepare('UPDATE rules SET conditions = ?, set_kind = ? WHERE id = ?');
  const insert = db.prepare('INSERT INTO rules (name, priority, conditions, set_kind, system) VALUES (?, ?, ?, ?, 1)');
  for (const r of SYSTEM_RULES) {
    const row = find.get(r.name) as { id: number } | undefined;
    if (row) update.run(JSON.stringify(r.conditions), r.kind, row.id);
    else insert.run(r.name, r.priority, JSON.stringify(r.conditions), r.kind);
  }
}

/** Labels for well-known chains, so the Label inbox starts with the long tail. Your own labels run first. */
function insertStarterRules(db: DB) {
  const catId = db.prepare('SELECT id FROM categories WHERE name = ?');
  const ins = db.prepare('INSERT INTO rules (name, priority, conditions, set_kind, set_category_id) VALUES (?, ?, ?, ?, ?)');
  for (const r of STARTER_RULES) {
    const cat = catId.get(r.category) as { id: number } | undefined;
    if (cat) ins.run(r.name, 150, JSON.stringify(r.conditions), r.kind ?? null, cat.id);
  }
}

function seed(db: DB) {
  tx(db, () => {
    insertCategories(db, DEFAULT_CATEGORIES);
    upsertSystemRules(db);
    insertStarterRules(db);
    db.prepare("INSERT INTO settings (key, value) VALUES ('base_currency', 'EUR')").run();
  });
}

export function getSetting(db: DB, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(db: DB, key: string, value: string | null) {
  if (value === null) db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
