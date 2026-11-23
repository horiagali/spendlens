import { useEffect, useState } from 'react';
import { api, money, type InboxItem, type Kind } from '../api.ts';
import type { AppData } from '../App.tsx';
import { CategorySelect } from '../components/CategorySelect.tsx';

/**
 * Merchants that still need a category, most frequent first. Labeling a merchant creates a rule,
 * so every past and future transaction from it is labeled too.
 */
export function Inbox({ categories, refresh, summary, navigate }: AppData) {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const currency = summary?.baseCurrency ?? 'EUR';

  const load = () => api.inbox().then(setItems);
  useEffect(() => { load(); }, []);

  const label = async (it: InboxItem, b: { categoryId?: number | null; kind?: Kind | null }) => {
    setBusy(it.merchantKey + it.kind);
    try {
      await api.label({ merchantKey: it.merchantKey, merchant: it.merchant, ...b });
      await Promise.all([load(), refresh()]);
    } finally { setBusy(null); }
  };

  if (!items) return null;
  const txCount = items.reduce((s, i) => s + i.count, 0);
  return (
    <>
      <h1>Label merchants</h1>
      <p className="sub">
        {items.length === 0 ? 'Everything is labeled. 🎉' : `${items.length} merchants (${txCount} transactions) need a category. Labeling one labels all its transactions, now and in future imports.`}
      </p>
      {items.length > 0 && (
        <div className="card">
          <table>
            <thead><tr><th>Merchant</th><th className="num">Txns</th><th className="num">Total</th><th>Last</th><th>Category</th><th></th></tr></thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.merchantKey + it.kind} style={{ opacity: busy === it.merchantKey + it.kind ? 0.4 : 1 }}>
                  <td>
                    <a href={`#/transactions?merchantKey=${encodeURIComponent(it.merchantKey)}`} onClick={(e) => { e.preventDefault(); navigate(`transactions?merchantKey=${encodeURIComponent(it.merchantKey)}`); }}>
                      {it.merchant}
                    </a>
                    {it.sampleDescription !== it.merchant && <div className="muted small">{it.sampleDescription}</div>}
                    {it.kind === 'income' && <span className="pill">incoming</span>}
                  </td>
                  <td className="num">{it.count}</td>
                  <td className="num">{money(it.total, currency)}</td>
                  <td className="muted small">{it.lastDate}</td>
                  <td><CategorySelect categories={categories} value={null} income={it.kind === 'income'} onChange={(id) => id && label(it, { categoryId: id })} /></td>
                  <td className="row" style={{ flexWrap: 'nowrap' }}>
                    <button className="ghost small" title="Moving your own money (e.g. to another account of yours). Not counted." onClick={() => label(it, { kind: 'internal' })}>Internal</button>
                    <button className="ghost small" title="Ignore in all totals" onClick={() => label(it, { kind: 'excluded' })}>Exclude</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
