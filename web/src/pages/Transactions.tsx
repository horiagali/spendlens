import { useEffect, useState } from 'react';
import { api, KINDS, money, type Kind, type Txn } from '../api.ts';
import type { AppData } from '../App.tsx';
import { CategorySelect } from '../components/CategorySelect.tsx';

const PAGE = 100;

export function Transactions({ categories, refresh, summary, query }: AppData & { query: URLSearchParams }) {
  const [filters, setFilters] = useState(() => ({
    month: query.get('month') ?? '', kind: query.get('kind') ?? '', category: query.get('category') ?? '',
    q: query.get('q') ?? '', merchantKey: query.get('merchantKey') ?? '', from: query.get('from') ?? '',
  }));
  const [page, setPage] = useState(0);
  const [data, setData] = useState<{ total: number; items: Txn[] } | null>(null);
  const currency = summary?.baseCurrency ?? 'EUR';
  const catName = (id: number | null) => categories.find((c) => c.id === id)?.name;

  const load = () => api.transactions({ ...filters, limit: PAGE, offset: page * PAGE }).then(setData);
  useEffect(() => { load(); }, [filters, page]);
  const set = (k: keyof typeof filters, v: string) => { setPage(0); setFilters((f) => ({ ...f, [k]: v })); };

  const update = async (t: Txn, patch: Parameters<typeof api.updateTxn>[1]) => {
    const next = await api.updateTxn(t.id, patch);
    setData((d) => d && { ...d, items: d.items.map((x) => (x.id === t.id ? next : x)) });
    refresh();
  };
  const months = (summary?.months ?? []).map((m) => m.month).reverse();

  return (
    <>
      <h1>Transactions</h1>
      <div className="row" style={{ margin: '12px 0 16px' }}>
        <input type="search" placeholder="Search…" value={filters.q} onChange={(e) => set('q', e.target.value)} />
        <select value={filters.month} onChange={(e) => set('month', e.target.value)}>
          <option value="">All months</option>
          {months.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select value={filters.kind} onChange={(e) => set('kind', e.target.value)}>
          <option value="">All kinds</option>
          {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <select value={filters.category} onChange={(e) => set('category', e.target.value)}>
          <option value="">All categories</option>
          <option value="none">Uncategorized</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {filters.from && <button onClick={() => set('from', '')}>Since {filters.from} ✕</button>}
        {filters.merchantKey && <button onClick={() => set('merchantKey', '')}>Merchant: {filters.merchantKey} ✕</button>}
        <div className="spacer" />
        <span className="muted small">{data?.total ?? 0} transactions</span>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>Date</th><th>Description</th><th className="num">Amount</th><th>Kind</th><th>Category</th><th title="One-off purchase">1×</th></tr></thead>
          <tbody>
            {data?.items.map((t) => {
              const dim = t.kind === 'internal' || t.kind === 'excluded';
              return (
                <tr key={t.id} className={dim ? 'dim' : ''}>
                  <td className="small" style={{ whiteSpace: 'nowrap' }}>{t.date}</td>
                  <td>
                    {t.merchant}
                    <div className="muted small">
                      {t.description !== t.merchant && <>{t.description} · </>}{t.type.toLowerCase().replace(/_/g, ' ')}
                      {t.account !== 'Current' && <> · {t.account}</>}
                      {t.state !== 'COMPLETED' && <> · {t.state.toLowerCase()}</>}
                    </div>
                  </td>
                  <td className={`num ${t.amount > 0 ? 'pos' : ''}`}>
                    {money(t.amount, t.currency)}
                    {t.fee > 0 && <div className="muted small">fee {money(t.fee, t.currency)}</div>}
                    {t.reimbursed > 0 && <div className="small pos">−{money(t.reimbursed, currency)} paid back</div>}
                  </td>
                  <td>
                    <select value={t.kind} onChange={(e) => update(t, { kind: e.target.value as Kind })}
                      title={t.kindSource === 'manual' ? 'Set by you' : t.kindSource === 'rule' ? 'Set by a rule' : 'Automatic'}
                      style={{ borderStyle: t.kindSource === 'manual' ? 'dashed' : undefined }}>
                      {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                    </select>
                    {t.kindSource === 'manual' && <button className="ghost small" title="Back to automatic" onClick={() => update(t, { kind: null })}>↺</button>}
                  </td>
                  <td>
                    {t.kind === 'spend' || t.kind === 'income' ? (
                      <CategorySelect categories={categories} value={t.categoryId} income={t.kind === 'income'} placeholder="—"
                        onChange={(id) => update(t, { categoryId: id })} />
                    ) : <span className="muted small">{catName(t.categoryId) ?? ''}</span>}
                  </td>
                  <td>{t.kind === 'spend' && t.amount < 0 && (
                    <input type="checkbox" checked={!!t.oneOff} onChange={(e) => update(t, { oneOff: e.target.checked })} title="One-off purchase" />
                  )}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {data && data.total > PAGE && (
        <div className="row">
          <button disabled={page === 0} onClick={() => setPage(page - 1)}>← Newer</button>
          <span className="muted small">Page {page + 1} of {Math.ceil(data.total / PAGE)}</span>
          <button disabled={(page + 1) * PAGE >= data.total} onClick={() => setPage(page + 1)}>Older →</button>
        </div>
      )}
    </>
  );
}
