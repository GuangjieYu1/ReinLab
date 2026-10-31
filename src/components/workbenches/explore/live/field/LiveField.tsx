import { useEffect, useMemo, useState } from 'react';
import type { ExplorePlan, Stop, WeatherView } from '../../../../../../packages/contracts/src/explore';
import type { ExploreAdapter, MapConfig } from '../adapter';
import LiveMap from '../LiveMap';
import { center, stopLabels } from '../overlays';
import { KIND_TEXT, lightAt } from '../StopPanel';
import { dateToLocal, hm } from '../sunlive';
import { guidanceLines } from '../guidance';
import { PoseGlyph } from '../../Figures';
import type { PackRecord } from '../offline/db';
import { amapLink } from './gcj';
import { arrival, useFieldLocation } from './useFieldLocation';
import { useFieldLog } from './useFieldLog';
import OfflinePrep from './OfflinePrep';
import './field.css';

// 现场（09-explore-v2.md 第 3、4 节；10-explore-v2-contract.md 第 4.1 节）。手机 / iPad 两套布局，CSS 按宽度切。
// 数据来源：在线 = 当前计划；离线 = 离线包里的计划快照。离线不改正式行程，只记事实。

const OLD_POSES = new Set(['walk', 'look-back', 'lean', 'touch', 'pockets', 'scarf', 'step', 'stand']);
const SITUATIONS = [
  { key: 'rain', label: '下雨了' }, { key: 'late', label: '晚到了' }, { key: 'crowd', label: '人太多' }, { key: 'light', label: '光不对' },
] as const;

export type FieldProps = {
  plan: ExplorePlan; title: string; weather: WeatherView | null;
  adapter: ExploreAdapter | null;          // 离线页面里为 null（不能调服务端）
  accountId: string; dossierId: string;
  mapCfg: MapConfig | null;
  offlinePack: PackRecord | null;          // 正在用的离线包（离线页面）
  serverRevision: number | null;           // 服务端计划修订（知道时）；比离线包新就提示更新
  onSituation?: (text: string) => void;    // 在线时把情况交给助手（第一版探索会话）
};

