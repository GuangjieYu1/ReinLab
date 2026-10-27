import type { LiveData, Unit, Widget } from './liveModel';
import { hm, pv } from './liveModel';

// 声明式面板的渲染器：清单里的 panel 只写「画什么」，这里统一按莱茵的样式画——
// 黑白灰区分序列（实线 / 虚线 / 点线），橙色只给阈值和告警。全部是 SVG，不用 WebGL。

const DASH = ['', '5 3', '1.5 2.5', '8 3 2 3'];
const INK = ['var(--rh-ink)', 'var(--rh-ink-3)', 'var(--rh-ink-3)', 'var(--rh-ink-4)'];
const fmtV = (v: number, f?: string) => f === 'pct' ? `${v.toFixed(2)}%` : f === 'px' ? v.toLocaleString('en-US', { maximumFractionDigits: 1 }) : Math.abs(v) < 10 && !Number.isInteger(v) ? v.toFixed(2) : String(Math.round(v));

function scale(vals: number[], band?: [number, number], extra: number[] = []) {
  if (band) return band;
  const all = [...vals, ...extra]; let lo = Math.min(...all), hi = Math.max(...all);
  if (!isFinite(lo)) return [0, 1] as [number, number];
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.12; return [lo - pad, hi + pad] as [number, number];
}

