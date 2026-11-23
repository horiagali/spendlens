import { useEffect, useState } from 'react';
import { api, money, type Kind, type ReviewItem } from '../api.ts';
import type { AppData } from '../App.tsx';
import { CategorySelect } from '../components/CategorySelect.tsx';

const KIND_LABEL: Record<Kind, string> = {
  spend: 'Spending / payback',
  income: 'Income',
  reimbursement: 'Reimbursement',
  internal: 'My own money moving',
  excluded: 'Ignore (not mine)',
};

/** Transactions the rules could not decide well, one place to sort them out by hand. */
export function Review({ categories, refresh, summary }: AppData) {
  const currency = summary?.baseCurrency ?? 'EUR';
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const load = () => api.review().then(setItems);
  useEffect(() => { load(); }, []);

  const update = async (t: ReviewItem, patch: Parameters<typeof api.updateTxn>[1], done = false) => {
    const next = await api.updateTxn(t.id, done ? { ...patch, reviewed: true } : patch);
    setItems((list) => list && (done || next.reviewed ? list.filter((x) => x.id !== t.id) : list.map((x) => (x.id === t.id ? { ...x, ...next } : x))));
    refresh();
  };
  const catName = (id: number | null) => categories.find((c) => c.id === id)?.name ?? 'no category';

  return (
    <>
      <h1>Review</h1>
      <p className="sub">
        Transactions since the start of your Summary period that rules can't judge well: big transfers with people, big payments
        without a category, odd income and big purchases. Fix the kind or category, or press <b>Looks right</b>. Either way it leaves this list.
      </p>
      {items?.length === 0 && <div className="card"><p className="muted" style={{ margin: 0 }}>Nothing to review. 🎉</p></div>}
      {items && items.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <table>
            <thead><tr><th>Date</th><th>Transaction</th><th className="num">Amount</th><th>Counted as</th><th>Category</th><th title="One-off purchase">1×</th><th></th></tr></thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id}>
                  <td className="small" style={{ whiteSpace: 'nowrap', verticalAlign: 'top' }}>{t.date}</td>
                  <td>
                    <div>{t.merchant}</div>
                    {t.reference && t.reference !== t.merchant && <div className="muted small">{t.reference.slice(0, 80)}</div>}
                    <div className="small" style={{ marginTop: 2 }}>{t.reasons.map((r) => <span key={r} className="pill" style={{ marginRight: 4 }}>{r}</span>)}</div>
                  </td>
                  <td className={`num ${t.amount > 0 ? 'pos' : 'neg'}`}>{money(t.amount, t.currency ?? currency)}</td>
                  <td>
                    <select value={t.kind} onChange={(e) => update(t, { kind: e.target.value as Kind }, true)} aria-label="Counted as">
                      {(Object.keys(KIND_LABEL) as Kind[]).filter((k) => k !== 'reimbursement').map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                    </select>
                  </td>
                  <td>
                    <CategorySelect categories={categories} value={t.categoryId} income={t.kind === 'income'} placeholder={catName(null)}
                      onChange={(id) => update(t, { categoryId: id }, true)} />
                  </td>
                  <td><input type="checkbox" checked={!!t.oneOff} onChange={(e) => update(t, { oneOff: e.target.checked })} aria-label="One-off" /></td>
                  <td><button className="small" onClick={() => update(t, {}, true)}>Looks right</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
