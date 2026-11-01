import { lazy, Suspense, useEffect, useState } from 'react';
import type { BuildingScene, ExplorePlan, Frame, RefImage, Stop, WeatherView } from '../../../../../packages/contracts/src/explore';
import { center, stopLabels } from './overlays';
import { dateToLocal, dayLight, hm, horizonAt, localToDate, sunPos } from './sunlive';
import { guidanceLines } from './guidance';
import SafeBox from './SafeBox';
import { FrameBox, LightCallout, PoseFigure, SettingsRow } from './diagrams';

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

const WhiteModel = lazy(() => import('./WhiteModel'));

/** 机位面里白模要用的后端能力（取场景、重算受光、听场景事件、改停留点）。 */
export type SceneApi = {
  scene: (stopId: string) => Promise<BuildingScene>;
  recompute: (stopId: string) => Promise<void>;
  onScene: (f: (stopId: string) => void) => () => void;
  patch: (p: Partial<Stop>) => void;
};
// 场景 JSON 可能一两 MB：按停留点缓存，切回来不重取（收到 explore.scene 才换）
const sceneCache = new Map<string, BuildingScene>();

/** 此刻挡光的楼：机位 / 模特当前段是 building 时的 buildingIds。 */
function blockingAt(stop: Stop, at: number) {
  const ids: string[] = [];
  for (const pl of [stop.light2?.camera, stop.light2?.subject]) {
    const seg = pl?.segments.find(x => Date.parse(x.start) <= at && at < Date.parse(x.end));
    if (seg?.state === 'building') ids.push(...(seg.cause?.buildingIds ?? []));
  }
  return [...new Set(ids)];
}

/** 白模区：按需取建筑场景（Three.js 懒加载，只在机位面打开时下载）。第一次取密集城区要半分钟以上。 */
function SceneSection({ plan, stop, day, tz, minutes, onMinutes, api }: {
  plan: ExplorePlan; stop: Stop; day: string; tz: string; minutes: number; onMinutes: (m: number) => void; api: SceneApi;
}) {
  const key = `${plan.dossierId}:${stop.id}`;
  const [open, setOpen] = useState(false);
  const [scene, setScene] = useState<BuildingScene | null>(sceneCache.get(key) ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [waited, setWaited] = useState(0);
  const [pick, setPick] = useState<'subject' | 'area' | null>(null);
  const [busy, setBusy] = useState(false);
  const load = (force = false) => {
    if (!force && sceneCache.has(key)) { setScene(sceneCache.get(key)!); return; }
    setErr(null); setWaited(0);
    api.scene(stop.id).then(sc => { sceneCache.set(key, sc); setScene(sc); },
      e => setErr((e as { code?: string })?.code === 'NOT_FOUND' ? '建筑数据还没接上' : e instanceof Error ? e.message : '取不到建筑数据'));
  };
  useEffect(() => { setScene(sceneCache.get(key) ?? null); setErr(null); setPick(null); }, [key]);
  useEffect(() => { if (open && !scene && !err) load(); }, [open, key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!open || scene || err) return; const t = window.setInterval(() => setWaited(w => w + 1), 1000); return () => window.clearInterval(t); }, [open, scene, err]);
  useEffect(() => api.onScene(id => { if (id === stop.id && open) { sceneCache.delete(key); load(true); } }), [api, stop.id, open, key]); // eslint-disable-line react-hooks/exhaustive-deps
  const recompute = async () => { setBusy(true); try { await api.recompute(stop.id); sceneCache.delete(key); load(true); } catch (e) { setErr(e instanceof Error ? e.message : '重算没成功'); } finally { setBusy(false); } };

  const body = plan.gear.map(g => g.data).find((g): g is Extract<typeof g, { type: 'gear' }> => g.type === 'gear' && g.kind === 'body');
  const focals = [...new Set([...(stop.detail?.settings?.focalMm ? [stop.detail.settings.focalMm] : []), ...(stop.focal ?? [])])];
  const at = localToDate(day, minutes, tz).getTime();
  const num = (v: string) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 500 ? n : null; };
  return <section className="is-wide"><h3>白模 · 机位视角</h3>
    <div className="exw-pos">
      <label>相机离地 <input type="number" step={0.5} min={0} max={500} defaultValue={stop.cameraHeightM ?? 1.5} key={`c${stop.id}${stop.cameraHeightM}`}
        onBlur={e => { const n = num(e.target.value); if (n !== null && n !== (stop.cameraHeightM ?? 1.5)) api.patch({ cameraHeightM: n }); }} /> m</label>
      <label>模特离地 <input type="number" step={0.1} min={0} max={500} defaultValue={stop.subjectHeightM ?? 1.5} key={`s${stop.id}${stop.subjectHeightM}`}
        onBlur={e => { const n = num(e.target.value); if (n !== null && n !== (stop.subjectHeightM ?? 1.5)) api.patch({ subjectHeightM: n }); }} /> m</label>
      <button className="rh-btn" aria-pressed={pick === 'subject'} onClick={() => { setOpen(true); setPick(p => p === 'subject' ? null : 'subject'); }}>{stop.subjectPoint ? '挪模特站位' : '放模特站位'}</button>
      {stop.subjectPoint && <button className="dm-link" onClick={() => api.patch({ subjectPoint: null })}>不单独设模特站位</button>}
      {stop.kind === 'area' && <button className="rh-btn" aria-pressed={pick === 'area'} onClick={() => { setOpen(true); setPick(p => p === 'area' ? null : 'area'); }}>{stop.areaRef ? '换片区参考点' : '选片区参考点'}</button>}
      {stop.kind === 'area' && !stop.areaRef && <small className="exw-warn">片区要先选一个参考点才算得出受光</small>}
    </div>
    {!open ? <button className="rh-btn" onClick={() => setOpen(true)}>打开白模</button>
      : err ? <p className="dm-msg">{err} <button className="dm-link" onClick={() => load(true)}>再取一次</button></p>
      : !scene ? <p><em>正在取周边建筑… {waited}s{waited >= 5 ? '（第一次取密集城区要半分钟以上，之后会快）' : ''}</em></p>
      : <SafeBox fallback={e => <p className="dm-msg">白模没能加载：{e.message}</p>}><Suspense fallback={<p><em>正在加载白模…</em></p>}>
          <WhiteModel key={stop.id} scene={scene} stop={stop} day={day} tz={tz} minutes={minutes} onMinutes={onMinutes}
            focals={focals.length ? focals : [35]} sensor={body?.sensor ?? null} orientation={stop.detail?.frame?.orientation ?? 'landscape'}
            cameraHeightM={stop.cameraHeightM ?? 1.5} subjectHeightM={stop.subjectHeightM ?? 1.5}
            highlight={blockingAt(stop, at)} pick={pick}
            onPick={p => { api.patch(pick === 'area' ? { areaRef: p } : { subjectPoint: p }); setPick(null); }} />
          <p className="exw-note">
            {stop.light2 ? `受光第 ${stop.light2.version} 版 · ${new Date(stop.light2.computedAt).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} 算 · ` : '受光还在算（算完会自动刷新）· '}
            <button className="dm-link" disabled={busy} onClick={() => void recompute()}>{busy ? '正在重算…' : '重算受光'}</button>
          </p>
        </Suspense></SafeBox>}
  </section>;
}

