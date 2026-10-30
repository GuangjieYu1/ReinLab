import { useRef } from 'react';
import type { ExplorePlan, WeatherHour, WeatherView } from '../../../../../packages/contracts/src/explore';
import { center, stopLabels } from './overlays';
import { dateToLocal, dayLight, hm, localToDate, sunPos } from './sunlive';

// 真实的一天：光线带 + 太阳高度曲线（按选中停留点或目的地的位置）、逐时天气（按停留点归属）、停留点时段。
// 沿用原时间线的样式（.dl）。分钟数都相对 day 的当地 0 点，可以超过 1440（跨午夜）。

function range(plan: ExplorePlan, day: string, tz: string): [number, number] {
  let a = 4 * 60, b = 21 * 60;
  for (const s of plan.stops) if (s.window && s.day === day) {
    a = Math.min(a, dateToLocal(s.window.start, day, tz) - 60);
    b = Math.max(b, dateToLocal(s.window.end, day, tz) + 60);
  }
  return [Math.floor(a / 60) * 60, Math.ceil(b / 60) * 60];
}

const cond = (w: WeatherHour) => (w.precipProb ?? 0) >= 40 || (w.precipMm ?? 0) >= 0.5 ? '╎' : (w.cloud ?? 0) >= 70 ? '●' : (w.cloud ?? 0) >= 30 ? '◐' : '○';

