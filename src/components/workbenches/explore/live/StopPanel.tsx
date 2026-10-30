import type { ExplorePlan, RefImage, Stop, WeatherView } from '../../../../../packages/contracts/src/explore';
import { center, stopLabels } from './overlays';
import { dateToLocal, dayLight, hm, horizonAt, localToDate, sunPos } from './sunlive';

export const KIND_TEXT: Record<Stop['kind'], string> = { spot: '固定机位', area: '一片街区', waypoint: '顺路点' };

/** 某时刻在这个停留点的光：太阳方位 / 高度、是否被山挡（有地形数据时）。 */
export function lightAt(stop: Stop, day: string, tz: string, minutes: number) {
  const c = center(stop), p = sunPos(localToDate(day, minutes, tz), c[0], c[1]);
  const h = horizonAt(stop.light?.horizon, p.az);
  const state = p.alt <= -6 ? '夜' : p.alt <= 0 ? '日落后 / 日出前' : h === null ? (stop.light ? '没有地形数据' : '地形未计算') : p.alt <= h ? '被山挡住 · 无直射光' : '有直射光';
  return { ...p, horizon: h, state, blocked: p.alt <= 0 || (h !== null && p.alt <= h) };
}

const win = (s: Stop, day: string, tz: string) => s.window ? `${hm(dateToLocal(s.window.start, day, tz))}–${hm(dateToLocal(s.window.end, day, tz))}` : '时段未定';

/** 地图右侧的小卡 / 对话里的候选卡：同一个停留点，同一组按钮。 */
export function StopCard({ plan, stop, tz, onKeep, onDrop, onOpen, compact }: {
  plan: ExplorePlan; stop: Stop; tz: string; onKeep: () => void; onDrop: () => void; onOpen?: () => void; compact?: boolean;
}) {
  const label = stopLabels(plan)[stop.id];
  return <div className="exl-stop" data-state={stop.state} data-compact={compact || undefined}>
    <header><b>{label}</b><div><strong>{stop.name}</strong><small>{KIND_TEXT[stop.kind]} · {stop.state === 'candidate' ? '候选' : '已确认'} · {win(stop, stop.day, tz)}</small></div></header>
    {stop.reason && <p>{stop.reason}</p>}
    <div className="exl-stop-act">
      {stop.state === 'candidate'
        ? <><button className="rh-btn is-solid" onClick={onKeep}>留下</button><button className="rh-btn" onClick={onDrop}>不要</button></>
        : <button className="rh-btn" onClick={onDrop}>从计划里删除</button>}
      {onOpen && <button className="dm-link" onClick={onOpen}>看详情 →</button>}
    </div>
  </div>;
}

