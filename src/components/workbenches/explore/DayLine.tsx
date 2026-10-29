import { useRef } from 'react';
import { DATE, LOOKS, WEATHER, type Spot } from './model';
import { dayTimes, hm, sunAt } from './sun';

// 一天的时间线（05:00–20:00）：光线带（蓝调 / 金色时刻 / 白天 / 夜）+ 太阳高度曲线 + 逐时天气 + 机位时段 + 换装点。
// 拖动或点击任意位置移动播放头，地图上的太阳方位跟着变。可以叠一条「实际」轨道做对照（回顾面）。

const T0 = 5 * 60, T1 = 20 * 60;
const X = (t: number) => `${(t - T0) / (T1 - T0) * 100}%`;
const W = (d: number) => `${d / (T1 - T0) * 100}%`;
const ICON: Record<string, string> = { 晴: '○', 少云: '◐', 多云: '●', 阵雨: '╎' };

export default function DayLine({ spots, sel, onSel, t, onT, actual, compact }: {
  spots: Spot[]; sel: string | null; onSel: (id: string) => void; t: number; onT: (t: number) => void;
  actual?: Record<string, [number, number] | null>; compact?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const dt = dayTimes(DATE);
  const toT = (cx: number) => { const r = box.current!.querySelector('.dl-track')!.getBoundingClientRect(); return Math.round(Math.max(T0, Math.min(T1, T0 + (cx - r.left) / r.width * (T1 - T0))) / 5) * 5; };
  const curve = Array.from({ length: 61 }, (_, i) => { const m = T0 + i * 15, a = sunAt(DATE, m).alt; return `${i ? 'L' : 'M'}${(i / 60 * 100).toFixed(2)} ${(30 - Math.max(-6, a) / 50 * 26).toFixed(2)}`; }).join(' ');
  const bands: [number, number, string, string][] = [
    [T0, dt.blueAm[0], 'night', ''], [dt.blueAm[0], dt.goldAm[0], 'blue', '蓝调'], [dt.goldAm[0], dt.goldAm[1], 'gold', '金色时刻'], [dt.goldAm[1], dt.goldPm[0], 'day', ''],
    [dt.goldPm[0], dt.goldPm[1], 'gold', '金色时刻'], [dt.goldPm[1], dt.bluePm[1], 'blue', '蓝调'], [dt.bluePm[1], T1, 'night', ''],
  ];
  const order = [...spots].sort((a, b) => a.start - b.start);
  return <div className="dl" ref={box} data-compact={compact || undefined}
    onPointerDown={e => { if ((e.target as HTMLElement).closest('.dl-spot')) return; onT(toT(e.clientX)); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); }}
    onPointerMove={e => { if (e.buttons === 1 && !(e.target as HTMLElement).closest('.dl-spot')) onT(toT(e.clientX)); }}>
    <div className="dl-labels"><span /><span>光线</span><span>天气</span><span>机位</span>{actual && <span>实际</span>}</div>
    <div className="dl-track">
      <div className="dl-ruler">{Array.from({ length: 16 }, (_, i) => <i key={i} style={{ left: X(T0 + i * 60) }}>{String(5 + i).padStart(2, '0')}</i>)}</div>
      <div className="dl-light">
        {bands.map(([a, b, k, l], i) => <span key={i} data-k={k} style={{ left: X(a), width: W(b - a) }}>{l && <em>{l}</em>}</span>)}
        <svg viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true"><path d={curve} /><line x1="0" x2="100" y1="30" y2="30" /></svg>
        <b className="dl-rise" style={{ left: X(dt.sunrise) }}>日出 {hm(dt.sunrise)}</b><b className="dl-set" style={{ left: X(dt.sunset) }}>日落 {hm(dt.sunset)}</b>
      </div>
      <div className="dl-wx">{WEATHER.map(w => <span key={w.h} style={{ left: X(w.h * 60), width: W(60) }} data-rain={w.rain >= 30 || undefined}>
        <i title={w.cond}>{ICON[w.cond]}</i><b>{w.t}°</b>{w.rain > 0 && <u style={{ height: `${w.rain / 40 * 100}%` }} title={`降水 ${w.rain}%`} />}<small>{w.rain ? `${w.rain}%` : ''}</small>
      </span>)}</div>
      <div className="dl-spots">
        {order.slice(1).map((p, i) => <i key={p.id} className="dl-walk" style={{ left: X(order[i].start + order[i].dur), width: W(p.start - order[i].start - order[i].dur) }} />)}
        {order.map(p => <button key={p.id} className="dl-spot" data-kind={p.kind} aria-pressed={p.id === sel} style={{ left: X(p.start), width: W(p.dur) }} onClick={() => { onSel(p.id); onT(p.start + Math.round(p.dur / 2)); }} title={`${p.no} ${p.name} · ${hm(p.start)}–${hm(p.start + p.dur)}`}>
          <b>{p.no}</b>{!compact && <span>{p.name.split(' · ')[1] ?? p.name}</span>}</button>)}
        {LOOKS.filter(l => l.change).map(l => <em key={l.id} className="dl-change" style={{ left: X(l.change!.at) }} title={`换装 ${l.id} · ${l.change!.where}`}>换 {l.id}</em>)}
      </div>
      {actual && <div className="dl-actual">{order.map(p => { const a = actual[p.id]; return a ? <span key={p.id} style={{ left: X(a[0]), width: W(a[1] - a[0]) }} data-late={a[0] - p.start > 5 || undefined}>{p.no}</span> : <span key={p.id} className="is-miss" style={{ left: X(p.start), width: W(p.dur) }}>未拍</span>; })}</div>}
      <div className="dl-head" style={{ left: X(t) }}><b>{hm(t)}</b></div>
    </div>
  </div>;
}