export default function LiveDayLine({ plan, day, tz, selected, onSelect, t, onT, weather }: {
  plan: ExplorePlan; day: string; tz: string; selected: string | null; onSelect: (id: string) => void;
  t: number; onT: (t: number) => void; weather: WeatherView | null;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [T0, T1] = range(plan, day, tz);
  const X = (m: number) => `${(m - T0) / (T1 - T0) * 100}%`, W = (d: number) => `${d / (T1 - T0) * 100}%`;
  const sel = plan.stops.find(s => s.id === selected);
  const at = sel ? center(sel) : plan.destination?.center ?? null;
  const toT = (cx: number) => { const r = box.current!.querySelector('.dl-track')!.getBoundingClientRect(); return Math.round(Math.max(T0, Math.min(T1, T0 + (cx - r.left) / r.width * (T1 - T0))) / 5) * 5; };

  const dl = at ? dayLight(day, tz, at[0], at[1]) : null;
  const curve = at ? Array.from({ length: 61 }, (_, i) => { const m = T0 + i * (T1 - T0) / 60, a = sunPos(localToDate(day, m, tz), at[0], at[1]).alt; return `${i ? 'L' : 'M'}${(i / 60 * 100).toFixed(2)} ${(30 - Math.max(-6, a) / 60 * 26).toFixed(2)}`; }).join(' ') : '';
  const bands: [number, number, string, string][] = [];
  if (dl) {
    const push = (r: [number, number] | null, k: string, l: string) => { if (r) bands.push([r[0], r[1], k, l]); };
    push(dl.blueAm, 'blue', '蓝调'); push(dl.goldAm, 'gold', '金色时刻'); push(dl.goldPm, 'gold', '金色时刻'); push(dl.bluePm, 'blue', '蓝调');
    if (dl.goldAm && dl.goldPm) bands.push([dl.goldAm[1], dl.goldPm[0], 'day', '']);
  }

  // 天气：选中停留点就用它那一组，否则用第一组 / 目的地
  const group = weather?.byStop.find(g => g.stopId === selected) ?? weather?.byStop[0] ?? (weather?.destination ? { hours: weather.destination.hours } : null);
  const hours = (group?.hours ?? []).map(w => ({ w, m: dateToLocal(w.at, day, tz) })).filter(x => x.m >= T0 && x.m < T1);
  const labels = stopLabels(plan);
  const stops = plan.stops.filter(s => s.window && s.day === day).sort((a, b) => a.window!.start.localeCompare(b.window!.start));
  const hours24 = Array.from({ length: (T1 - T0) / 60 + 1 }, (_, i) => T0 + i * 60);

  return <div className="dl exl-dl" ref={box}
    onPointerDown={e => { if ((e.target as HTMLElement).closest('.dl-spot')) return; onT(toT(e.clientX)); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); }}
    onPointerMove={e => { if (e.buttons === 1 && !(e.target as HTMLElement).closest('.dl-spot')) onT(toT(e.clientX)); }}>
    <div className="dl-labels"><span /><span>光线</span><span>天气</span><span>停留</span></div>
    <div className="dl-track">
      <div className="dl-ruler">{hours24.map(m => <i key={m} style={{ left: X(m) }}>{hm(m).slice(0, 2)}</i>)}</div>
      <div className="dl-light">
        {bands.map(([a, b, k, l], i) => <span key={i} data-k={k} style={{ left: X(Math.max(a, T0)), width: W(Math.max(0, Math.min(b, T1) - Math.max(a, T0))) }}>{l && <em>{l}</em>}</span>)}
        {at && <svg viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true"><path d={curve} /><line x1="0" x2="100" y1="30" y2="30" /></svg>}
        {dl?.sunrise != null && <b className="dl-rise" style={{ left: X(dl.sunrise) }}>日出 {hm(dl.sunrise)}</b>}
        {dl?.sunset != null && <b className="dl-set" style={{ left: X(dl.sunset) }}>日落 {hm(dl.sunset)}</b>}
        {!at && <em className="exl-dl-empty">先定目的地，才能算光线</em>}
      </div>
      <div className="dl-wx">
        {weather?.state === 'out_of_range' ? <em className="exl-dl-empty">还没进入预报范围，进入后自动拉取</em>
          : weather?.state === 'failed' ? <em className="exl-dl-empty">这次没取到天气，后台会再试</em>
          : hours.length === 0 ? <em className="exl-dl-empty">{weather ? '这个时段没有预报数据' : '天气读取中…'}</em>
          : hours.map(({ w, m }) => <span key={w.at} style={{ left: X(m), width: W(60) }} data-rain={(w.precipProb ?? 0) >= 40 || undefined}
              title={`云量 ${w.cloud ?? '未知'}% · 降水 ${w.precipProb ?? '未知'}% / ${w.precipMm ?? '未知'} mm/h · 风 ${w.wind ?? '未知'} m/s 阵风 ${w.gust ?? '未知'} m/s`}>
              <i>{cond(w)}</i><b>{w.temp == null ? '—' : `${Math.round(w.temp)}°`}</b>{(w.precipProb ?? 0) > 0 && <u style={{ height: `${Math.min(100, w.precipProb!)}%` }} />}<small>{w.precipProb ? `${w.precipProb}%` : ''}</small>
            </span>)}
      </div>
      <div className="dl-spots">
        {stops.map(s => { const a = dateToLocal(s.window!.start, day, tz), b = dateToLocal(s.window!.end, day, tz);
          return <button key={s.id} className="dl-spot" data-kind={s.kind === 'spot' ? 'portrait' : 'street'} data-cand={s.state === 'candidate' || undefined} aria-pressed={s.id === selected}
            style={{ left: X(a), width: W(Math.max(10, b - a)) }} onClick={() => { onSelect(s.id); onT(Math.round((a + b) / 2)); }} title={`${labels[s.id]} ${s.name} · ${hm(a)}–${hm(b)}`}>
            <b>{labels[s.id]}</b><span>{s.name}</span></button>; })}
        {plan.conflicts.map(c => { const s = plan.stops.find(x => x.id === c.stopId); if (!s?.window) return null; return <em key={c.stopId} className="dl-change exl-conflict" style={{ left: X(dateToLocal(s.window.start, day, tz)) }} title={c.text}>!</em>; })}
      </div>
      <div className="dl-head" style={{ left: X(t) }}><b>{hm(t)}</b></div>
    </div>
  </div>;
}