export default function LiveField(p: FieldProps) {
  const { plan } = p;
  const tz = plan.destination?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const day = plan.days[0] ?? new Date().toISOString().slice(0, 10);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 15000); return () => window.clearInterval(t); }, []);
  const minutes = dateToLocal(new Date(now), day, tz);

  // 连通性：ReinLab 能不能连上 / 互联网有没有，分开显示
  const [reachable, setReachable] = useState(false);
  const [internet, setInternet] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setInternet(navigator.onLine);
    window.addEventListener('online', on); window.addEventListener('offline', on);
    const ping = () => p.adapter ? p.adapter.ping().then(setReachable) : setReachable(false);
    void ping(); const t = window.setInterval(() => void ping(), 20000);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', on); window.clearInterval(t); };
  }, [p.adapter]);

  const log = useFieldLog({ adapter: reachable ? p.adapter : null, accountId: p.accountId, dossierId: p.dossierId, planRevision: plan.revision, reachable });

  // 行程：已确认停留点按开拍时间；当前点 = 定位到达 / 手动选 / 按时间
  const stops = useMemo(() => plan.stops.filter(s => s.state === 'confirmed').sort((a, b) => (a.window?.start ?? '~').localeCompare(b.window?.start ?? '~')), [plan.stops]);
  const labels = stopLabels(plan);
  const [locOn, setLocOn] = useState(false);
  const loc = useFieldLocation(locOn);
  const [manual, setManual] = useState<string | null>(null);
  const byTime = stops.find(s => s.window && dateToLocal(s.window.end, day, tz) > minutes) ?? stops[stops.length - 1];
  const nextAfter = (id: string | undefined) => { const i = stops.findIndex(s => s.id === id); return i >= 0 ? stops[i + 1] ?? null : null; };
  const arrived = arrival(loc.fix, stops, byTime?.id ?? null);
  const current: Stop | undefined = stops.find(s => s.id === (manual ?? arrived.stopId ?? byTime?.id));
  const next = nextAfter(current?.id);

  // 到达：自动切换，并记一条"到了"（不等于拍到了）
  const [arrivedLogged, setArrivedLogged] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!arrived.stopId || arrivedLogged.has(arrived.stopId)) return;
    const s = stops.find(x => x.id === arrived.stopId); if (!s) return;
    setArrivedLogged(v => new Set(v).add(s.id)); setManual(null);
    void log.add({ kind: 'arrived', stopId: s.id, stopName: s.name, ...(loc.fix ? { position: { at: loc.fix.at, accuracyM: loc.fix.accuracyM } } : {}) });
  }, [arrived.stopId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 该走了：下一点开拍 − 这一段真实步行 − 5 分钟准备
  const leg = current && next ? plan.routes.find(r => r.from === current.id && r.to === next.id) : undefined;
  const leave = (() => {
    if (!next) return { text: '这是今天最后一个点', warn: false };
    if (!next.window) return { text: `${next.name} 还没定开拍时间，算不了`, warn: false };
    if (!leg?.durationS) return { text: '这一段没有真实步行路线，算不了出发时间', warn: false };
    const start = dateToLocal(next.window.start, day, tz), at = start - Math.round(leg.durationS / 60) - 5, left = at - minutes;
    return left >= 0
      ? { text: `${hm(at)} 出发（步行 ${Math.round(leg.durationS / 60)} 分 + 准备 5 分）· 还剩 ${left} 分钟`, warn: left <= 10 }
      : { text: `已经晚了 ${-left} 分钟出发，预计迟到 ${-left} 分钟到 ${next.name}`, warn: true };
  })();

  const light = current ? lightAt(current, day, tz, minutes) : null;
  const shotIds = new Set(log.items.filter(q => q.event.kind === 'shot').map(q => q.event.stopId));
  const [note, setNote] = useState('');
  const [sitOpen, setSitOpen] = useState(false);
  const [sitText, setSitText] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [mapOpen, setMapOpen] = useState(false);

  const situation = async (key: typeof SITUATIONS[number]['key'] | 'other', label: string) => {
    const text = sitText.trim();
    await log.add({ kind: 'situation', situation: key, stopId: current?.id ?? null, stopName: current?.name ?? null, text: [label, text].filter(Boolean).join('：') });
    if (reachable && p.onSituation) {
      p.onSituation(`【现场 · ${label}】当前在 ${current ? `${labels[current.id]} 号 ${current.name}` : '行程外'} · ${hm(minutes)}${text ? ` · 补充：${text}` : ''}`);
      setMsg('已交给助手，前后对照出来后点"应用"才会改计划');
    } else setMsg('现在连不上 ReinLab，助手暂时不能重排。已记成现场笔记，回去后你再决定要不要让它调整。');
    setSitText(''); setSitOpen(false);
  };

  const stale = p.offlinePack && p.serverRevision !== null && p.serverRevision > p.offlinePack.planRevision;
  const amap = current ? amapLink(...center(current), current.name) : null;
  const guidance = current ? guidanceLines(current.detail) : [];

  return <div className="exf">
    <header className="exf-status">
      <span data-ok={reachable || undefined}>ReinLab {reachable ? '可连接' : '连不上'}</span>
      <span data-ok={internet || undefined}>互联网 {internet ? '有' : '无'}</span>
      <span data-warn={log.pending > 0 || undefined}>{log.syncing ? '同步中…' : log.pending ? `待同步 ${log.pending} 条` : '已同步'}</span>
      {p.offlinePack && <span>离线包 · 第 {p.offlinePack.planRevision} 版计划 · {new Date(p.offlinePack.preparedAt).toLocaleDateString('zh-CN')} 准备</span>}
      {stale && <span data-warn>计划有新版本（第 {p.serverRevision} 版），联网时更新离线包</span>}
      {p.weather?.fetchedAt && <span>天气快照 · {new Date(p.weather.fetchedAt).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>}
    </header>

    <section className="exf-now">
      {current ? <>
        <span className="exf-kicker">现在 · {labels[current.id]} 号 · {KIND_TEXT[current.kind]}</span>
        <h2>{current.name}</h2>
        <p className="exf-window">{current.window ? `${hm(dateToLocal(current.window.start, day, tz))}–${hm(dateToLocal(current.window.end, day, tz))}` : '时段未定'}</p>
        <p className="exf-leave" data-warn={leave.warn || undefined}>{next ? `下一个：${labels[next.id]} 号 ${next.name} · ` : ''}{leave.text}</p>
      </> : <h2>今天还没有已确认的停留点</h2>}
      <div className="exf-pick">
        <select value={current?.id ?? ''} onChange={e => setManual(e.target.value || null)} aria-label="手动切换停留点">
          {stops.map(s => <option key={s.id} value={s.id}>{labels[s.id]} · {s.name}{shotIds.has(s.id) ? ' ✓' : ''}</option>)}
        </select>
        <button className="rh-btn" data-on={locOn || undefined} onClick={() => setLocOn(v => !v)}>{locOn ? '关闭定位' : '开启定位'}</button>
      </div>
      {loc.error && <p className="exf-hint">{loc.error}</p>}
      {loc.paused && <p className="exf-hint">页面在后台，定位已暂停</p>}
      {arrived.tooCoarse && <p className="exf-hint">定位误差 {Math.round(loc.fix!.accuracyM)} 米，不自动判断到达</p>}
      {arrived.ambiguous.length > 0 && <p className="exf-hint">附近有几个点：{arrived.ambiguous.map(id => <button key={id} className="dm-link" onClick={() => setManual(id)}>{labels[id]} {stops.find(s => s.id === id)?.name}</button>)}</p>}
    </section>

    {current && <section className="exf-light">
      <span className="exf-kicker">此刻的光 · {hm(minutes)}</span>
      <b data-warn={light?.blocked || undefined}>{light?.state}</b>
      <small>太阳方位 {Math.round(light?.az ?? 0)}° · 高度 {(light?.alt ?? 0).toFixed(1)}°</small>
      {current.light2 && <small>机位：{segmentNow(current.light2.camera.segments, now)}{current.light2.subject ? ` · 模特：${segmentNow(current.light2.subject.segments, now)}` : ''}</small>}
    </section>}

    {current && <section className="exf-guide">
      <span className="exf-kicker">引导词</span>
      {guidance.length === 0 ? <p className="exf-hint">这个点没有引导词</p>
        : <ol>{guidance.map(g => <li key={g.id}>{g.pose && OLD_POSES.has(g.pose) && <PoseGlyph pose={g.pose as never} />}<span>{g.text}</span></li>)}</ol>}
    </section>}

    <section className="exf-act">
      <button className="exf-big" disabled={!current} onClick={() => current && void log.add({ kind: 'arrived', stopId: current.id, stopName: current.name, ...(loc.fix ? { position: { at: loc.fix.at, accuracyM: loc.fix.accuracyM } } : {}) })}>到了</button>
      <button className="exf-big is-solid" disabled={!current} onClick={() => current && void log.add({ kind: 'shot', stopId: current.id, stopName: current.name, ...(loc.fix ? { position: { at: loc.fix.at, accuracyM: loc.fix.accuracyM } } : {}) })}>拍到了</button>
      <form className="exf-note" onSubmit={e => { e.preventDefault(); if (!note.trim()) return; void log.add({ kind: 'note', stopId: current?.id ?? null, stopName: current?.name ?? null, text: note.trim() }); setNote(''); }}>
        <input value={note} onChange={e => setNote(e.target.value)} placeholder="记一句（光、人、服饰、规定……）" aria-label="现场笔记" /><button className="rh-btn">记</button>
      </form>
      <div className="exf-row">
        <button className="rh-btn" onClick={() => setSitOpen(v => !v)}>情况变了</button>
        {amap ? <a className="rh-btn" href={amap} target="_blank" rel="noreferrer">用高德打开</a> : current && <span className="exf-hint">境外地点不提供高德链接</span>}
        <button className="rh-btn exf-mapbtn" onClick={() => setMapOpen(v => !v)}>{mapOpen ? '收起地图' : '地图'}</button>
      </div>
      {sitOpen && <div className="exf-sit">
        <div>{SITUATIONS.map(s => <button key={s.key} className="exf-big" onClick={() => void situation(s.key, s.label)}>{s.label}</button>)}</div>
        <input value={sitText} onChange={e => setSitText(e.target.value)} placeholder="补一句（可以用键盘语音输入）" aria-label="情况补充" />
        {sitText.trim() && <button className="rh-btn is-solid" onClick={() => void situation('other', '情况')}>只发这句</button>}
      </div>}
      {msg && <p className="exf-hint" role="status">{msg}</p>}
    </section>

    <section className="exf-map" data-open={mapOpen || undefined}>
      {p.mapCfg ? <LiveMap cfg={p.mapCfg} plan={plan} canvas={[]} basemap="vector" selected={current?.id ?? null} onSelect={id => setManual(id)}
        day={day} tz={tz} minutes={minutes} horizonAlt={() => null} initialView={null} camera={null} following={false} onFollow={() => {}} onBasemap={() => {}}
        onView={() => {}} onMapClick={() => {}} me={loc.fix ? { at: loc.fix.at, accuracyM: loc.fix.accuracyM } : null} />
        : <p className="exf-hint">地图没准备好</p>}
    </section>

    <section className="exf-log">
      <span className="exf-kicker">今天的清单</span>
      <ul className="exf-check">{stops.map(s => <li key={s.id} data-done={shotIds.has(s.id) || undefined}><b>{labels[s.id]}</b>{s.name}<small>{s.window ? hm(dateToLocal(s.window.start, day, tz)) : '—'}</small></li>)}</ul>
      <span className="exf-kicker">现场记录 · {log.items.length}</span>
      <ul className="exf-records">{[...log.items].reverse().slice(0, 30).map(q => <li key={q.clientId} data-state={q.state}>
        <small>{q.event.at.slice(11, 16)}</small><b>{{ arrived: '到了', shot: '拍到了', note: '笔记', situation: '情况', correction: '更正' }[q.event.kind]}</b>
        <span>{q.event.stopName ?? '行程外'}{q.event.text ? ` · ${q.event.text}` : ''}</span>
        <em>{q.state === 'pending' ? '待同步' : q.state === 'synced' ? '' : q.note}</em>
        {q.state === 'attention' && q.note?.includes('重新关联') && <select defaultValue="" onChange={e => { if (!e.target.value) return; const s = stops.find(x => x.id === e.target.value)!; void log.add({ kind: 'correction', refersTo: q.clientId, correction: { action: 'relink', stopId: s.id }, stopId: s.id, stopName: s.name }); }}>
          <option value="">重新关联到…</option>{stops.map(s => <option key={s.id} value={s.id}>{labels[s.id]} {s.name}</option>)}</select>}
      </li>)}</ul>
      {log.error && <p className="exf-hint">{log.error}</p>}
      {p.adapter && reachable && <OfflinePrep adapter={p.adapter} accountId={p.accountId} dossierId={p.dossierId} title={p.title} days={plan.days} />}
    </section>
  </div>;
}

function segmentNow(segments: { start: string; end: string; state: string }[], now: number) {
  const s = segments.find(x => Date.parse(x.start) <= now && now < Date.parse(x.end));
  return s ? ({ night: '夜', terrain: '被山挡', building: '被楼挡', maybe_lit: '预计有光', unknown: '未知' } as Record<string, string>)[s.state] ?? s.state : '未知';
}