/** 地图右侧的选中停留点摘要（沿用原 .ex-card）。 */
export function StopAside({ plan, stop, day, tz, minutes, weather, refs, onKeep, onDrop, onOpen }: {
  plan: ExplorePlan; stop: Stop; day: string; tz: string; minutes: number; weather: WeatherView | null; refs: RefImage[];
  onKeep: () => void; onDrop: () => void; onOpen: () => void;
}) {
  const l = lightAt(stop, day, tz, minutes), label = stopLabels(plan)[stop.id];
  const w = weather?.byStop.find(g => g.stopId === stop.id)?.hours.find(h => Math.abs(dateToLocal(h.at, day, tz) - minutes) < 31);
  const ref = refs.find(r => stop.refs.includes(r.id) && r.image);
  return <aside className="ex-card exl-aside">
    <header><b>{label}</b><div><strong>{stop.name}</strong><small>{KIND_TEXT[stop.kind]} · {stop.state === 'candidate' ? '候选' : '已确认'}</small></div></header>
    <dl className="ex-kv">
      <div><dt>时段</dt><dd>{win(stop, day, tz)}</dd></div>
      {stop.focal?.length ? <div><dt>焦段</dt><dd>{stop.focal.map(f => `${f}mm`).join(' · ')}</dd></div> : null}
      <div><dt>{hm(minutes)} 的光</dt><dd data-warn={l.blocked || undefined}>{l.state}</dd></div>
      <div><dt>太阳</dt><dd>方位 {Math.round(l.az)}° · 高度 {l.alt.toFixed(1)}°{l.horizon !== null ? ` · 山脊 ${l.horizon.toFixed(1)}°` : ''}</dd></div>
      {stop.light?.lit && <div><dt>见光</dt><dd>{stop.light.lit.length ? stop.light.lit.map(x => `${hm(dateToLocal(x.start, day, tz))}–${hm(dateToLocal(x.end, day, tz))}`).join('，') : '全天被山挡'}</dd></div>}
      {w && <div><dt>天气</dt><dd data-warn={(w.precipProb ?? 0) >= 40 || undefined}>云 {w.cloud ?? '—'}% · 降水 {w.precipProb ?? '—'}% · 风 {w.wind ?? '—'} m/s</dd></div>}
    </dl>
    {stop.reason && <p className="ex-comp">{stop.reason}</p>}
    {ref?.image && <figure className="exl-aside-ref"><img src={ref.image.src} alt="" /><figcaption>{ref.kind === 'same-spot' ? '该机位实拍' : '风格参考'} · {ref.author ?? ref.platform ?? '来源见详情'}</figcaption></figure>}
    <div className="exl-stop-act">
      {stop.state === 'candidate' ? <><button className="rh-btn is-solid" onClick={onKeep}>留下</button><button className="rh-btn" onClick={onDrop}>不要</button></> : <button className="rh-btn" onClick={onDrop}>删除</button>}
      <button className="ex-open" onClick={onOpen}>打开 →</button>
    </div>
  </aside>;
}

/** 机位面：选中停留点的全部信息（第一版不含 2.5D 白模）。 */
export function StopDetail({ plan, stop, day, tz, minutes, refs, hasPeople }: {
  plan: ExplorePlan; stop: Stop; day: string; tz: string; minutes: number; refs: RefImage[]; hasPeople: boolean;
}) {
  const label = stopLabels(plan)[stop.id], c = center(stop), dl = dayLight(day, tz, c[0], c[1]), l = lightAt(stop, day, tz, minutes);
  const mine = refs.filter(r => stop.refs.includes(r.id));
  const d = stop.detail ?? {};
  return <div className="ex-center exl-detail">
    <header className="ex-head"><span className="ex-id">{label}</span><div className="ex-title"><strong>{stop.name}</strong><span>{KIND_TEXT[stop.kind]} <i>·</i> {stop.state === 'candidate' ? '候选' : '已确认'} <i>·</i> {win(stop, day, tz)}</span></div></header>
    <div className="exl-detail-body">
      <section><h3>光线</h3>
        <dl className="ex-kv">
          <div><dt>日出 · 日落</dt><dd>{dl.sunrise != null ? hm(dl.sunrise) : '—'} · {dl.sunset != null ? hm(dl.sunset) : '—'}</dd></div>
          <div><dt>金色时刻</dt><dd>{dl.goldAm ? `${hm(dl.goldAm[0])}–${hm(dl.goldAm[1])}` : '—'} / {dl.goldPm ? `${hm(dl.goldPm[0])}–${hm(dl.goldPm[1])}` : '—'}</dd></div>
          <div><dt>{hm(minutes)}</dt><dd data-warn={l.blocked || undefined}>{l.state} · 方位 {Math.round(l.az)}° 高度 {l.alt.toFixed(1)}°</dd></div>
          <div><dt>地形见光</dt><dd>{stop.light?.lit ? (stop.light.lit.length ? stop.light.lit.map(x => `${hm(dateToLocal(x.start, day, tz))}–${hm(dateToLocal(x.end, day, tz))}`).join('，') : '全天被山挡') : '没有地形数据'}</dd></div>
          {stop.light?.basis && <div><dt>依据</dt><dd>{stop.light.basis.dem} · {stop.light.basis.resolutionM} m · 半径 {stop.light.basis.radiusKm} km（只算山，不含建筑和树）</dd></div>}
        </dl>
        {stop.light?.horizon && <Horizon horizon={stop.light.horizon} sunAz={l.az} sunAlt={l.alt} facing={stop.facing} />}
      </section>
      <section><h3>构图</h3>
        <p>{d.composition ?? <em>还没写</em>}</p>
        <dl className="ex-kv">
          {stop.facing !== undefined && <div><dt>朝向</dt><dd>{Math.round(stop.facing)}°</dd></div>}
          {stop.focal?.length ? <div><dt>焦段</dt><dd>{stop.focal.map(f => `${f}mm`).join(' · ')}</dd></div> : null}
        </dl>
      </section>
      {hasPeople && d.guidance?.length ? <section><h3>引导词</h3><ol className="ex-lines">{d.guidance.map(x => <li key={x}>{x}</li>)}</ol></section> : null}
      {hasPeople && d.outfit ? <section><h3>服饰</h3>{d.outfit.palette && <span className="ex-palette">{d.outfit.palette.map(c => <i key={c} style={{ background: c }} title={c} />)}</span>}{d.outfit.notes && <p>{d.outfit.notes}</p>}</section> : null}
      <section><h3>参考 · {mine.length}</h3>
        {mine.length === 0 ? <p><em>还没有参考图</em></p> : <div className="exl-refs">{mine.map(r => <RefTile key={r.id} r={r} />)}</div>}
      </section>
      <section><h3>规定</h3>{d.rules?.length ? <ul>{d.rules.map(r => <li key={r.text}>{r.text}{r.source && <> · <a href={r.source.url} target="_blank" rel="noreferrer">{r.source.name}</a></>}</li>)}</ul> : <p><em>未知</em></p>}</section>
      <section><h3>雨天 / 备选</h3><p>{d.fallback ?? <em>未知</em>}</p></section>
    </div>
  </div>;
}

