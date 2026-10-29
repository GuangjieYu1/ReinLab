import { useLayoutEffect, useRef, useState } from 'react';
import { typeOf, type Enc, type Row, type Table } from './dataModel';

// 图表：自写 SVG（不引第三方图表库）。单色优先：系列依次用墨、深灰、灰、浅灰；派生出来的系列用橙色强调。
// 纵轴按数据范围自适应（比较类图表除非 0 有意义）。柱子升起、折线画出、散点落下。

const INK_LIGHT = ['#141213', '#6b6865', '#9a9792', '#c9c6c0', '#3a3837'];
const INK_DARK = ['#ecebe7', '#9a9792', '#6b6865', '#d2d0cb', '#4a4745'];
/** 按刻度间距决定小数位：数据挤在 1.00 附近时也能分清刻度。 */
const fmtBy = (span: number) => (v: number) => v.toFixed(Math.max(0, Math.min(5, Math.ceil(-Math.log10((span || 1) / 4)) + 1)));
const fmt = (v: number) => Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3);

export type ChartTheme = 'ink' | 'accent' | 'dark';
export default function Chart({ table, enc, mini, accent, theme = 'ink', sorted }: { table: Table; enc: Enc; mini?: boolean; accent?: string | null; theme?: ChartTheme; sorted?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 600, h: 360 });
  useLayoutEffect(() => { const el = box.current; if (!el) return; const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight })); ro.observe(el); return () => ro.disconnect(); }, []);
  const { x, y, color } = enc;
  const INK = theme === 'dark' ? INK_DARK : INK_LIGHT;
  if (!x || !y || !table.cols.includes(x) || !table.cols.includes(y)) return <div ref={box} className="dc dc-empty">{!mini && <><b>把字段拖到 x 和 y</b><span>或者在槽里直接打一个新概念的名字，AI 会派生它</span></>}</div>;
  const W = size.w, H = size.h, m = mini ? { l: 4, r: 4, t: 4, b: 4 } : { l: 58, r: 18, t: 22, b: 46 };
  const iw = Math.max(10, W - m.l - m.r), ih = Math.max(10, H - m.t - m.b);
  const xt = typeOf(table, x), yt = typeOf(table, y);
  const series = color && table.cols.includes(color) ? [...new Set(table.rows.map(r => String(r[color])))] : [''];
  // 派生出来的系列：橙色给「有意义的那一类」（适合 / 及格 / 保留 / 周末），否则给最后一类；其余按墨、灰排。
  // 没传 accent 时（报告、缩略图），颜色字段若是派生出来的，就默认强调它。
  const acc = accent === undefined ? (color && table.derived.includes(color) ? color : null) : accent;
  const hot = (acc && color === acc) || (theme === 'accent' && color) ? (series.find(v => /^(适合|及格|保留|周末)$/.test(v)) ?? series[series.length - 1]) : null;
  const colorOf = (s: string) => { if (hot) return s === hot ? '#ff7a1a' : INK[series.filter(v => v !== hot).indexOf(s) % INK.length]; return INK[series.indexOf(s) % INK.length]; };
  const sKey = (r: Row) => color ? String(r[color]) : '';
  const num = (v: unknown) => typeof v === 'number' ? v : v === true ? 1 : 0;
  // 横轴：数值型用线性比例，其余按出现顺序排成类别。
  const cats = xt === 'quantitative' && enc.mark !== 'bar' ? [] : [...new Set(table.rows.map(r => String(r[x])))].sort((a, b) => xt === 'temporal' ? (a < b ? -1 : 1) : 0);
  // 聚合：类别横轴下按 (x, 系列) 汇总 y。
  type P = { x: number | string; y: number; s: string };
  let pts: P[] = [];
  if (cats.length) {
    for (const c of cats) for (const s of series) {
      const rs = table.rows.filter(r => String(r[x]) === c && sKey(r) === s); if (!rs.length) continue;
      const vals = rs.map(r => num(r[y]));
      pts.push({ x: c, s, y: yt !== 'quantitative' || enc.agg === 'count' ? rs.length : enc.agg === 'sum' ? vals.reduce((a, b) => a + b, 0) : vals.reduce((a, b) => a + b, 0) / vals.length });
    }
  } else pts = table.rows.map(r => ({ x: num(r[x]), y: num(r[y]), s: sKey(r) }));
  if (sorted && enc.mark === 'bar' && cats.length && series.length === 1) { pts.sort((a, b) => b.y - a.y); cats.splice(0, cats.length, ...pts.map(p => String(p.x))); }
  const ys = pts.map(p => p.y);
  let lo = Math.min(...ys), hi = Math.max(...ys);
  if (enc.mark === 'bar') { lo = Math.min(0, lo); hi = Math.max(0, hi); }
  const pad = (hi - lo) * .08 || 1; if (enc.mark !== 'bar') { lo -= pad; } hi += pad;
  const Y = (v: number) => m.t + ih - ((v - lo) / (hi - lo)) * ih;
  const xs = cats.length ? [] : pts.map(p => p.x as number); const xlo = cats.length ? 0 : Math.min(...xs), xhi = cats.length ? 1 : Math.max(...xs);
  const band = cats.length ? iw / cats.length : 0;
  const X = (v: number | string) => cats.length ? m.l + band * (cats.indexOf(String(v)) + .5) : m.l + ((v as number - xlo) / (xhi - xlo || 1)) * iw;
  const yTicks = Array.from({ length: 5 }, (_, i) => lo + (hi - lo) * i / 4);
  const step = Math.max(1, Math.ceil(cats.length / Math.max(2, Math.floor(iw / 64))));
  const key = `${enc.mark}|${x}|${y}|${color}|${table.rows.length}|${table.name}`;
  return <div ref={box} className="dc" data-mini={mini || undefined} data-look={theme}>
    <svg width={W} height={H} key={key}>
      {!mini && <g className="dc-grid">{yTicks.map((t, i) => <g key={i}><line x1={m.l} x2={m.l + iw} y1={Y(t)} y2={Y(t)} /><text x={m.l - 8} y={Y(t) + 3.5} textAnchor="end">{fmtBy(hi - lo)(t)}</text></g>)}</g>}
      {!mini && <g className="dc-x">{cats.length ? cats.map((c, i) => i % step === 0 && <text key={c} x={X(c)} y={m.t + ih + 16} textAnchor="middle">{c.replace(/^2026-/, '')}</text>) : Array.from({ length: 6 }, (_, i) => xlo + (xhi - xlo) * i / 5).map((t, i) => <text key={i} x={X(t)} y={m.t + ih + 16} textAnchor="middle">{fmtBy(xhi - xlo)(t)}</text>)}
        <line x1={m.l} x2={m.l + iw} y1={m.t + ih} y2={m.t + ih} className="dc-axis" /><line x1={m.l} x2={m.l} y1={m.t} y2={m.t + ih} className="dc-axis" />
        <text x={m.l + iw} y={m.t + ih + 36} textAnchor="end" className="dc-title">{x} →</text><text x={m.l - 50} y={m.t - 8} className="dc-title">↑ {enc.agg !== 'mean' && cats.length ? `${enc.agg === 'sum' ? '合计' : '计数'} · ` : cats.length && yt === 'quantitative' ? '平均 · ' : ''}{y}</text></g>}
      {enc.mark === 'bar' && pts.map((p, i) => { const k = series.indexOf(p.s), bw = band * .72 / series.length, bx = X(p.x) - band * .36 + k * bw; const y0 = Y(0), y1 = Y(p.y);
        return <rect key={i} className="dc-bar" x={bx} y={Math.min(y0, y1)} width={Math.max(1, bw - 2)} height={Math.max(1, Math.abs(y0 - y1))} fill={theme === 'accent' && series.length === 1 ? (i === 0 || p.y === Math.max(...ys) ? '#ff7a1a' : INK[0]) : colorOf(p.s)} style={{ animationDelay: `${Math.min(i, 40) * 12}ms` }}><title>{`${p.x} · ${p.s} · ${fmt(p.y)}`}</title></rect>; })}
      {enc.mark === 'line' && series.map(s => { const ps = pts.filter(p => p.s === s).sort((a, b) => cats.length ? cats.indexOf(String(a.x)) - cats.indexOf(String(b.x)) : (a.x as number) - (b.x as number));
        return <g key={s}><path className="dc-line" d={ps.map((p, i) => `${i ? 'L' : 'M'}${X(p.x)},${Y(p.y)}`).join(' ')} stroke={theme === 'accent' && series.length === 1 ? '#ff7a1a' : colorOf(s)} pathLength={1} />{!mini && ps.map((p, i) => <circle key={i} cx={X(p.x)} cy={Y(p.y)} r={2.2} fill={colorOf(s)} className="dc-dot" />)}</g>; })}
      {enc.mark === 'point' && pts.map((p, i) => <rect key={i} className="dc-pt" x={X(p.x) - (mini ? 1.5 : 3.5)} y={Y(p.y) - (mini ? 1.5 : 3.5)} width={mini ? 3 : 7} height={mini ? 3 : 7} fill={(hot ? p.s === hot : series.indexOf(p.s) === 0 && series.length > 1) ? colorOf(p.s) : '#fbfbf9'} stroke={colorOf(p.s)} strokeWidth={1.4} style={{ animationDelay: `${Math.min(i, 60) * 10}ms` }}><title>{`${x} ${p.x} · ${y} ${fmt(p.y)}${p.s ? ` · ${p.s}` : ''}`}</title></rect>)}
    </svg>
    {!mini && color && series.length > 1 && <div className="dc-legend"><b>{color}</b>{series.map(s => <span key={s}><i style={{ background: colorOf(s) }} />{s}</span>)}</div>}
  </div>;
}