export function LineChart({ w, d, u, h = 170 }: { w: Extract<Widget, { kind: 'line' }>; d: LiveData; u: Unit; h?: number }) {
  const W = 600, H = h, L = 44, R = 10, T = 10, B = 20;
  const keys = w.series.filter(k => d.series[k]?.length);
  const th = w.threshold ? pv(u, w.threshold) as number : undefined;
  const [lo, hi] = scale(keys.flatMap(k => d.series[k]), w.band, th !== undefined ? [th] : []);
  const n = Math.max(...keys.map(k => d.series[k].length), 2);
  const x = (i: number, len: number) => L + (W - L - R) * ((n - len + i) / (n - 1));
  const y = (v: number) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  const ticks = [lo + (hi - lo) * 0.15, (lo + hi) / 2, hi - (hi - lo) * 0.15];
  const t0 = d.minute - n + 1;
  return <div className="lv-chart">
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={w.title}>
      {ticks.map((v, i) => <g key={i}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="lv-gl" /><text x={L - 6} y={y(v) + 3} className="lv-ax" textAnchor="end">{fmtV(v, w.fmt)}</text></g>)}
      {[0, 0.5, 1].map(f => <text key={f} x={L + (W - L - R) * f} y={H - 5} className="lv-ax" textAnchor={f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}>{hm(Math.round(t0 + (n - 1) * f))}</text>)}
      {th !== undefined && <>
        <rect x={L} width={W - L - R} y={(w.fmt === 'pct' ? T : y(th))} height={w.fmt === 'pct' ? Math.max(0, y(th) - T) : Math.max(0, H - B - y(th))} className="lv-zone" />
        <line x1={L} x2={W - R} y1={y(th)} y2={y(th)} className="lv-th" />
        <text x={W - R - 4} y={y(th) - 4} className="lv-th-l" textAnchor="end">阈值 {fmtV(th, w.fmt)}</text>
      </>}
      {keys.map((k, si) => { const s = d.series[k]; return <polyline key={k} points={s.map((v, i) => `${x(i, s.length).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} fill="none" stroke={INK[si % 4]} strokeWidth={si === 0 ? 1.6 : 1.2} strokeDasharray={DASH[si % 4]} vectorEffect="non-scaling-stroke" />; })}
      {keys.map(k => { const s = d.series[k], v = s.at(-1)!; const hot = th !== undefined && (w.fmt === 'pct' ? v > th : v < th); return <rect key={k} x={x(s.length - 1, s.length) - 3} y={y(v) - 3} width={6} height={6} className={hot ? 'lv-dot is-hot' : 'lv-dot'} />; })}
    </svg>
    {keys.length > 1 && <ul className="lv-legend">{keys.map((k, si) => <li key={k}><svg viewBox="0 0 22 6"><line x1="0" x2="22" y1="3" y2="3" stroke={INK[si % 4]} strokeWidth="1.6" strokeDasharray={DASH[si % 4]} /></svg>{k}<b>{fmtV(d.series[k].at(-1)!, w.fmt)}</b></li>)}</ul>}
  </div>;
}

export function Spark({ vals, hot, h = 34 }: { vals: number[]; hot?: boolean; h?: number }) {
  if (vals.length < 2) return <svg className="lv-spark" viewBox={`0 0 120 ${h}`} />;
  const lo = Math.min(...vals), hi = Math.max(...vals) || 1, W = 120;
  const pts = vals.map((v, i) => `${(i / (vals.length - 1) * W).toFixed(1)},${(h - 3 - (h - 6) * ((v - lo) / (hi - lo || 1))).toFixed(1)}`).join(' ');
  return <svg className="lv-spark" viewBox={`0 0 ${W} ${h}`} preserveAspectRatio="none" aria-hidden="true">
    <polyline points={pts} fill="none" stroke={hot ? 'var(--rh-accent)' : 'var(--rh-ink)'} strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
  </svg>;
}

export function Stat({ w, d }: { w: Extract<Widget, { kind: 'stat' }>; d: LiveData }) {
  const s = d.stats[w.stat];
  return <div className="lv-stat" data-hot={s?.alert || undefined}><b>{s?.v ?? '—'}</b><small>{s?.sub}</small></div>;
}

export function Table({ w, d }: { w: Extract<Widget, { kind: 'table' }>; d: LiveData }) {
  if (!d.rows.length) return <p className="lv-none">还没有数据，等下一拍</p>;
  return <table className="lv-table"><thead><tr>{w.cols.map(([k, l]) => <th key={k}>{l}</th>)}</tr></thead>
    <tbody>{d.rows.map((r, i) => <tr key={`${r.t ?? r.name}-${i}`} data-new={i === 0 || undefined}>{w.cols.map(([k]) => { const v = r[k]; const neg = k === 'score' && typeof v === 'number' && v < 0; return <td key={k} data-k={k} data-neg={neg || undefined}>{typeof v === 'number' ? (k === 'score' ? (v > 0 ? '+' : '') + v.toFixed(2) : v) : v}</td>; })}</tr>)}</tbody></table>;
}

export function Bars({ d }: { d: LiveData }) {
  const bars = d.bars ?? []; const max = Math.max(...bars.map(b => b[1]), 1);
  return <ul className="lv-bars">{bars.map(([k, v]) => <li key={k}><span>{k}</span><i style={{ width: `${v / max * 100}%` }} /><b>{v}</b></li>)}</ul>;
}

export function Depth({ d }: { d: LiveData }) {
  if (!d.depth) return null;
  const W = 300, H = 170, { bids, asks, mid } = d.depth;
  const cum = (l: [number, number][]) => { let s = 0; return l.map(([p, q]) => [p, (s += q)] as [number, number]); };
  const cb = cum(bids), ca = cum(asks); const maxQ = Math.max(cb.at(-1)![1], ca.at(-1)![1]);
  const lo = bids.at(-1)![0], hi = asks.at(-1)![0];
  const x = (p: number) => 6 + (W - 12) * (p - lo) / (hi - lo), y = (q: number) => H - 22 - (H - 34) * q / maxQ;
  const path = (l: [number, number][]) => `M${x(l[0][0])},${H - 22} ` + l.map(([p, q]) => `L${x(p)},${y(q)}`).join(' ') + ` L${x(l.at(-1)![0])},${H - 22} Z`;
  return <div className="lv-chart"><svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="盘口深度">
    <path d={path(cb)} className="lv-bid" vectorEffect="non-scaling-stroke" />
    <path d={path(ca)} className="lv-ask" vectorEffect="non-scaling-stroke" />
    <line x1={x(mid)} x2={x(mid)} y1={8} y2={H - 22} className="lv-mid" />
    <text x={6} y={H - 6} className="lv-ax">买 · {bids.length} 档</text><text x={W - 6} y={H - 6} className="lv-ax" textAnchor="end">卖 · {asks.length} 档</text>
    <text x={x(mid)} y={H - 6} className="lv-ax" textAnchor="middle">{mid.toLocaleString('en-US', { maximumFractionDigits: 1 })}</text>
  </svg></div>;
}

export function SimChart({ d }: { d: LiveData }) {
  if (!d.sim) return null;
  const W = 600, H = 190, L = 40, R = 10, T = 10, B = 22, { curves, step, steps } = d.sim;
  const x = (i: number) => L + (W - L - R) * i / (steps - 1), y = (v: number) => T + (H - T - B) * (1 - v / 100);
  return <div className="lv-chart"><svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="扩散模拟">
    {[25, 50, 75].map(v => <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="lv-gl" /><text x={L - 6} y={y(v) + 3} className="lv-ax" textAnchor="end">{v}%</text></g>)}
    {[0, 12, 24, 36, 47].map(i => <text key={i} x={x(i)} y={H - 6} className="lv-ax" textAnchor="middle">{i}h</text>)}
    {curves.map((c, si) => <polyline key={c.name} points={c.pts.slice(0, Math.max(1, step)).map((v, i) => `${x(i)},${y(v)}`).join(' ')} fill="none"
      stroke={c.now ? 'var(--rh-accent)' : INK[si % 4]} strokeWidth={c.now ? 2 : 1.2} strokeDasharray={c.now ? '' : DASH[(si + 1) % 4]} vectorEffect="non-scaling-stroke" />)}
    {step < steps && step > 0 && <line x1={x(step - 1)} x2={x(step - 1)} y1={T} y2={H - B} className="lv-mid" />}
  </svg>
    <ul className="lv-legend">{curves.map((c, si) => <li key={c.name} data-now={c.now || undefined}><svg viewBox="0 0 22 6"><line x1="0" x2="22" y1="3" y2="3" stroke={c.now ? 'var(--rh-accent)' : INK[si % 4]} strokeWidth="1.8" strokeDasharray={c.now ? '' : DASH[(si + 1) % 4]} /></svg>{c.name}{c.now && <em>当前</em>}</li>)}</ul>
  </div>;
}

export function WidgetView({ w, d, u }: { w: Widget; d: LiveData; u: Unit }) {
  return <section className="lv-w" style={{ gridColumn: `span ${w.span}`, gridRow: 'rows' in w && w.rows ? `span ${w.rows}` : undefined }} data-kind={w.kind}>
    <header>{w.title}</header>
    {w.kind === 'line' ? <LineChart w={w} d={d} u={u} /> : w.kind === 'stat' ? <Stat w={w} d={d} /> : w.kind === 'table' ? <Table w={w} d={d} />
      : w.kind === 'bars' ? <Bars d={d} /> : w.kind === 'depth' ? <Depth d={d} /> : <SimChart d={d} />}
  </section>;
}
