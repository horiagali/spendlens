import { Fragment, useEffect, useState } from 'react';
import { api, BUCKET_LABEL, BUCKETS, monthLabel, moneyShort, money, type PeriodGroup, type PeriodItem, type PeriodReport } from '../api.ts';
import type { AppData } from '../App.tsx';
import { SyncButton } from '../components/SyncButton.tsx';

type SortBy = 'newest' | 'oldest' | 'biggest' | 'smallest';
const SORTS: [SortBy, string][] = [['newest', 'Newest first'], ['oldest', 'Oldest first'], ['biggest', 'Biggest first'], ['smallest', 'Smallest first']];
function sortItems<T extends { date: string; amount: number }>(items: T[], by: SortBy): T[] {
  const cmp: Record<SortBy, (a: T, b: T) => number> = {
    newest: (a, b) => b.date.localeCompare(a.date),
    oldest: (a, b) => a.date.localeCompare(b.date),
    biggest: (a, b) => b.amount - a.amount,
    smallest: (a, b) => a.amount - b.amount,
  };
  return [...items].sort(cmp[by]);
}
function SortSelect({ value, onChange }: { value: SortBy; onChange: (v: SortBy) => void }) {
  return (
    <select className="small" value={value} onChange={(e) => onChange(e.target.value as SortBy)} aria-label="Sort transactions"
      onClick={(e) => e.stopPropagation()}>
      {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}

/** How many months a period covers, counting partial first/last months by their share of days. */
function monthsCovered(from: string, to: string, months: string[]): number {
  const daysIn = (m: string) => new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0).getDate();
  return months.reduce((sum, m) => {
    const days = daysIn(m);
    const start = m === from.slice(0, 7) ? Number(from.slice(8, 10)) : 1;
    const end = m === to.slice(0, 7) ? Number(to.slice(8, 10)) : days;
    return sum + Math.max(0, end - start + 1) / days;
  }, 0);
}

/** "What came in, what went out, and what it went to" for a period, e.g. since the start of the academic year. */
export function Summary({ summary, navigate, refresh }: AppData) {
  const currency = summary?.baseCurrency ?? 'EUR';
  const [from, setFrom] = useState('');
  const [data, setData] = useState<PeriodReport | null>(null);
  const [open, setOpen] = useState<{ key: string; month: string | null } | null>(null);
  const [lineSort, setLineSort] = useState<SortBy>('newest');
  const [viewMonth, setViewMonth] = useState('');

  useEffect(() => { api.settings().then((s) => setFrom(s.period_start ?? `${new Date().getFullYear()}-01-01`)); }, []);
  useEffect(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return;
    api.saveSettings({ period_start: from });
    api.period(from).then(setData).catch(() => setData(null));
  }, [from, summary]);

  const m = (c: number) => moneyShort(c, currency);
  if (!data) return <h1>Summary</h1>;
  const covered = monthsCovered(data.from, data.to, data.months) || 1;
  const perMonth = (c: number) => c / covered;
  const lastMonth = data.months.at(-1) ?? '';
  const lastIsPartial = data.to.slice(0, 7) === lastMonth && monthsCovered(lastMonth + '-01', data.to, [lastMonth]) < 1;
  const colLabel = (mo: string, i: number) => `${monthLabel(mo)}${i === data.months.length - 1 && lastIsPartial ? ' (so far)' : ''}`;
  const left = data.income.total - data.spending.total;
  const lifestyleOneOff = data.spending.categories.filter((g) => g.bucket === 'lifestyle')
    .reduce((sum, g) => sum + g.items.reduce((s2, i) => s2 + (i.oneOff ? i.amount : 0), 0), 0);

  type Line = PeriodItem & { category: string };
  const linesOf = (groups: PeriodGroup[]): Line[] => groups.flatMap((g) => g.items.map((i) => ({ ...i, category: g.name })));
  const row = (label: string, byMonth: Record<string, number>, total: number, style: 'bold' | 'sub' | 'normal' = 'normal', lines?: Line[]) => {
    const isOpen = open?.key === label;
    const toggle = (month: string | null) => lines && setOpen(isOpen && open?.month === month ? null : { key: label, month });
    const shown = isOpen && lines ? lines.filter((l) => !open!.month || l.date.startsWith(open!.month)) : [];
    const sorted = sortItems(shown, lineSort);
    const cell = { cursor: lines ? 'pointer' : undefined };
    return (
      <Fragment key={label}>
        <tr style={{ fontWeight: style === 'bold' ? 600 : undefined }} className={lines ? 'clickable' : undefined}>
          <td style={{ ...cell, paddingLeft: style === 'sub' ? 20 : undefined }} onClick={() => toggle(null)}>
            {lines && <span className="muted">{isOpen ? '▾ ' : '▸ '}</span>}{label}
          </td>
          {data.months.map((mo) => (
            <td key={mo} className="num" style={{ ...cell, textDecoration: isOpen && open?.month === mo ? 'underline' : undefined }} onClick={() => toggle(mo)}>
              {byMonth[mo] ? m(byMonth[mo]) : '–'}
            </td>
          ))}
          <td className="num" style={cell} onClick={() => toggle(null)}>{m(total)}</td>
          <td className="num muted">{m(perMonth(total))}</td>
        </tr>
        {isOpen && (
          <tr>
            <td colSpan={data.months.length + 3} style={{ background: 'var(--surface-0)', padding: '6px 12px 10px 28px' }}>
              <div className="row small muted" style={{ marginBottom: 4 }}>
                <span>
                  {label} · {open!.month ? monthLabel(open!.month, 'long') : 'whole period'} · {shown.length} transactions ·{' '}
                  {m(shown.reduce((sum, l) => sum + l.amount, 0))}
                </span>
                <div className="spacer" />
                <SortSelect value={lineSort} onChange={setLineSort} />
              </div>
              <table>
                <tbody>
                  {sorted.map((l) => (
                    <tr key={l.id}>
                      <td className="small muted" style={{ width: 90 }}>{l.date}</td>
                      <td className="small">{l.merchant}{l.oneOff && <span className="pill" style={{ marginLeft: 6 }}>one-off</span>}
                        {l.part && <span className="pill" style={{ marginLeft: 6 }} title="Spread over several months">{l.part}</span>}</td>
                      <td className="small muted">{l.category}</td>
                      <td className="num small">{money(l.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </td>
          </tr>
        )}
      </Fragment>
    );
  };
  const bucketByMonth = (b: string) => {
    const out: Record<string, number> = {};
    for (const g of data.spending.categories.filter((c) => c.bucket === b)) for (const [k, v] of Object.entries(g.byMonth)) out[k] = (out[k] ?? 0) + v;
    return out;
  };
  const leftByMonth = Object.fromEntries(data.months.map((mo) => [mo, (data.income.byMonth[mo] ?? 0) - (data.spending.byMonth[mo] ?? 0)]));

  // "Where the money came from / went": the whole period or a single month.
  const inMonth = (groups: PeriodGroup[]) => !viewMonth ? groups : groups
    .map((g) => { const items = g.items.filter((i) => i.date.startsWith(viewMonth)); return { ...g, items, total: items.reduce((t, i) => t + i.amount, 0) }; })
    .filter((g) => g.items.some((i) => i.amount !== 0))
    .sort((a, b) => b.total - a.total);
  const sum = (groups: PeriodGroup[]) => groups.reduce((t, g) => t + g.total, 0);
  const inGroups = inMonth(data.income.sources);
  const outGroups = inMonth(data.spending.categories);
  const scope = viewMonth ? `month=${viewMonth}` : `from=${data.from}`;
  const monthPicker = (
    <select value={viewMonth} onChange={(e) => setViewMonth(e.target.value)} aria-label="Show month">
      <option value="">Whole period</option>
      {data.months.map((mo, i) => <option key={mo} value={mo}>{colLabel(mo, i)}</option>)}
    </select>
  );

  return (
    <>
      <div className="row" style={{ marginBottom: 16 }}>
        <div>
          <h1>Summary</h1>
          <p className="sub" style={{ margin: 0 }}>
            {data.from} → {data.to} · {covered.toFixed(1)} months. Averages are per month, partial months counted by their days.
          </p>
        </div>
        <div className="spacer" />
        <label className="small muted">Since&nbsp;<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <SyncButton lastDate={summary?.counts.lastDate ?? null} onSynced={refresh} />
      </div>

      <div className="tiles">
        <Tile label="Money in" value={m(data.income.total)} sub={`${m(perMonth(data.income.total))} / month`} />
        <Tile label="Money out" value={m(data.spending.total)} sub={`${m(perMonth(data.spending.total))} / month`} />
        <Tile label="Day-to-day spending" value={`${m(perMonth(data.spending.byBucket.lifestyle))} / mo`}
          sub={`${m(perMonth(data.spending.byBucket.lifestyle - lifestyleOneOff))} / mo without one-offs`} />
        <Tile label="Left over" value={m(left)} sub={`${m(perMonth(left))} / month`} />
      </div>

      <div className="card">
        <h2>Month by month</h2>
        <p className="muted small" style={{ marginTop: -6 }}>Click a row to see its transactions, or a month to see just that month.</p>
        <table>
          <thead><tr><th></th>{data.months.map((mo, i) => <th key={mo} className="num">{colLabel(mo, i)}</th>)}<th className="num">Total</th><th className="num">Per month</th></tr></thead>
          <tbody>
            {row('Money in', data.income.byMonth, data.income.total, 'bold', linesOf(data.income.sources))}
            {data.income.sources.map((g) => row(g.name, g.byMonth, g.total, 'sub', linesOf([g])))}
            {row('Money out', data.spending.byMonth, data.spending.total, 'bold', linesOf(data.spending.categories))}
            {BUCKETS.filter((b) => data.spending.byBucket[b]).map((b) => row(BUCKET_LABEL[b], bucketByMonth(b), data.spending.byBucket[b], 'sub',
              linesOf(data.spending.categories.filter((c) => c.bucket === b))))}
            {row('Left over', leftByMonth, left, 'bold')}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>Where the money came from</h2>
          <div className="spacer" />
          {monthPicker}
        </div>
        <Groups groups={inGroups} total={sum(inGroups)} m={m} perMonth={viewMonth ? undefined : perMonth}
          open={(g) => navigate(`transactions?${scope}&kind=income&category=${g.categoryId ?? 'none'}`)} />
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>Where it went</h2>
          <div className="spacer" />
          {monthPicker}
        </div>
        <p className="muted small" style={{ marginTop: 0 }}>Click a category to see what is behind it. Paybacks from friends and refunds are already subtracted.</p>
        {BUCKETS.filter((b) => outGroups.some((c) => c.bucket === b)).map((b) => {
          const groups = outGroups.filter((c) => c.bucket === b);
          return (
            <Fragment key={b}>
              <h3 className="small" style={{ margin: '14px 0 4px', color: 'var(--text-secondary)' }}>
                {BUCKET_LABEL[b].toUpperCase()} · {m(sum(groups))}{!viewMonth && ` · ${m(perMonth(sum(groups)))} / month`}
              </h3>
              <Groups groups={groups} total={sum(outGroups)} m={m} perMonth={viewMonth ? undefined : perMonth}
                open={(g) => navigate(`transactions?${scope}&kind=spend&category=${g.categoryId ?? 'none'}`)} />
            </Fragment>
          );
        })}
      </div>
    </>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return <div className="tile"><div className="label">{label}</div><div className="value">{value}</div><div className="delta">{sub}</div></div>;
}

function Groups({ groups, total, m, perMonth, open }: {
  groups: PeriodGroup[]; total: number; m: (c: number) => string; perMonth?: (c: number) => number; open: (g: PeriodGroup) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortBy>('biggest');
  const [showAll, setShowAll] = useState(false);
  const max = Math.max(...groups.map((g) => g.total), 1);
  return (
    <table>
      <tbody>
        {groups.map((g) => {
          const key = String(g.categoryId);
          const isOpen = expanded === key;
          const all = sortItems(g.items, sortBy);
          const items = showAll ? all : all.slice(0, 10);
          return (
            <Fragment key={key}>
              <tr style={{ cursor: 'pointer' }} onClick={() => { setExpanded(isOpen ? null : key); setShowAll(false); }}>
                <td style={{ width: 200 }}>{isOpen ? '▾' : '▸'} {g.name}</td>
                <td>
                  <div style={{ height: 10, borderRadius: 3, background: 'var(--series-1)', opacity: g.total > 0 ? 1 : 0.3,
                    width: `${Math.max(0, (g.total / max) * 100)}%` }} />
                </td>
                <td className="num" style={{ width: 90 }}>{m(g.total)}</td>
                {perMonth && <td className="num muted small" style={{ width: 90 }}>{m(perMonth(g.total))} / mo</td>}
                <td className="num muted small" style={{ width: 60 }}>{total > 0 ? `${Math.round((g.total / total) * 100)}%` : ''}</td>
                <td className="num muted small" style={{ width: 50 }}>{g.items.length}×</td>
              </tr>
              {isOpen && (
                <tr>
                  <td colSpan={6} style={{ background: 'var(--surface-0)', padding: '6px 12px 10px 28px' }}>
                    <div className="row" style={{ marginBottom: 4 }}><div className="spacer" /><SortSelect value={sortBy} onChange={setSortBy} /></div>
                    <table>
                      <tbody>
                        {items.map((i) => (
                          <tr key={i.id}>
                            <td className="small muted" style={{ width: 90 }}>{i.date}</td>
                            <td className="small">{i.merchant}{i.oneOff && <span className="pill" style={{ marginLeft: 6 }}>one-off</span>}
                            {i.part && <span className="pill" style={{ marginLeft: 6 }} title="Spread over several months">{i.part}</span>}</td>
                            <td className="num small">{money(i.amount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="row" style={{ marginTop: 6 }}>
                      {g.items.length > 10 && !showAll && <button className="ghost small" onClick={() => setShowAll(true)}>Show all {g.items.length}</button>}
                      <button className="ghost small" onClick={() => open(g)}>Open in Transactions →</button>
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
