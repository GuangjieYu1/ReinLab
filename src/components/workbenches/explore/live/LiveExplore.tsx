import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import BenchFrame from '../../BenchFrame';
import AgentDock, { type DockEvent } from '../../AgentDock';
import Explorer, { type ExplorerSection, type ExplorerViewDef } from '../../engineering/Explorer';
import { RichBlocks } from '../../richText';
import type { BenchProps } from '../../WorkbenchStudio';
import type { Basemap, LngLat, PendingChange, PlanUsage, Profile, Stop, Viewport, WeatherSuggestion, WeatherView } from '../../../../../packages/contracts/src/explore';
import { ExploreError, type ChatItem, type ExploreAdapter, type MapConfig, type Place } from './adapter';
import { useExplore } from './state';
import LiveMap from './LiveMap';
import LiveDayLine from './LiveDayLine';
import { StopAside, StopCard, StopDetail, KIND_TEXT, RefTile } from './StopPanel';
import BookView from './BookView';
import ProfilesPanel from './ProfilesPanel';
import { renderSnapshot, neededKeys } from './snapshots';
import { center, stopLabels } from './overlays';
import { dateToLocal, dayLight, hm, horizonAt } from './sunlive';
import '../../engineering/dev.css';
import '../explore.css';
import './live.css';

// 探索台真实模式（design/prd/06-explore.md、07-explore-contract.md）。
// 计划面：真实地图 + 时间线 + 计划书；机位面：选中停留点详情（不含白模）；现场 / 回顾第一版置灰。
// 地图、对话候选卡、时间线读同一份计划；页面点击即授权，Agent 改已确认内容走审批卡。

