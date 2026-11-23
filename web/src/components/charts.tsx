import { useState, type ReactNode } from 'react';
import { monthLabel, moneyShort, type MonthReport } from '../api.ts';

const W = 760, H = 240, PAD = { l: 52, r: 8, t: 8, b: 26 };

function niceMax(v: number): number {
  if (v <= 0) return 100;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= v)!;
}

/** A bar with rounded top corners, anchored flat to the baseline. */
function bar(x: number, y: number, w: number, h: number, r = 4): string {
  if (h <= 0) return '';
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

interface Series { key: string; label: string; color: string; value: (m: MonthReport) => number; }

/**
 * Bars per month. `stacked` stacks the series (e.g. recurring + one-off), otherwise groups them
 * side by side (e.g. income vs spending). Hovering a month shows a tooltip with all values.
 */
export function MonthBars({ months, series, stacked = false, currency, onSelect, selected }: {
  months: MonthReport[]; series: Series[]; stacked?: boolean; currency: string;
  onSelect?: (m: string) => void; selected?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (months.length === 0) return <p className="muted">No data yet.</p>;
  const totals = months.map((m) => stacked
    ? series.reduce((s, x) => s + Math.max(0, x.value(m)), 0)
    : Math.max(...series.map((x) => x.value(m))));
  const max = niceMax(Math.max(...totals));
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const slot = iw / months.length;
  const groupW = Math.min(slot * 0.72, 56);
  const barW = stacked ? groupW : (groupW - 2 * (series.length - 1)) / series.length;
  const y = (v: number) => PAD.t + ih - (Math.max(0, v) / max) * ih;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const labelEvery = Math.ceil(months.length / 14);

  return (
    <div className="chart-wrap">
      <div className="legend">{series.map((s) => <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>)}</div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={series.map((s) => s.label).join(' and ') + ' per month'}
        onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--grid)" />
            <text x={PAD.l - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--text-muted)">{moneyShort(t, currency)}</text>
          </g>
        ))}
        {months.map((m, i) => {
          const x0 = PAD.l + i * slot + (slot - groupW) / 2;
          let acc = 0;
          const active = hover === i || selected === m.month;
          return (
            <g key={m.month} opacity={hover !== null && hover !== i ? 0.55 : 1}>
              {series.map((s, si) => {
                const v = Math.max(0, s.value(m));
                if (stacked) {
                  const top = y(acc + v);
                  const bottom = y(acc) - (si > 0 && acc > 0 ? 2 : 0); // 2px surface gap between segments
                  acc += v;
                  const isTop = series.slice(si + 1).every((n) => n.value(m) <= 0);
                  const h = Math.max(0, bottom - top);
                  return <path key={s.key} d={isTop ? bar(x0, top, barW, h) : `M${x0},${top}h${barW}v${h}h${-barW}Z`} fill={s.color} />;
                }
                const x = x0 + si * (barW + 2);
                return <path key={s.key} d={bar(x, y(v), barW, y(0) - y(v))} fill={s.color} />;
              })}
              {i % labelEvery === 0 && (
                <text x={x0 + groupW / 2} y={H - 8} textAnchor="middle" fontSize="11" fill={active ? 'var(--text-primary)' : 'var(--text-muted)'}
                  fontWeight={selected === m.month ? 700 : 400}>{monthLabel(m.month)}</text>
              )}
              <rect x={PAD.l + i * slot} y={PAD.t} width={slot} height={ih + PAD.b} fill="transparent"
                style={{ cursor: onSelect ? 'pointer' : 'default' }} onMouseEnter={() => setHover(i)} onClick={() => onSelect?.(m.month)} />
            </g>
          );
        })}
        <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} stroke="var(--text-muted)" />
      </svg>
      {hover !== null && (
        <Tooltip leftPct={((PAD.l + (hover + 0.5) * slot) / W) * 100}>
          <div className="t-title">{monthLabel(months[hover]!.month, 'long')}</div>
          {series.map((s) => (
            <div key={s.key} className="row" style={{ justifyContent: 'space-between', gap: 16 }}>
              <span><i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: s.color, marginRight: 6 }} />{s.label}</span>
              <b className="num">{moneyShort(s.value(months[hover]!), currency)}</b>
            </div>
          ))}
        </Tooltip>
      )}
    </div>
  );
}

function Tooltip({ leftPct, children }: { leftPct: number; children: ReactNode }) {
  const flip = leftPct > 65;
  return (
    <div className="tooltip" style={{ top: 28, ...(flip ? { right: `${100 - leftPct + 2}%` } : { left: `${leftPct + 2}%` }) }}>
      {children}
    </div>
  );
}

/** Categories x months table, cell shade = spending (one-hue sequential scale). */
export function CategoryHeatmap({ months, categories, currency }: {
  months: MonthReport[]; categories: { id: string; name: string }[]; currency: string;
}) {
  const rows = categories
    .map((c) => ({ ...c, values: months.map((m) => m.byCategory[c.id] ?? 0) }))
    .map((r) => ({ ...r, total: r.values.reduce((a, b) => a + b, 0) }))
    .filter((r) => r.total !== 0)
    .sort((a, b) => b.total - a.total);
  const max = Math.max(1, ...rows.flatMap((r) => r.values));
  const shade = (v: number) => {
    if (v <= 0) return 'transparent';
    const i = Math.min(5, Math.floor((v / max) * 6));
    return `var(--seq-${i})`;
  };
  const ink = (v: number) => (v / max > 0.5 ? '#fff' : 'var(--text-primary)');
  if (rows.length === 0) return <p className="muted">No categorized spending yet.</p>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="heat">
        <thead>
          <tr><th>Category</th>{months.map((m) => <th key={m.month} className="num">{monthLabel(m.month)}</th>)}<th className="num">Avg / mo</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td style={{ whiteSpace: 'nowrap' }}>{r.name}</td>
              {r.values.map((v, i) => (
                <td key={i} className="cell" style={{ background: shade(v), color: ink(v) }} title={`${r.name}, ${monthLabel(months[i]!.month, 'long')}: ${moneyShort(v, currency)}`}>
                  {v ? moneyShort(v, currency) : <span className="muted">–</span>}
                </td>
              ))}
              <td className="num"><b>{moneyShort(r.total / months.length, currency)}</b></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
