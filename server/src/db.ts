import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const MIGRATIONS: string[] = [
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
];

export type DB = DatabaseSync;

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = version; v < MIGRATIONS.length; v++) {
    tx(db, () => {
      db.exec(MIGRATIONS[v]!);
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

const DEFAULT_CATEGORIES: [string, string, number][] = [
  ['Groceries', '#3a9e5f', 0],
  ['Eating out', '#e07a2e', 0],
  ['Going out', '#d4477a', 0],
  ['Transport', '#3b7dd8', 0],
  ['Rent & bills', '#6b5bd2', 0],
  ['Subscriptions', '#8a63b8', 0],
  ['Shopping', '#c9a227', 0],
  ['Electronics & games', '#2aa3a3', 0],
  ['Health', '#d0503c', 0],
  ['Travel', '#4f9bd9', 0],
  ['Gifts', '#b86b9e', 0],
  ['Cash', '#888888', 0],
  ['Other', '#9a9a9a', 0],
  ['Salary', '#2f8f4e', 1],
  ['Other income', '#6aa84f', 1],
];

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
    conditions: [{ field: 'description', op: 'regex', value: '\\b(savings?|vault|pockets?|pocket withdrawal|flexible cash funds|instant access)\\b' }] },
  // Revolut names vault transfers "To EUR <vault name>" / "From EUR <vault name>"; people never start with a currency code.
  { name: 'Transfers to/from named vaults ("To EUR Japan trip")', priority: 5, kind: 'internal',
    conditions: [{ field: 'description', op: 'regex', caseSensitive: true,
      value: '^(To|From) (EUR|USD|GBP|CHF|PLN|RON|CZK|HUF|SEK|NOK|DKK|BGN|AUD|CAD|JPY|TRY|ILS|NZD|SGD|HKD|MXN|ZAR|AED|INR|THB) \\S' }] },
];

function seed(db: DB) {
  tx(db, () => {
    const cat = db.prepare('INSERT INTO categories (name, color, is_income) VALUES (?, ?, ?)');
    for (const c of DEFAULT_CATEGORIES) cat.run(...c);
    const rule = db.prepare('INSERT INTO rules (name, priority, conditions, set_kind, system) VALUES (?, ?, ?, ?, 1)');
    for (const r of SYSTEM_RULES) rule.run(r.name, r.priority, JSON.stringify(r.conditions), r.kind);
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
