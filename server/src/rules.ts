import type { DB } from './db.ts';
import type { Kind } from './types.ts';

export type ConditionField =
  | 'merchant' | 'merchantKey' | 'description' | 'reference' | 'counterparty'
  | 'type' | 'account' | 'state' | 'currency' | 'direction' | 'amount';
export type ConditionOp = 'equals' | 'contains' | 'startsWith' | 'regex' | 'lt' | 'lte' | 'gt' | 'gte';

export interface Condition {
  field: ConditionField;
  op: ConditionOp;
  /** Strings match case-insensitively. For `amount`, a number in cents compared against the absolute amount. */
  value: string | number;
  /** Make text comparisons case-sensitive. */
  caseSensitive?: boolean;
}

export interface Rule {
  id: number;
  name: string;
  priority: number;
  enabled: boolean;
  conditions: Condition[];
  setKind: Kind | null;
  setCategoryId: number | null;
  system: boolean;
}

/** The fields of a transaction that rules can look at. */
export interface RuleSubject {
  merchant: string;
  merchantKey: string;
  description: string;
  reference: string;
  counterparty: string | null;
  type: string;
  account: string;
  state: string;
  currency: string;
  amount: number;
}

const REFUND_TYPES = /REFUND|CHARGEBACK|CASHBACK|REWARD/;

export function defaultKind(t: RuleSubject): Kind {
  if (t.amount === 0) return 'excluded';
  if (t.amount < 0) return 'spend';
  return REFUND_TYPES.test(t.type) ? 'spend' : 'income';
}

const regexCache = new Map<string, RegExp | null>();
function compile(pattern: string, caseSensitive = false): RegExp | null {
  const key = (caseSensitive ? 'c:' : 'i:') + pattern;
  if (!regexCache.has(key)) {
    try { regexCache.set(key, new RegExp(pattern, caseSensitive ? 'u' : 'iu')); }
    catch { regexCache.set(key, null); }
  }
  return regexCache.get(key)!;
}

export function matchesCondition(t: RuleSubject, c: Condition): boolean {
  if (c.field === 'amount') {
    const a = Math.abs(t.amount);
    const v = Number(c.value);
    switch (c.op) {
      case 'lt': return a < v;
      case 'lte': return a <= v;
      case 'gt': return a > v;
      case 'gte': return a >= v;
      case 'equals': return a === v;
      default: return false;
    }
  }
  const actual = c.field === 'direction' ? (t.amount < 0 ? 'out' : 'in') : (t[c.field] ?? '');
  const a = c.caseSensitive ? String(actual) : String(actual).toLowerCase();
  const v = c.caseSensitive ? String(c.value) : String(c.value).toLowerCase();
  switch (c.op) {
    case 'equals': return a === v;
    case 'contains': return a.includes(v);
    case 'startsWith': return a.startsWith(v);
    case 'regex': return compile(String(c.value), c.caseSensitive)?.test(String(actual)) ?? false;
    default: return false;
  }
}

export function matchesRule(t: RuleSubject, r: Rule): boolean {
  return r.enabled && r.conditions.length > 0 && r.conditions.every((c) => matchesCondition(t, c));
}

export interface Classification {
  kind: Kind;
  kindFromRule: boolean;
  categoryId: number | null;
  ruleId: number | null;
}

/**
 * Run rules in priority order. The first rule that sets a kind decides the kind, the first
 * rule that sets a category decides the category. Internal/excluded transactions get no category.
 */
export function classify(t: RuleSubject, rules: Rule[]): Classification {
  let kind: Kind | null = null;
  let categoryId: number | null = null;
  let ruleId: number | null = null;
  for (const r of rules) {
    if ((kind !== null || !r.setKind) && (categoryId !== null || !r.setCategoryId)) continue;
    if (!matchesRule(t, r)) continue;
    if (kind === null && r.setKind) { kind = r.setKind; ruleId ??= r.id; }
    if (categoryId === null && r.setCategoryId) { categoryId = r.setCategoryId; ruleId ??= r.id; }
    if (kind === 'internal' || kind === 'excluded') break;
    if (kind !== null && categoryId !== null) break;
  }
  const finalKind = kind ?? defaultKind(t);
  return {
    kind: finalKind,
    kindFromRule: kind !== null,
    categoryId: finalKind === 'internal' || finalKind === 'excluded' ? null : categoryId,
    ruleId,
  };
}

