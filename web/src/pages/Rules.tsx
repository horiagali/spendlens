import { useEffect, useState } from 'react';
import { api, KINDS, money, type Condition, type ConditionField, type Kind, type Rule, type Txn } from '../api.ts';
import type { AppData } from '../App.tsx';
import { CategorySelect } from '../components/CategorySelect.tsx';

const FIELDS: ConditionField[] = ['merchant', 'description', 'counterparty', 'type', 'account', 'direction', 'amount', 'state', 'currency', 'merchantKey'];
const TEXT_OPS = ['contains', 'equals', 'startsWith', 'regex'];
const NUM_OPS = ['gt', 'gte', 'lt', 'lte', 'equals'];
const OP_LABEL: Record<string, string> = { contains: 'contains', equals: 'is', startsWith: 'starts with', regex: 'matches regex', gt: '>', gte: '≥', lt: '<', lte: '≤' };

function describe(c: Condition) {
  const v = c.field === 'amount' ? money(Number(c.value)) : `"${c.value}"`;
  return `${c.field} ${OP_LABEL[c.op] ?? c.op} ${v}`;
}

export function Rules({ categories, refresh }: AppData) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [filter, setFilter] = useState('');
  const load = () => api.rules().then(setRules);
  useEffect(() => { load(); }, []);
  const act = async (p: Promise<unknown>) => { await p; await Promise.all([load(), refresh()]); };
  const catName = (id: number | null) => categories.find((c) => c.id === id)?.name;

  const shown = rules.filter((r) => !filter || r.name.toLowerCase().includes(filter.toLowerCase()) || r.conditions.some((c) => String(c.value).toLowerCase().includes(filter.toLowerCase())));
  return (
    <>
      <h1>Rules</h1>
      <p className="sub">Rules run in priority order (lowest first). The first rule that sets a kind wins, and so does the first that sets a category. Changes you make by hand on a transaction always win over rules.</p>
      <RuleEditor categories={categories} onSave={(r) => act(api.addRule(r))} />
      <div className="card" style={{ padding: 0 }}>
        <div className="row" style={{ padding: '12px 14px' }}>
          <input type="search" placeholder="Filter rules…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <span className="muted small">{rules.length} rules</span>
        </div>
        <table>
          <thead><tr><th>On</th><th>Prio</th><th>Rule</th><th>When</th><th>Then</th><th className="num">Matches</th><th></th></tr></thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} className={r.enabled ? '' : 'dim'}>
                <td><input type="checkbox" checked={r.enabled} onChange={(e) => act(api.updateRule(r.id, { enabled: e.target.checked }))} /></td>
                <td className="small">{r.priority}</td>
                <td>{r.name} {r.system && <span className="pill">built-in</span>}</td>
                <td className="small">{r.conditions.map(describe).join(' and ')}</td>
                <td className="small">{[r.setKind && `kind: ${r.setKind}`, r.setCategoryId && catName(r.setCategoryId)].filter(Boolean).join(', ')}</td>
                <td className="num">{r.matchCount}</td>
                <td><button className="ghost small" onClick={() => confirm(`Delete rule "${r.name}"?`) && act(api.deleteRule(r.id))}>Delete</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function RuleEditor({ categories, onSave }: { categories: AppData['categories']; onSave: (r: Partial<Rule>) => Promise<void> }) {
  const empty: Condition = { field: 'description', op: 'contains', value: '' };
  const [conds, setConds] = useState<Condition[]>([empty]);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Kind | ''>('');
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [priority, setPriority] = useState(50);
  const [preview, setPreview] = useState<{ count: number; sample: Txn[] } | null>(null);

  const valid = conds.every((c) => String(c.value).trim() !== '') && (kind || categoryId);
  useEffect(() => {
    if (!conds.every((c) => String(c.value).trim() !== '')) { setPreview(null); return; }
    const t = setTimeout(() => api.previewRule(conds).then(setPreview).catch(() => setPreview(null)), 250);
    return () => clearTimeout(t);
  }, [conds]);

  const setCond = (i: number, patch: Partial<Condition>) => setConds((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  return (
    <div className="card">
      <h2>New rule</h2>
      {conds.map((c, i) => (
        <div key={i} className="row" style={{ marginBottom: 6 }}>
          <span className="muted small" style={{ width: 36 }}>{i === 0 ? 'When' : 'and'}</span>
          <select value={c.field} onChange={(e) => {
            const field = e.target.value as ConditionField;
            setCond(i, { field, op: field === 'amount' ? 'gt' : field === 'direction' ? 'equals' : 'contains', value: field === 'direction' ? 'in' : '' });
          }}>
            {FIELDS.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
          {c.field === 'direction' ? (
            <select value={String(c.value)} onChange={(e) => setCond(i, { value: e.target.value })}>
              <option value="in">money in</option><option value="out">money out</option>
            </select>
          ) : (
            <>
              <select value={c.op} onChange={(e) => setCond(i, { op: e.target.value })}>
                {(c.field === 'amount' ? NUM_OPS : TEXT_OPS).map((o) => <option key={o} value={o}>{OP_LABEL[o]}</option>)}
              </select>
              {c.field === 'amount'
                ? <input type="number" step="0.01" placeholder="€" value={c.value === '' ? '' : Number(c.value) / 100}
                    onChange={(e) => setCond(i, { value: e.target.value === '' ? '' : Math.round(Number(e.target.value) * 100) })} />
                : <input type="text" value={String(c.value)} onChange={(e) => setCond(i, { value: e.target.value })} />}
            </>
          )}
          {conds.length > 1 && <button className="ghost" onClick={() => setConds(conds.filter((_, j) => j !== i))}>✕</button>}
        </div>
      ))}
      <button className="ghost small" onClick={() => setConds([...conds, empty])}>+ condition</button>
      <div className="row" style={{ marginTop: 10 }}>
        <span className="muted small" style={{ width: 36 }}>Then</span>
        <select value={kind} onChange={(e) => setKind(e.target.value as Kind | '')}>
          <option value="">keep kind</option>
          {KINDS.map((k) => <option key={k} value={k}>kind: {k}</option>)}
        </select>
        <CategorySelect categories={categories} value={categoryId} onChange={setCategoryId} placeholder="keep category" />
        <input type="text" placeholder="Rule name" value={name} onChange={(e) => setName(e.target.value)} />
        <label className="small muted">Priority <input type="number" style={{ width: 64 }} value={priority} onChange={(e) => setPriority(Number(e.target.value))} /></label>
        <div className="spacer" />
        <button className="primary" disabled={!valid} onClick={async () => {
          await onSave({ name: name || conds.map(describe).join(' and '), conditions: conds, setKind: kind || null, setCategoryId: categoryId, priority });
          setConds([empty]); setName(''); setKind(''); setCategoryId(null);
        }}>Add rule</button>
      </div>
      {preview && (
        <div style={{ marginTop: 10 }}>
          <span className="small">Matches <b>{preview.count}</b> transactions</span>
          <div className="muted small">{preview.sample.slice(0, 8).map((t) => `${t.date} ${t.description} (${money(t.amount, t.currency)})`).join(' · ')}</div>
        </div>
      )}
    </div>
  );
}