export function RefTile({ r }: { r: RefImage }) {
  return <figure className="exl-ref">
    {r.image ? <img src={r.image.src} alt="" loading="lazy" /> : <div className="exl-ref-none">没有可显示的图</div>}
    <figcaption><b>{r.kind === 'same-spot' ? '该机位实拍' : '风格参考'}</b><span>{[r.author, r.platform].filter(Boolean).join(' · ') || (r.origin === 'upload' ? '你上传的' : '来源')}</span>
      {r.page && <a href={r.page.url} target="_blank" rel="noreferrer">{r.page.title ?? '原网页'} ↗</a>}</figcaption>
  </figure>;
}

/** 地平线小图：横轴方位 0–360°，纵轴仰角；标出此刻太阳和拍摄朝向。 */
function Horizon({ horizon, sunAz, sunAlt, facing }: { horizon: { azimuth: number; elevation: number }[]; sunAz: number; sunAlt: number; facing?: number }) {
  const max = Math.max(10, ...horizon.map(h => h.elevation), sunAlt + 2);
  const y = (e: number) => 60 - Math.max(-2, e) / max * 56;
  const pts = [...horizon].sort((a, b) => a.azimuth - b.azimuth).map(h => `${(h.azimuth / 360 * 300).toFixed(1)},${y(h.elevation).toFixed(1)}`);
  return <svg className="exl-horizon" viewBox="0 0 300 64" aria-label="地平线">
    <polygon points={`0,64 ${pts.join(' ')} 300,64`} />
    {facing !== undefined && <line className="is-face" x1={facing / 360 * 300} x2={facing / 360 * 300} y1="0" y2="64" />}
    {sunAlt > -6 && <circle cx={sunAz / 360 * 300} cy={y(sunAlt)} r="4" />}
    {['N', 'E', 'S', 'W'].map((k, i) => <text key={k} x={i * 75 + 2} y="62">{k}</text>)}
  </svg>;
}