type Face = 'plan' | 'spot' | 'field' | 'review';
const VIEWS: ExplorerViewDef[] = [
  { id: 'plan', label: '计划与停留点', icon: <svg viewBox="0 0 24 24"><path d="M12 21s-6-6.5-6-11a6 6 0 0 1 12 0c0 4.5-6 11-6 11z" /><circle cx="12" cy="10" r="2" /></svg> },
  { id: 'profiles', label: '资料', icon: <svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.5" /><path d="M5 20c1-4 4-6 7-6s6 2 7 6" /></svg> },
];
const browserTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const FIELD: Record<string, string> = { name: '名称', kind: '类型', geometry: '位置', day: '日期', window: '时段', reason: '理由', facing: '朝向', focal: '焦段', detail: '细节', refs: '参考' };

export default function LiveExplore({ file, reduced, chrome, dossier, adapter }: BenchProps & { adapter: ExploreAdapter }) {
  const x = useExplore(adapter);
  const [face, setFace] = useState<Face>('plan');
  const [view, setView] = useState<'map' | 'doc'>('map');
  const [variant, setVariant] = useState<'brief' | 'full'>('brief');
  const [sel, setSel] = useState<string | null>(null);
  const [dayIdx, setDayIdx] = useState(0);
  const [t, setT] = useState(12 * 60);
  const [basemap, setBasemap] = useState<Basemap>('vector');
  const [following, setFollowing] = useState(true);
  const [cfg, setCfg] = useState<MapConfig | null>(null);
  const [cfgErr, setCfgErr] = useState<string | null>(null);
  const [weather, setWeather] = useState<WeatherView | null>(null);
  const [sugs, setSugs] = useState<WeatherSuggestion[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [usage, setUsage] = useState<PlanUsage | null>(null);
  const [showUsage, setShowUsage] = useState(false);
  const [chat, setChat] = useState<ChatItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [attach, setAttach] = useState<{ id: string; src: string }[]>([]);
  const [pop, setPop] = useState<{ at: LngLat; x: number; y: number } | null>(null);
  const [pdf, setPdf] = useState<{ variant: 'brief' | 'full'; state: 'working' | 'done' | 'failed'; text: string } | null>(null);
  const [tzAsk, setTzAsk] = useState<string | null>(null);
  const [xpOpen, setXpOpen] = useState(true), [xpView, setXpView] = useState('plan');
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Place[] | null>(null);
  const [focus, setFocus] = useState<{ at: LngLat; n: number } | null>(null);
  const lastView = useRef<Viewport | null>(null);
  const plan = x.snap?.plan;
  const tz = plan?.destination?.timezone ?? browserTz();
  const day = plan?.days[dayIdx] ?? plan?.days[0] ?? new Date().toISOString().slice(0, 10);
  const stop = plan?.stops.find(s => s.id === sel);

  // 初始化：地图配置、天气、资料、建议、用量；首次进来按上次视野 / 底图
  useEffect(() => { adapter.mapConfig().then(setCfg, e => setCfgErr(e instanceof Error ? e.message : '地图配置读取失败')); }, [adapter]);
  const loadWeather = () => adapter.weather().then(setWeather, () => setWeather(w => w ?? { state: 'failed', byStop: [], destination: null, fetchedAt: null, source: { name: '—' }, nextCheckAt: null }));
  useEffect(() => { void loadWeather(); adapter.profiles().then(setProfiles, () => {}); adapter.suggestions().then(setSugs, () => {}); }, [adapter]); // eslint-disable-line react-hooks/exhaustive-deps
  const seeded = useRef(false);
  useEffect(() => { if (x.snap && !seeded.current) { seeded.current = true; setBasemap(x.snap.basemap); } }, [x.snap]);
  // 选中停留点时把播放头移到它的时段中间
  useEffect(() => { if (stop?.window) setT(Math.round((dateToLocal(stop.window.start, day, tz) + dateToLocal(stop.window.end, day, tz)) / 2)); }, [sel]); // eslint-disable-line react-hooks/exhaustive-deps
  // 已确认停留点变了，天气也要按新位置重取
  // 目的地、日期、停留点（含候选）变了都重取：一开始没目的地时取到的是失败
  const stopKey = `${plan?.state}|${plan?.destination?.name ?? ''}|${plan?.days.join() ?? ''}|${plan?.stops.map(s => s.id + s.state + s.day).join() ?? ''}`;
  useEffect(() => { if (plan) void loadWeather(); }, [stopKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // 天气 / 计划书 / 快照请求事件
  const handled = useRef(0);
  useEffect(() => {
    for (const ev of x.events.slice(handled.current)) {
      if (ev.type === 'explore.weather') { void loadWeather(); adapter.suggestions().then(setSugs, () => {}); }
      if (ev.type === 'explore.book') setPdf(p => ({ variant: p?.variant ?? 'brief', state: ev.state, text: ev.state === 'done' ? '已生成，在档案菜单「成果」里打开' : `没生成：${ev.message ?? '原因未知'}` }));
      if (ev.type === 'explore.snapshots_needed' && cfg && x.snap && ev.revision === x.snap.plan.revision) void uploadSnapshots(ev.keys, ev.revision);
    }
    handled.current = x.events.length;
  }, [x.events]); // eslint-disable-line react-hooks/exhaustive-deps

  // 对话
  const session = useMemo(() => adapter.chat((items, b) => { setChat([...items]); setBusy(b); }), [adapter]);
  useEffect(() => { void session.load().catch(() => {}); return () => session.stop(); }, [session]);
  const send = (text: string) => {
    setErr(null);
    const refIds = attach.map(a => a.id); setAttach([]);
    void session.send(text, refIds).catch(e => { setBusy(false); setErr(e instanceof Error ? e.message : '没有发出去'); });
  };

  // 参考图：粘贴 / 拖进对话区就上传，随下一句发出
  const addFiles = async (files: FileList | File[]) => {
    for (const f of Array.from(files).filter(f => f.type.startsWith('image/'))) {
      try { const r = await adapter.uploadRef(f, 'style'); setAttach(a => [...a, { id: r.id, src: r.image?.src ?? URL.createObjectURL(f) }]); void x.reload(); }
      catch (e) { setErr(e instanceof Error ? e.message : '图片没传上去'); }
    }
  };

  // 地点搜索：带上地图中心（服务端要按附近找；国内走高德）
  const search = async () => {
    if (!q.trim()) return;
    const near = lastView.current?.center ?? plan?.destination?.center;
    try { setFound(await adapter.places(q.trim(), near)); }
    catch (e) { setFound(null); setErr(e instanceof Error ? e.message : '没搜到'); }
  };
  // —— 页面动作（点击即授权）——
  const keep = (id: string) => void x.run([{ op: 'stop.confirm', ids: [id] }], s => s.plan.stops.some(st => st.id === id && st.state === 'candidate'));
  const drop = (id: string) => void x.run([{ op: 'stop.remove', id }], s => s.plan.stops.some(st => st.id === id));
  const confirmAll = async () => {
    const cur = await adapter.timezone().catch(() => null);
    if (!cur) { setTzAsk(browserTz()); return; }
    void x.run([{ op: 'plan.confirm' }], s => s.plan.state === 'draft');
  };
  const decide = async (approvalId: string, approve: boolean) => {
    try { await adapter.decide(approvalId, approve); await x.reload(); adapter.suggestions().then(setSugs, () => {}); }
    catch (e) { setErr(e instanceof Error ? e.message : '没有成功'); }
  };

  // 计划书 PDF：先补齐本修订缺的快照，再生成
  async function uploadSnapshots(keys: string[], revision: number) {
    if (!cfg || !x.snap) return;
    for (const k of keys) { const png = await renderSnapshot(cfg, x.snap.plan, k); await adapter.uploadSnapshot(k, revision, png, cfg.vector.attribution); }
  }
  const makePdf = async (v: 'brief' | 'full') => {
    if (!plan || !cfg) return;
    setPdf({ variant: v, state: 'working', text: '正在准备地图…' });
    try {
      try { await adapter.book(v, plan.revision); }
      catch (e) {
        if (!(e instanceof ExploreError && e.code === 'NEEDS_MAP_SNAPSHOTS')) throw e;
        const keys = ((e.detail as { keys?: string[] })?.keys) ?? neededKeys(plan, v);
        await uploadSnapshots(keys, plan.revision);
        await adapter.book(v, plan.revision);
      }
      setPdf({ variant: v, state: 'working', text: '正在生成 PDF…' });
    } catch (e) { setPdf({ variant: v, state: 'failed', text: e instanceof Error ? e.message : '没生成' }); }
  };

  const lastUser = [...chat].reverse().find((c): c is Extract<ChatItem, { kind: 'user' }> => c.kind === 'user')?.text;
  // —— 对话 + 操作记录：按出现先后排在一起 ——
  const order = useRef(new Map<string, number>()), seq = useRef(0);
  const seen = (id: string) => { if (!order.current.has(id)) order.current.set(id, seq.current++); return order.current.get(id)!; };
  const approvalOf = (c: PendingChange): DockEvent => ({ id: `ap:${c.approvalId}`, kind: 'approval', action: '修改计划', title: c.summary, risk: 'write', state: 'pending',
    effects: c.changes.map(ch => {
      const name = (ch as { stopName?: string }).stopName ?? plan?.stops.find(s => s.id === ch.stopId)?.name ?? (ch.after as Partial<Stop> | null)?.name ?? ch.stopId;
      if (ch.after === null) return `删除「${name}」`;
      if (ch.before === null) return `新增「${name}」`;
      // 只列真正变了的：状态从候选到已确认写成「确认」
      const keys = Object.keys(ch.after).filter(k => JSON.stringify((ch.before as Record<string, unknown>)[k]) !== JSON.stringify((ch.after as Record<string, unknown>)[k]));
      const parts = keys.map(k => k === 'state' ? ((ch.after as Partial<Stop>).state === 'confirmed' ? '确认' : '改为候选') : FIELD[k] ?? k);
      return parts.length ? `${parts.includes('确认') && parts.length === 1 ? '确认' : '改'}「${name}」${parts.length === 1 && parts[0] === '确认' ? '' : '：' + parts.join('、')}` : `「${name}」没有变化`;
    }),
    onApprove: () => void decide(c.approvalId, true), onReject: () => void decide(c.approvalId, false) });
  const events: DockEvent[] = useMemo(() => {
    if (!plan) return [];
    const out: [number, DockEvent][] = [];
    for (const c of chat) {
      const n = seen(`c:${c.id}`);
      if (c.kind === 'user') out.push([n, { id: c.id, kind: 'user', text: c.text, at: '' }]);
      else if (c.kind === 'agent') out.push([n, { id: c.id, kind: 'agent', text: <RichBlocks text={c.text} />, at: '' }]);
      else if (c.kind === 'note') out.push([n, { id: c.id, kind: 'note', text: c.text, at: '' }]);
      else if (c.kind === 'malformed') out.push([n, { id: c.id, kind: 'card', body: <div className="exl-malformed"><span>这一轮助手的工具参数没写对，什么都没改。</span>{lastUser && <button className="rh-btn" disabled={busy} onClick={() => send(lastUser)}>重试</button>}</div> }]);
      else if (c.kind === 'tool') { if (c.name) out.push([n, { id: c.id, kind: 'tool', action: c.name, label: c.label, state: c.state }]); }
      else if (c.kind === 'pending') out.push([n, approvalOf(c.change)]);
      else if (c.kind === 'refs') out.push([n, { id: c.id, kind: 'card', body: <div className="exl-refs is-chat">{x.snap!.refs.filter(r => c.refIds.includes(r.id)).map(r => <RefTile key={r.id} r={r} />)}</div> }]);
      else if (c.kind === 'stops') out.push([n, { id: c.id, kind: 'card', body: <div className="exl-stops">{c.stopIds.map(id => plan.stops.find(s => s.id === id)).filter((s): s is Stop => !!s)
        .map(s => <StopCard key={s.id} plan={plan} stop={s} tz={tz} compact onKeep={() => keep(s.id)} onDrop={() => drop(s.id)} onOpen={() => { setSel(s.id); setFace('spot'); }} />)}
        {c.stopIds.every(id => !plan.stops.some(s => s.id === id)) && <small className="exl-unk">这些候选已经不在计划里了</small>}</div> }]);
    }
    for (const l of x.log) out.push([seen(`l:${l.id}`), { id: `l:${l.id}`, kind: 'note', text: `${l.actor === 'agent' ? '助手' : '你'} · ${l.text}`, at: '' }]);
    for (const p of x.pending) out.push([seen(`p:${p.approvalId}`), approvalOf(p)]);
    return out.sort((a, b) => a[0] - b[0]).map(e => e[1]);
  }, [chat, x.log, x.pending, plan, busy]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!x.snap || !plan) return <BenchFrame code="EXPL" section="006" file={file} reduced={reduced} chrome={chrome} face="plan" onFace={() => {}} faces={[{ id: 'plan', label: '计划', en: 'PLAN' }]} strip={<>读取中</>} status={<span>读取中</span>} shutterLines={() => ['> open plan', '> ready']}>
    <div className="de"><p>{x.error ?? '正在读取计划…'}</p>{x.error && <button className="rh-btn" onClick={() => void x.reload()}>重试</button>}</div>
  </BenchFrame>;

  const labels = stopLabels(plan);
  const confirmed = plan.stops.filter(s => s.state === 'confirmed').sort((a, b) => (a.window?.start ?? '~').localeCompare(b.window?.start ?? '~'));
  const candidates = plan.stops.filter(s => s.state === 'candidate');
  const at = stop ? center(stop) : plan.destination?.center;
  const dl = at ? dayLight(day, tz, at[0], at[1]) : null;
  const wxHours = weather ? (weather.byStop.length ? weather.byStop.flatMap(g => g.hours) : weather.destination?.hours ?? []) : [];
  const rainy = wxHours.filter(h => (h.precipProb ?? 0) >= 40 && h.at.slice(0, 10) === day);
  const hasPeople = plan.people.length > 0 || plan.kinds.includes('portrait');
  const pendingSug = sugs.filter(s => s.state === 'pending');
  const stateText = { draft: '草拟', ready: '待执行', finished: '已结束', cancelled: '已取消' }[plan.state];

  const sections: ExplorerSection[] = xpView === 'profiles' ? [
    { id: 'm', title: '模特', count: profiles.filter(p => p.type === 'model').length, body: <ProfilesPanel type="model" items={profiles.filter(p => p.type === 'model')} plan={plan} {...profileHandlers('people')} /> },
    { id: 'g', title: '器材', count: profiles.filter(p => p.type === 'gear').length, grow: true, body: <ProfilesPanel type="gear" items={profiles.filter(p => p.type === 'gear')} plan={plan} {...profileHandlers('gear')} /> },
  ] : [
    { id: 'stops', title: '停留点', count: plan.stops.length, grow: true, body: <div className="ex-list">
      {confirmed.map(s => <button key={s.id} aria-current={s.id === sel || undefined} onClick={() => setSel(s.id)}><em>{labels[s.id]}</em><span><b>{s.name}</b><small>{KIND_TEXT[s.kind]} · {s.window ? `${hm(dateToLocal(s.window.start, s.day, tz))}` : '时段未定'}</small></span></button>)}
      {candidates.length > 0 && <small className="exl-xp-sub">候选 · {candidates.length}</small>}
      {candidates.map(s => <button key={s.id} data-cand aria-current={s.id === sel || undefined} onClick={() => setSel(s.id)}><em>{labels[s.id]}</em><span><b>{s.name}</b><small>{KIND_TEXT[s.kind]} · 候选</small></span></button>)}
      {plan.stops.length === 0 && <p className="dm-empty">还没有停留点。在右边和助手说说想去哪拍、什么时候、想要什么感觉。</p>}
    </div> },
    { id: 'feel', title: '想要的感觉', body: plan.feel ? <ul className="exl-feel">{plan.feel.observations.map((o, i) => <li key={i}>{o.text}</li>)}{plan.feel.guesses.map((g, i) => <li key={`g${i}`}>{g.text} <em className="exl-unk">推测</em></li>)}</ul>
      : <p className="dm-empty">把参考图拖进右边对话框，助手读完会整理在这里。</p> },
    { id: 'refs', title: '参考', count: x.snap.refs.length, body: <div className="exl-refs is-xp">{x.snap.refs.map(r => <RefTile key={r.id} r={r} />)}</div> },
  ];
  function profileHandlers(slot: 'people' | 'gear') {
    const ids = (slot === 'people' ? plan!.people : plan!.gear).map(s => s.profileId);
    return {
      onSave: async (p: Parameters<ExploreAdapter['saveProfile']>[0]) => { await adapter.saveProfile(p); setProfiles(await adapter.profiles()); },
      onDelete: async (id: string) => { await adapter.deleteProfile(id); setProfiles(await adapter.profiles()); },
      onToggle: (id: string, on: boolean) => void x.run([{ op: 'plan.select', [slot]: on ? [...ids, id] : ids.filter(i => i !== id) }]),
      onRefresh: (id: string) => void x.run([{ op: 'plan.select', [slot]: ids, refresh: true }], s => (slot === 'people' ? s.plan.people : s.plan.gear).some(g => g.profileId === id)),
    };
  }

  const head = <header className="ex-head">
    <span className="ex-id">EXPL</span>
    <div className="ex-title"><strong>{dossier?.title ?? '探索计划'}</strong>
      <span>{plan.destination?.name ?? '目的地未定'} <i>·</i> {plan.days.length > 1 ? <select className="exl-day" value={dayIdx} onChange={e => setDayIdx(Number(e.target.value))}>{plan.days.map((d, i) => <option key={d} value={i}>{d}</option>)}</select> : (plan.days[0] ?? '日期未定')} <i>·</i> {stateText} <i>·</i> 第 {plan.revision} 版</span></div>
    <ul className="ex-facts">
      <li><small>傍晚金色时刻</small><b>{dl?.goldPm ? `${hm(dl.goldPm[0])}–${hm(dl.goldPm[1])}` : '—'}</b></li>
      <li data-alert={rainy.length > 0 || undefined}><small>降水风险</small><b>{weather?.state === 'out_of_range' ? '未进入预报' : rainy.length ? `${hm(dateToLocal(rainy[0].at, day, tz))} ${rainy[0].precipProb}%` : weather?.state === 'ok' ? '低' : '未知'}</b></li>
      <li><small>下次天气检查</small><b>{plan.state === 'ready' && weather?.nextCheckAt ? new Date(weather.nextCheckAt).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}</b></li>
    </ul>
    <div className="ex-seg"><button aria-pressed={view === 'map'} onClick={() => setView('map')}>地图</button><button aria-pressed={view === 'doc'} onClick={() => setView('doc')}>计划书</button></div>
    {plan.state === 'draft' && <button className="ex-go" disabled={plan.stops.length === 0} onClick={() => void confirmAll()}><i />确认整份计划</button>}
    <button className="rh-btn exl-usage-btn" onClick={() => { setShowUsage(v => !v); adapter.usage().then(setUsage, () => setUsage(null)); }}>用量</button>
  </header>;

  const mapArea = cfg ? <div className="ex-mapwrap exl-mapwrap">
    <LiveMap cfg={cfg} plan={plan} canvas={x.snap.canvas} basemap={basemap} selected={sel} onSelect={id => { setSel(id); setPop(null); }}
      day={day} tz={tz} minutes={t} horizonAlt={(id, az) => horizonAt(plan.stops.find(s => s.id === id)?.light?.horizon, az)} initialView={x.snap.lastViewport} camera={x.camera}
      following={following} onFollow={setFollowing} onBasemap={b => setBasemap(b)}
      focus={focus} onView={(v: Viewport) => { lastView.current = v; adapter.saveView(v, basemap); }} onMapClick={(at, s) => setPop({ at, x: s.x, y: s.y })} />
    <div className="exl-maptools">
      {cfg.satellite && cfg.basemaps?.satellite !== false && <div className="ex-seg"><button aria-pressed={basemap === 'vector'} onClick={() => setBasemap('vector')}>矢量</button><button aria-pressed={basemap === 'satellite'} title="历史影像，不是实时" onClick={() => setBasemap('satellite')}>卫星</button></div>}
      <form className="exl-search" onSubmit={e => { e.preventDefault(); void search(); }}>
        <input value={q} onChange={e => { setQ(e.target.value); if (!e.target.value) setFound(null); }} placeholder="搜地点" aria-label="搜地点" />
        {found && <ul>{found.length === 0 ? <li className="dm-empty">没找到</li> : found.map((f, i) => <li key={i}><button type="button" onClick={() => { setFocus(v => ({ at: f.at, n: (v?.n ?? 0) + 1 })); setFound(null); }}><b>{f.name}</b><small>{f.address ?? ''} · {f.source.name}</small></button></li>)}</ul>}
      </form>
      {!following && <button className="rh-btn is-solid" onClick={() => setFollowing(true)}>跟随助手</button>}
      {x.snap.canvas.length > 0 && <button className="rh-btn" title="撤回最近一笔画布改动（包括助手画的）" onClick={() => void x.run([{ op: 'canvas.undo' }])}>撤回草图</button>}
    </div>
    {basemap === 'satellite' && <span className="exl-satnote">卫星图为历史影像</span>}
    {pop && <div className="exl-pop" data-up={pop.y > 240 || undefined} style={{ left: pop.x, top: pop.y }} onPointerDown={e => e.stopPropagation()}>
      <small>{pop.at[1].toFixed(5)}, {pop.at[0].toFixed(5)}</small>
      <button className="rh-btn is-solid" onClick={() => { send(`这里（${pop.at[1].toFixed(5)}, ${pop.at[0].toFixed(5)}）几点拍最好？`); setPop(null); }}>问助手：这里几点拍最好</button>
      <button className="rh-btn" onClick={() => { const text = window.prompt('笔记内容'); if (text) void x.run([{ op: 'canvas.add', object: { kind: 'note', geometry: { type: 'Point', coordinates: pop.at }, text } }]); setPop(null); }}>在这里加笔记</button>
      <button className="dm-link" onClick={() => setPop(null)}>关闭</button>
    </div>}
    {stop && <StopAside plan={plan} stop={stop} day={day} tz={tz} minutes={t} weather={weather} refs={x.snap.refs} onKeep={() => keep(stop.id)} onDrop={() => { drop(stop.id); setSel(null); }} onOpen={() => setFace('spot')} />}
  </div> : <div className="ex-mapwrap exl-mapwrap"><div className="de"><p>{cfgErr ?? '地图读取中…'}</p></div></div>;

  const banners: ReactNode = <div className="exl-banners">
    {pendingSug.map(s => <div key={s.id} className="exl-sug">
      <b>天气变了：{s.summary}</b>
      <ul>{s.changes.map(c => { const n = c.stopName ?? plan.stops.find(x => x.id === c.stopId)?.name ?? c.stopId; return <li key={c.stopId}><b>{n}</b>：{c.why}<small>{Object.keys(c.after).map(k => `${k} ${JSON.stringify((c.before as Record<string, unknown>)[k] ?? '—')} → ${JSON.stringify((c.after as Record<string, unknown>)[k])}`).join('；')}</small></li>; })}</ul>
      <div><button className="rh-btn is-solid" onClick={() => void decide(s.id, true)}>应用</button><button className="rh-btn" onClick={() => void decide(s.id, false)}>不用</button></div>
    </div>)}
    {x.notice && <p className="dm-msg exl-notice" role="status">{x.notice}<button className="dm-link" onClick={() => x.setNotice(null)}>知道了</button></p>}
    {plan.conflicts.length > 0 && <p className="dm-msg exl-notice">{plan.conflicts.map(c => c.text).join('；')}</p>}
  </div>;

  return <BenchFrame code="EXPL" section="006" file={file} reduced={reduced} chrome={chrome} face={face} onFace={id => { if (id === 'plan' || id === 'spot') setFace(id); }}
    faces={[{ id: 'plan', label: '计划', en: 'PLAN' }, { id: 'spot', label: '机位', en: 'SPOT', badge: confirmed.length || undefined }, { id: 'field', label: '现场 · 下一版', en: 'FIELD', locked: true }, { id: 'review', label: '回顾 · 下一版', en: 'REVIEW', locked: true }]}
    strip={<>{plan.destination?.name ?? '目的地未定'} <i>·</i> {day} <i>·</i> {dl?.sunrise != null ? `日出 ${hm(dl.sunrise)}` : ''} <i>·</i> {dl?.sunset != null ? `日落 ${hm(dl.sunset)}` : ''} <i>·</i> {confirmed.length} 个已确认 · {candidates.length} 个候选</>}
    shutterLines={f => [`> open plan · ${plan.destination?.name ?? 'new'}`, `> ${f.en.toLowerCase()} · rev ${plan.revision}`, '> ready']}
    status={<><span><i className="en-sq" />{dossier?.title ?? '探索计划'}</span><span>{stateText}</span><span>已确认 {confirmed.length}</span><span>候选 {candidates.length}</span><span>太阳为真实计算 · 天气 {weather?.source.name ?? '—'}</span></>}>
    <div className="ex" data-face={face}>
      <Explorer code="EXPL" open={xpOpen} view={xpView} onView={setXpView} onToggle={() => setXpOpen(v => !v)} views={VIEWS} key={xpView} title="plan/" sections={sections} />
      {face === 'plan' ? <div className="ex-center ex-plan exl-plan" data-view={view}>
        {head}
        {banners}
        {view === 'map' ? mapArea : <BookView plan={plan} title={dossier?.title ?? '探索计划'} refs={x.snap.refs} weather={weather} variant={variant} onVariant={setVariant} onPdf={v => void makePdf(v)} pdfState={pdf} />}
        <LiveDayLine plan={plan} day={day} tz={tz} selected={sel} onSelect={setSel} t={t} onT={setT} weather={weather} />
      </div>
      : stop ? <StopDetail plan={plan} stop={stop} day={day} tz={tz} minutes={t} refs={x.snap.refs} hasPeople={hasPeople} />
      : <div className="ex-center"><div className="de"><p>先在计划面的地图或左边列表里选一个停留点。</p></div></div>}
      <div className="exl-dock" onPaste={e => { if (e.clipboardData.files.length) { e.preventDefault(); void addFiles(e.clipboardData.files); } }}
        onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }} onDrop={e => { if (e.dataTransfer.files.length) { e.preventDefault(); void addFiles(e.dataTransfer.files); } }}>
        <AgentDock name="旅拍搭档" target={plan.destination?.name ?? (dossier?.title ?? '新计划')}
          plan={{ stages: ['说需求', '排停留点', '确认', '计划书'], current: plan.state !== 'draft' ? 3 : confirmed.length ? 2 : plan.stops.length ? 1 : 0 }}
          suggestions={[
            { id: 'feel', label: '我贴几张参考图', fill: '这是我想要的感觉：' },
            ...(stop ? [{ id: 'when', label: `「${stop.name}」几点拍最好`, onClick: () => send(`「${stop.name}」几点拍最好？`) }] : []),
            { id: 'weather', label: '天气会影响哪些点', onClick: () => send('现在的预报会影响哪些停留点？') },
          ]}
          events={events} busy={busy} onSend={send}
          placeholder="说说想去哪、哪天、拍什么；图片可以直接粘贴或拖进来"
          footnote="页面上点的直接生效 · 助手改已确认的内容会先问你" />
        {attach.length > 0 && <div className="exl-attach">{attach.map(a => <span key={a.id}><img src={a.src} alt="" /><button aria-label="移除" onClick={() => setAttach(l => l.filter(y => y.id !== a.id))}>×</button></span>)}<small>{attach.length} 张参考图，随下一句发给助手</small></div>}
        {err && <p className="dm-msg exl-err" role="alert">{err}</p>}
      </div>
      {tzAsk !== null && <div className="exl-modal" role="dialog" aria-label="确认整份计划"><div>
        <b>确认整份计划</b>
        <p>确认后所有候选都变成已确认，计划进入待执行，后台每天按你所在时区的 08:00 / 16:00 / 23:00 检查天气。</p>
        <label>你所在的时区<input value={tzAsk} onChange={e => setTzAsk(e.target.value)} /></label>
        <div><button className="rh-btn is-solid" onClick={() => { const z = tzAsk; setTzAsk(null); void adapter.setTimezone(z).then(() => x.run([{ op: 'plan.confirm' }], s => s.plan.state === 'draft'), e => setErr(e instanceof Error ? e.message : '时区没保存')); }}>确认</button><button className="rh-btn" onClick={() => setTzAsk(null)}>取消</button></div>
      </div></div>}
      {showUsage && <div className="exl-usage" role="dialog" aria-label="本计划用量"><b>本计划用量</b>
        {!usage ? <p>读取中…</p> : <>
          <table><thead><tr><th>用途</th><th>调用</th><th>输入</th><th>输出</th></tr></thead><tbody>{usage.byPurpose.map(u => <tr key={u.purpose}><td>{{ planning: '计划编排', vision: '看图', weather_judge: '天气判断', weather_adjust: '天气调整' }[u.purpose]}</td><td>{u.calls}</td><td>{u.input ?? '未知'}</td><td>{u.output ?? '未知'}</td></tr>)}</tbody></table>
          <table><thead><tr><th>模型</th><th>输入</th><th>输出</th></tr></thead><tbody>{usage.byModel.map(u => <tr key={u.model}><td>{u.model}</td><td>{u.input ?? '未知'}</td><td>{u.output ?? '未知'}</td></tr>)}</tbody></table>
          {usage.tools.length > 0 && <p>{usage.tools.map(u => `${u.name} ${u.calls} 次${u.costCny != null ? ` · ¥${u.costCny}` : ''}`).join('；')}</p>}
          {usage.unknownCalls > 0 && <p className="exl-unk">另有 {usage.unknownCalls} 次调用用量未知</p>}
        </>}
        <button className="rh-btn" onClick={() => setShowUsage(false)}>关闭</button></div>}
    </div>
  </BenchFrame>;
}

