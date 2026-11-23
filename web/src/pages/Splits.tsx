import { useEffect, useState } from 'react';
import { api, money, type SplitLink, type SplitSuggestion, type Txn } from '../api.ts';
import type { AppData } from '../App.tsx';

const FRACTION_LABEL: Record<string, string> = { '0.5': 'half', '0.333': 'a third', '0.667': 'two thirds', '0.25': 'a quarter', '0.75': 'three quarters', '1': 'all' };
const fractionLabel = (f: number) => FRACTION_LABEL[String(Math.round(f * 1000) / 1000)] ?? `${Math.round(f * 100)}%`;

/** Incoming transfers that look like someone paying you back for a shared expense. */
export function Splits({ refresh, summary }: AppData) {
  const [sugg, setSugg] = useState<{ suggestions: SplitSuggestion[]; transactions: Record<string, Txn> } | null>(null);
  const [links, setLinks] = useState<SplitLink[]>([]);
  const currency = summary?.baseCurrency ?? 'EUR';

  const load = () => Promise.all([api.splitSuggestions().then(setSugg), api.splits().then(setLinks)]);
  useEffect(() => { load(); }, []);
  const act = async (p: Promise<unknown>) => { await p; await Promise.all([load(), refresh()]); };

  // Group suggestions by incoming payment; show the best one, with alternatives.
  const groups = new Map<string, SplitSuggestion[]>();
  for (const s of sugg?.suggestions ?? []) groups.set(s.incomingId, [...(groups.get(s.incomingId) ?? []), s]);
  const tx = (id: string) => sugg!.transactions[id]!;

  const byIncoming = new Map<string, SplitLink[]>();
  for (const l of links) byIncoming.set(l.incomingId, [...(byIncoming.get(l.incomingId) ?? []), l]);

  return (
    <>
      <h1>Splits</h1>
      <p className="sub">When someone pays you back for a shared bill, link the payment to the expense. Your spending then only counts your share.</p>
      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>Suggested matches</h2>
          <div className="spacer" />
          {groups.size > 1 && <button onClick={() => confirm(`Link the best match for all ${groups.size} payments?`) && act(api.acceptAll())}>Link all best matches</button>}
        </div>
        {groups.size === 0 && <p className="muted">No suggestions right now. Incoming transfers from people are matched against expenses from the 45 days before.</p>}
        {[...groups.entries()].map(([incomingId, options]) => (
          <SuggestionRow key={incomingId} incoming={tx(incomingId)} options={options} tx={tx} currency={currency}
            onLink={(s) => act(api.link(s.incomingId, s.expenseIds))}
            onDismiss={(s) => act(api.dismiss(s.incomingId, s.expenseIds))} />
        ))}
      </div>
      <div className="card">
        <h2>Linked</h2>
        {byIncoming.size === 0 ? <p className="muted">Nothing linked yet.</p> : (
          <table>
            <thead><tr><th>Paid back</th><th>For</th><th className="num">Your share</th><th></th></tr></thead>
            <tbody>
              {[...byIncoming.entries()].map(([id, ls]) => (
                <tr key={id}>
                  <td>{ls[0]!.counterparty} <span className="pos">{money(ls[0]!.incomingAmount, currency)}</span><div className="muted small">{ls[0]!.incomingDate}</div></td>
                  <td>{ls.map((l) => <div key={l.expenseId}>{l.expenseMerchant} <span className="muted small">{l.expenseDate} · {money(l.expenseAmount, currency)}</span></div>)}</td>
                  <td className="num">{ls.map((l) => <div key={l.expenseId}>{money(-l.expenseAmount - l.amount, currency)}</div>)}</td>
                  <td><button className="ghost small" onClick={() => act(api.unlink(id))}>Unlink</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function SuggestionRow({ incoming, options, tx, currency, onLink, onDismiss }: {
  incoming: Txn; options: SplitSuggestion[]; tx: (id: string) => Txn; currency: string;
  onLink: (s: SplitSuggestion) => void; onDismiss: (s: SplitSuggestion) => void;
}) {
  const [i, setI] = useState(0);
  const s = options[i]!;
  const expenses = s.expenseIds.map(tx);
  return (
    <div className="split-card">
      <div>
        <b>{incoming.counterparty}</b> sent you <b className="pos">{money(incoming.amount, currency)}</b>
        <div className="muted small">{incoming.date} · {incoming.description}</div>
      </div>
      <div className="muted small">≈ {fractionLabel(s.fraction)} of →</div>
      <div>
        {expenses.map((e) => <div key={e.id}>{e.merchant} <b>{money(e.amount, currency)}</b> <span className="muted small">{e.date}</span></div>)}
        {options.length > 1 && <button className="ghost small" onClick={() => setI((i + 1) % options.length)}>Other match ({i + 1}/{options.length})</button>}
      </div>
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <button className="primary" onClick={() => onLink(s)}>Link</button>
        <button className="ghost" onClick={() => onDismiss(s)}>Not this</button>
      </div>
    </div>
  );
}
