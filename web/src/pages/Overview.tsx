import { useEffect, useMemo, useState } from 'react';
import { api, money, monthLabel, moneyShort, type PeriodSummary } from '../api.ts';
import type { AppData } from '../App.tsx';
import { CategoryHeatmap, MonthBars } from '../components/charts.tsx';

const RANGES = [['6', '6 months'], ['12', '12 months'], ['24', '2 years'], ['all', 'All']] as const;

export function Overview({ summary, categories, navigate }: AppData) {
  const [range, setRange] = useState<string>('12');
  const currency = summary?.baseCurrency ?? 'EUR';
  const all = summary?.months ?? [];
  const months = range === 'all' ? all : all.slice(-Number(range));
  const [selected, setSelected] = useState<string | null>(null);
  const sel = all.find((m) => m.month === selected) ?? all.at(-1);
  const prev = sel ? all[all.indexOf(sel) - 1] : undefined;

  const catList = useMemo(() => [
    ...categories.filter((c) => !c.isIncome).map((c) => ({ id: String(c.id), name: c.name })),
    { id: 'uncategorized', name: 'Uncategorized' },
  ], [categories]);

  if (!sel) return null;
  const delta = (a: number, b: number | undefined) => {
    if (b === undefined || b === 0) return null;
    const pct = ((a - b) / Math.abs(b)) * 100;
    return `${pct >= 0 ? '+' : ''}${pct.toFixed(0)}% vs ${monthLabel(prev!.month)}`;
  };

  return (
    <>
      <div className="row" style={{ marginBottom: 16 }}>
        <div>
          <h1>Overview</h1>
          <p className="sub" style={{ margin: 0 }}>
            {summary!.counts.firstDate} → {summary!.counts.lastDate} · {summary!.counts.total} transactions
          </p>
        </div>
        <div className="spacer" />
        <select value={range} onChange={(e) => setRange(e.target.value)} aria-label="Time range">
          {RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>

      <div className="tiles">
        <Tile label={`Spent · ${monthLabel(sel.month, 'long')}`} value={money(sel.spending, currency)} delta={delta(sel.spending, prev?.spending)}
          onClick={() => navigate(`transactions?month=${sel.month}&kind=spend`)} />
        <Tile label="Of which one-off" value={money(sel.oneOff, currency)} delta={`${money(sel.spending - sel.oneOff, currency)} recurring`} />
        <Tile label="Income" value={money(sel.income, currency)} delta={delta(sel.income, prev?.income)}
          onClick={() => navigate(`transactions?month=${sel.month}&kind=income`)} />
        <Tile label="Left over" value={money(sel.income - sel.spending, currency)}
          delta={`${money(sel.savedInternally, currency)} moved to savings`} />
      </div>

      <div className="card">
        <h2>Income vs spending</h2>
        <MonthBars months={months} currency={currency} selected={sel.month} onSelect={setSelected} series={[
          { key: 'income', label: 'Income', color: 'var(--series-3)', value: (m) => m.income },
          { key: 'spending', label: 'Spending', color: 'var(--series-1)', value: (m) => m.spending },
        ]} />
      </div>

      <div className="card">
        <h2>Spending: recurring vs one-off purchases</h2>
        <p className="muted small" style={{ marginTop: -6 }}>Mark big purchases (a console, a laptop) as one-off on the Transactions page to see if your everyday spending is really growing.</p>
        <MonthBars months={months} currency={currency} stacked selected={sel.month} onSelect={setSelected} series={[
          { key: 'recurring', label: 'Recurring', color: 'var(--series-1)', value: (m) => m.spending - m.oneOff },
          { key: 'oneoff', label: 'One-off', color: 'var(--series-2)', value: (m) => m.oneOff },
        ]} />
      </div>

      <Compare currency={currency} catList={catList} />

      <div className="card">
        <h2>Spending by category</h2>
        <CategoryHeatmap months={months} categories={catList} currency={currency} />
      </div>
    </>
  );
}

function Tile({ label, value, delta, onClick }: { label: string; value: string; delta?: string | null; onClick?: () => void }) {
  return (
    <div className="tile" onClick={onClick} style={{ cursor: onClick ? 'pointer' : undefined }}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {delta && <div className="delta">{delta}</div>}
    </div>
  );
}

/** Before/after comparison around a date the user picks (e.g. starting a job). */
function Compare({ currency, catList }: { currency: string; catList: { id: string; name: string }[] }) {
  const [cutoff, setCutoff] = useState('');
  const [data, setData] = useState<{ before: PeriodSummary; after: PeriodSummary } | null>(null);

  useEffect(() => { api.settings().then((s) => setCutoff(s.compare_date ?? '')); }, []);
  useEffect(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) { setData(null); return; }
    api.saveSettings({ compare_date: cutoff });
    api.compare(cutoff).then(setData).catch(() => setData(null));
  }, [cutoff]);

  const rows = data ? catList
    .map((c) => ({ ...c, before: data.before.avgByCategory[c.id] ?? 0, after: data.after.avgByCategory[c.id] ?? 0 }))
    .filter((r) => r.before || r.after)
    .sort((a, b) => (b.after - b.before) - (a.after - a.before)) : [];

  const line = (label: string, b: number, a: number, bold = false) => (
    <tr style={{ fontWeight: bold ? 600 : undefined }}>
      <td>{label}</td>
      <td className="num">{moneyShort(b, currency)}</td>
      <td className="num">{moneyShort(a, currency)}</td>
      <td className="num">{a - b >= 0 ? '+' : ''}{moneyShort(a - b, currency)}</td>
      <td className="num muted">{b ? `${a - b >= 0 ? '+' : ''}${(((a - b) / b) * 100).toFixed(0)}%` : '—'}</td>
    </tr>
  );

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Before vs after</h2>
        <div className="spacer" />
        <label className="small muted">Compare around&nbsp;<input type="date" value={cutoff} onChange={(e) => setCutoff(e.target.value)} /></label>
      </div>
      {!data ? <p className="muted">Pick a date (e.g. when you started your job) to compare average monthly spending before and after it.</p> : (
        <>
          <p className="muted small">Averages per full month: {data.before.months} months before, {data.after.months} months after. The month of the date itself is left out.</p>
          <table>
            <thead><tr><th>Per month</th><th className="num">Before</th><th className="num">After</th><th className="num">Change</th><th className="num"></th></tr></thead>
            <tbody>
              {line('Income', data.before.avgIncome, data.after.avgIncome, true)}
              {line('Spending', data.before.avgSpending, data.after.avgSpending, true)}
              {line('Spending excl. one-offs', data.before.avgRecurringSpending, data.after.avgRecurringSpending, true)}
              {rows.map((r) => <tr key={r.id}><td style={{ paddingLeft: 20 }}>{r.name}</td>
                <td className="num">{moneyShort(r.before, currency)}</td><td className="num">{moneyShort(r.after, currency)}</td>
                <td className="num">{r.after - r.before >= 0 ? '+' : ''}{moneyShort(r.after - r.before, currency)}</td>
                <td className="num muted">{r.before ? `${r.after - r.before >= 0 ? '+' : ''}${(((r.after - r.before) / r.before) * 100).toFixed(0)}%` : 'new'}</td></tr>)}
            </tbody>
          </table>
          <p className="small" style={{ marginTop: 12 }}>
            Share of income spent: <b>{pct(data.before.avgSpending, data.before.avgIncome)}</b> before → <b>{pct(data.after.avgSpending, data.after.avgIncome)}</b> after.
          </p>
        </>
      )}
    </div>
  );
}

const pct = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(0)}%` : '—');