interface RuleRow {
  id: number; name: string; priority: number; enabled: number; conditions: string;
  set_kind: string | null; set_category_id: number | null; system: number;
}

export function loadRules(db: DB): Rule[] {
  const rows = db.prepare('SELECT * FROM rules ORDER BY priority, id').all() as unknown as RuleRow[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    priority: r.priority,
    enabled: !!r.enabled,
    conditions: JSON.parse(r.conditions) as Condition[],
    setKind: r.set_kind as Kind | null,
    setCategoryId: r.set_category_id,
    system: !!r.system,
  }));
}

/**
 * Recompute kind/category for every transaction, respecting manual overrides and
 * reimbursement links. Cheap enough to run on every rule change (thousands of rows).
 */
export function reclassifyAll(db: DB): { changed: number } {
  const rules = loadRules(db);
  const incomeCategories = new Set(
    (db.prepare('SELECT id FROM categories WHERE is_income = 1').all() as { id: number }[]).map((c) => c.id),
  );
  const reimbursed = new Set(
    (db.prepare('SELECT DISTINCT incoming_id FROM reimbursements').all() as { incoming_id: string }[]).map((r) => r.incoming_id),
  );
  const rows = db.prepare(`SELECT id, merchant, merchant_key, description, reference, counterparty, type, account, state, currency, amount,
      kind, kind_source, category_id, category_source, rule_id FROM transactions`).all() as Record<string, any>[];
  const update = db.prepare(`UPDATE transactions SET kind = ?, kind_source = ?, category_id = ?, category_source = ?, rule_id = ? WHERE id = ?`);
  let changed = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const c = classify({
        merchant: r.merchant, merchantKey: r.merchant_key, description: r.description, reference: r.reference, counterparty: r.counterparty,
        type: r.type, account: r.account, state: r.state, currency: r.currency, amount: r.amount,
      }, rules);
      let kind: Kind = c.kind;
      let kindSource = c.kindFromRule ? 'rule' : 'auto';
      // Money back from a merchant you labeled with a spending category is a refund, not income.
      if (!c.kindFromRule && kind === 'income' && c.categoryId !== null && !incomeCategories.has(c.categoryId)) kind = 'spend';
      if (r.kind_source === 'manual') { kind = r.kind; kindSource = 'manual'; }
      else if (reimbursed.has(r.id) && kind === 'income') { kind = 'reimbursement'; kindSource = 'auto'; }
      let categoryId = c.categoryId;
      let categorySource: string | null = categoryId !== null ? 'rule' : null;
      if (r.category_source === 'manual') { categoryId = r.category_id; categorySource = 'manual'; }
      // A payback keeps an income category (e.g. "Parents"): whatever it does not cover counts as that income.
      const keepIncomeCategory = kind === 'reimbursement' && categoryId !== null && incomeCategories.has(categoryId);
      if ((kind === 'internal' || kind === 'excluded' || kind === 'reimbursement') && !keepIncomeCategory) {
        if (categorySource !== 'manual') { categoryId = null; categorySource = null; }
      }
      const ruleId = categorySource === 'rule' || kindSource === 'rule' ? c.ruleId : null;
      if (kind !== r.kind || kindSource !== r.kind_source || categoryId !== r.category_id || categorySource !== r.category_source || ruleId !== r.rule_id) {
        update.run(kind, kindSource, categoryId, categorySource, ruleId, r.id);
        changed++;
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { changed };
}

/** "Always label this merchant as X": creates or updates a single-condition merchant rule. */
export function upsertMerchantRule(db: DB, merchantKey: string, merchantName: string, categoryId: number | null, kind: Kind | null): number {
  const existing = loadRules(db).find(
    (r) => !r.system && r.conditions.length === 1 && r.conditions[0]!.field === 'merchantKey' && r.conditions[0]!.op === 'equals'
      && String(r.conditions[0]!.value) === merchantKey,
  );
  if (existing) {
    db.prepare('UPDATE rules SET set_category_id = ?, set_kind = ? WHERE id = ?').run(categoryId, kind, existing.id);
    return existing.id;
  }
  const res = db.prepare('INSERT INTO rules (name, priority, conditions, set_kind, set_category_id) VALUES (?, 100, ?, ?, ?)')
    .run(merchantName, JSON.stringify([{ field: 'merchantKey', op: 'equals', value: merchantKey }]), kind, categoryId);
  return Number(res.lastInsertRowid);
}