/** 机位面：选中停留点的全部信息。 */
export function StopDetail({ plan, stop, day, tz, minutes, refs, hasPeople, onFrame, onMinutes, sceneApi }: {
  plan: ExplorePlan; stop: Stop; day: string; tz: string; minutes: number; refs: RefImage[]; hasPeople: boolean;
  onFrame?: (f: Frame) => void; onMinutes?: (m: number) => void; sceneApi?: SceneApi;
}) {
  const label = stopLabels(plan)[stop.id], c = center(stop), dl = dayLight(day, tz, c[0], c[1]), l = lightAt(stop, day, tz, minutes);
  const mine = refs.filter(r => stop.refs.includes(r.id));
  const d = stop.detail ?? {};
  return <div className="ex-center exl-detail">
    <header className="ex-head"><span className="ex-id">{label}</span><div className="ex-title"><strong>{stop.name}</strong><span>{KIND_TEXT[stop.kind]} <i>·</i> {stop.state === 'candidate' ? '候选' : '已确认'} <i>·</i> {win(stop, day, tz)}</span></div></header>
    <div className="exl-detail-body">
      <section><h3>光线</h3>
        {stop.light2 && <LightCallout camera={stop.light2.camera} subject={stop.light2.subject} now={localToDate(day, minutes, tz).getTime()} day={day} tz={tz} />}
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
      {sceneApi && onMinutes && <SceneSection plan={plan} stop={stop} day={day} tz={tz} minutes={minutes} onMinutes={onMinutes} api={sceneApi} />}
      {hasPeople && d.guidance?.length ? <section><h3>引导词</h3><ol className="exd-lines">{guidanceLines(d).map(g => <li key={g.id}>{g.pose ? <PoseFigure pose={g.pose} title /> : <span />}<span>{g.text}</span></li>)}</ol></section> : null}
      {(d.settings || d.frame || onFrame) && <section><h3>参数与构图</h3><SettingsRow s={d.settings} names={Object.fromEntries(plan.gear.map(g => [g.profileId, g.data.name]))} />
        {d.frame ? <FrameBox key={stop.id} frame={d.frame} onChange={onFrame} />
          : onFrame ? <button className="rh-btn" onClick={() => onFrame({ orientation: hasPeople ? 'portrait' : 'landscape', subject: hasPeople ? { x: 0.33, y: 0.62, w: 0.22, h: 0.55 } : null, horizon: 0.66 })}>画构图框</button> : null}</section>}
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
