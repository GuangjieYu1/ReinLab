import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CheckRun, CreativeConflict, CreativeOp, CreativeRouteLeg, Fix, LngLat, Proposal, Track, Work, WorldSnapshot,
} from '../../../../../packages/contracts/src/creative';
import BenchFrame from '../../BenchFrame';
import Explorer, { Tree, type ExplorerSection, type ExplorerView } from '../../engineering/Explorer';
import type { BenchProps } from '../../WorkbenchStudio';
import type { MapConfig } from '../../explore/live/adapter';
import { CreativeError, type CreativeAdapter, type EditFeatures } from './adapter';
import { bucketOf, positionsAt, type Pos } from './geo';
import LiveNovel from './LiveNovel';
import { CreativeAssistant } from './NovelPanels';
import WorldMap, { type DrawMode, type MapPick } from './WorldMap';
import StoryTimeline from './StoryTimeline';
import { CheckPanel, Detail, KIND_ZH, ProposalList, submitChunks, type Sel } from './Panels';
import { EditForm, EntityForm, EventForm, ModeForm, RuleForm, type DrawReq, type FormKind } from './Forms';
import '../../engineering/dev.css';
import '../creative.css';
import './live.css';

type Tab = 'check' | 'props' | 'detail' | 'form' | 'assistant';
const EMPTY_FC: EditFeatures = { type: 'FeatureCollection', features: [] };

/** 创作台真实模式 · 世界观面（20-creative-contract.md §4）。小说面接 1B，视频留到 MVP-3。 */
export default function LiveWorld({ adapter, file, reduced, chrome, dossier }: BenchProps & { adapter: CreativeAdapter }) {
  const [works, setWorks] = useState<Work[]>([]);
  useEffect(() => { void adapter.works().then(setWorks).catch(() => {}); }, [adapter]);
  const [voided, setVoided] = useState<Proposal[]>([]);
  const [face, setFace] = useState<'world' | 'novel'>('world');
  const [novelTarget, setNovelTarget] = useState<{ workId: string; chapterId?: string; sceneId?: string }>();
  const [snap, setSnap] = useState<WorldSnapshot | null>(null), [loadErr, setLoadErr] = useState<string | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);        // 正在只读查看的历史版本
  const [cfg, setCfg] = useState<MapConfig | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]), [trackLegs, setTrackLegs] = useState<CreativeRouteLeg[]>([]);
  const [t, setT] = useState(0), [edits, setEdits] = useState<EditFeatures>(EMPTY_FC);
  const [sel, setSel] = useState<Sel | null>(null), [selConfRaw, setSelConf] = useState<CreativeConflict | null>(null);
  const [tab, setTab] = useState<Tab>('check'), [form, setForm] = useState<FormKind | null>(null);
  const [draw, setDraw] = useState<DrawMode | null>(null);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState<string | null>(null);
  const [cost, setCost] = useState<{ value: number | null; known: boolean } | null>(null);
  const [focus, setFocus] = useState<{ coords: LngLat[]; n: number } | null>(null);
  const bbox = useRef<[number, number, number, number] | null>(null);
  const [xpOpen, setXpOpen] = useState(true), [xpView, setXpView] = useState<ExplorerView>('files');
  const [verName, setVerName] = useState(''), [netMsg, setNetMsg] = useState<string | null>(null);
  const snapRef = useRef(snap); snapRef.current = snap;
  useEffect(() => { void adapter.proposals({ kind: 'route', status: 'rejected', limit: '20' }).then(r => setVoided(r.proposals.filter(p => p.resolution?.by === 'agent'))).catch(() => {}); }, [adapter, snap?.world.revision]);
  const readOnly = viewing != null;

  // ── 取数 ──
  const reload = useCallback(async () => {
    try { const s = await adapter.load(viewing ?? undefined); setSnap(s); setLoadErr(null); return s; }
    catch (e) { setLoadErr((e as Error).message); return null; }
  }, [adapter, viewing]);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => { adapter.mapConfig().then(setCfg, () => setCfg(null)); }, [adapter]);
  const span = useMemo<[number, number] | null>(() => {
    const a = snap?.world.timeSpan?.from.t, b = snap?.world.timeSpan?.to.t;
    return a != null && b != null ? [a, Math.max(a + 1, b)] : null;
  }, [snap?.world.timeSpan?.from.t, snap?.world.timeSpan?.to.t]);
  useEffect(() => { if (span && (t < span[0] - 1e6 || t === 0)) setT(span[0]); }, [span]); // eslint-disable-line react-hooks/exhaustive-deps
  // 轨迹：世界观改了就重取整段
  useEffect(() => {
    if (!snap || !span || readOnly) { setTracks([]); setTrackLegs([]); return; }
    let off = false;
    adapter.tracks(span[0], span[1]).then(r => { if (!off) { setTracks(r.tracks); setTrackLegs(r.legs); } }, () => {});
    return () => { off = true; };
  }, [adapter, snap?.world.revision, span, readOnly]); // eslint-disable-line react-hooks/exhaustive-deps
  // 改造层：只在跨过生效时间段的边界时重取
  const bounds = useMemo(() => [...new Set((snap?.edits ?? []).flatMap(e => [e.valid.from?.t, e.valid.to?.t]).filter((x): x is number => x != null))].sort((a, b) => a - b), [snap?.edits]);
  const bucket = bucketOf(bounds, t);
  useEffect(() => {
    if (!snap || readOnly) { setEdits(EMPTY_FC); return; }
    let off = false;
    adapter.editsAt(t).then(fc => { if (!off) setEdits(fc); }, () => {});
    return () => { off = true; };
  }, [adapter, bucket, snap?.world.revision, readOnly]); // eslint-disable-line react-hooks/exhaustive-deps
  // 事件流：检查结果、花费直接用；其余改动重取快照（简单可靠）
  const cursor = snap?.cursor;
  const ready = snap != null && !readOnly;
  useEffect(() => {
    if (!ready || cursor == null) return;
    let timer: number | undefined;
    const soon = () => { window.clearTimeout(timer); timer = window.setTimeout(() => void reload(), 300); };
    const stop = adapter.subscribe(cursor, ev => {
      if (ev.type === 'creative.check') setSnap(s => s ? { ...s, check: ev.data as CheckRun } : s);
      else if (ev.type === 'creative.usage') setCost(ev.data.cost);
      else if (ev.type === 'creative.network') { setSnap(s => s ? { ...s, world: { ...s.world, network: ev.data } } : s); if (ev.data.state !== 'importing') soon(); }
      else soon();
    }, soon);
    return () => { window.clearTimeout(timer); stop(); };
  }, [adapter, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 写 ──
  const send = useCallback(async (ops: CreativeOp[]) => {
    const s = snapRef.current; if (!s) return;
    try {
      const r = await adapter.ops(s.world.revision, ops);
      setSnap(x => x ? { ...x, check: r.check, world: { ...x.world, revision: r.revision } } : x);
      await reload();
    } catch (e) {
      const x = e as CreativeError;
      if (x.code === 'REVISION_STALE' && x.detail?.snapshot) { setSnap(x.detail.snapshot); throw new CreativeError('刚才世界观被改过（可能是 AI 画好了路线），页面已更新到最新，请再提交一次。', x.code); }
      throw e;
    }
  }, [adapter, reload]);
  const act = async (f: () => Promise<unknown>) => {
    setBusy(true); setNotice(null);
    try { await f(); } catch (e) { setNotice((e as Error).message); } finally { setBusy(false); }
  };
  const requestDraw: DrawReq = (kind, hint) => new Promise(resolve => setDraw({ kind, hint, onDone: g => { setDraw(null); resolve(g); }, onCancel: () => { setDraw(null); resolve(null); } }));

  // ── 派生（只是查表，不推断） ──
  const look = useMemo(() => ({
    events: new Map((snap?.events ?? []).map(e => [e.id, e])),
    entities: new Map((snap?.entities ?? []).map(e => [e.id, e])),
    rules: new Map((snap?.rules ?? []).map(r => [r.id, r])),
  }), [snap]);
  const legs = useMemo(() => { const m = new Map((snap?.legs ?? []).map(l => [l.id, l])); for (const l of trackLegs) if (!m.has(l.id)) m.set(l.id, l); return m; }, [snap?.legs, trackLegs]);
  const persons = useMemo(() => (snap?.entities ?? []).filter(e => e.kind === 'person'), [snap]);
  const places = useMemo(() => (snap?.entities ?? []).filter(e => e.kind === 'place'), [snap]);
  const conflicts = snap?.check?.conflicts ?? [];
  const realMap = !!snap && (snap.world.basemap.kind === 'real' || snap.world.network.sources.some(s => s.kind === 'osm'));
  // 没有真实底图（空白纸面 / 架空）时，路网只能自己画：拉一次导入的路网几何
  const [netGeo, setNetGeo] = useState<unknown>(null);
  const netKey = snap ? `${snap.world.network.state}:${snap.world.network.sources.length}:${realMap}` : '';
  useEffect(() => { if (!snap || realMap || snap.world.network.state !== 'ready') { setNetGeo(null); return; } let off = false; adapter.networkGeo().then(g => { if (!off) setNetGeo(g); }, () => {}); return () => { off = true; }; }, [adapter, netKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // 选中的冲突跟着最新检查走：修好了就自动放下（「信息不足」那种临时选中按事件还在就留着）
  const selConf = selConfRaw && (selConfRaw.id.startsWith('gap:') ? selConfRaw : conflicts.find(c => c.id === selConfRaw.id) ?? null);
  const flags = useMemo(() => {
    const ev = new Map<string, 'hard' | 'suspect'>(), lg = new Map<string, 'hard' | 'suspect'>(), pp = new Map<string, 'hard' | 'suspect'>();
    const put = (m: Map<string, 'hard' | 'suspect'>, k: string, v: 'hard' | 'suspect') => { if (m.get(k) !== 'hard') m.set(k, v); };
    for (const c of conflicts) { c.eventIds.forEach(id => put(ev, id, c.severity)); c.legIds?.forEach(id => put(lg, id, c.severity)); c.entityIds.forEach(id => put(pp, id, c.severity)); }
    return { events: ev, legs: lg, people: pp };
  }, [conflicts]);
  const pos = useMemo(() => positionsAt(tracks, legs, t), [tracks, legs, t]);
  const posMap = useMemo(() => new Map<string, Pos>(pos.map(p => [p.entityId, p])), [pos]);
  const people = pos.map(p => ({ ...p, name: look.entities.get(p.entityId)?.name ?? '?' }));
  const placeAt = (id: string | null | undefined): LngLat[] => { const g = id ? look.entities.get(id)?.place?.geo : null; return g?.type === 'Point' ? [g.coordinates as LngLat] : g?.type === 'Polygon' ? (g.coordinates[0] as LngLat[]) : []; };
  const fly = (coords: LngLat[]) => { if (coords.length) setFocus({ coords, n: Date.now() }); };

  const pick = (s: Sel) => {
    setSel(s); setTab('detail'); setForm(null);
    if (s.kind === 'event') { const e = look.events.get(s.id); fly(placeAt(e?.placeId)); if (e?.start.t != null) setT(e.start.t); }
    else if (s.kind === 'place') fly(placeAt(s.id));
    else if (s.kind === 'leg') fly((legs.get(s.id)?.path?.coordinates ?? []) as LngLat[]);
    else if (s.kind === 'person') { const p = posMap.get(s.id); if (p?.at) fly([p.at]); }
  };
  const onMapPick = (m: MapPick) => pick({ kind: m.kind, id: m.id } as Sel);
  const pickConflict = (c: CreativeConflict | null) => {
    setSelConf(c); if (!c) return;
    const coords = [...c.eventIds.flatMap(id => placeAt(look.events.get(id)?.placeId)), ...(c.legIds ?? []).flatMap(id => (legs.get(id)?.path?.coordinates ?? []) as LngLat[])];
    fly(coords);
    const first = c.eventIds.map(id => look.events.get(id)?.start.t).find(x => x != null); if (first != null) setT(first);
  };
  const openForm = (f: FormKind) => { setForm(f); setTab('form'); };
  const editSel = (s: Sel) => openForm(s.kind === 'event' ? { kind: 'event', id: s.id } : s.kind === 'person' ? { kind: 'entity', entityKind: 'person', id: s.id } : s.kind === 'place' ? { kind: 'entity', entityKind: 'place', id: s.id }
    : s.kind === 'mode' ? { kind: 'mode', id: s.id } : s.kind === 'rule' ? { kind: 'rule', id: s.id } : { kind: 'edit', id: s.id });
  const removeSel = (s: Sel) => {
    const op: CreativeOp | null = s.kind === 'event' ? { op: 'event.remove', id: s.id } : s.kind === 'person' || s.kind === 'place' ? { op: 'entity.remove', id: s.id }
      : s.kind === 'edit' ? { op: 'edit.remove', id: s.id } : s.kind === 'mode' ? { op: 'mode.remove', id: s.id } : s.kind === 'rule' ? { op: 'rule.remove', id: s.id } : null;
    if (op) void act(async () => { await send([op]); setSel(null); setTab('check'); });
  };
  const drawRoute = (legId: string) => void requestDraw('line', '画这段路线').then(g => { if (g?.type === 'LineString') void act(() => send([{ op: 'route.draw', legId, path: g }])); });
  const redraw = (legId: string, hint = '') => void act(async () => { await send([{ op: 'route.redraw', legId, ...(hint.trim() ? { hint: hint.trim() } : {}) }]); setNotice('已让 AI 重画，画好后会出现在「待确认」（一般 25 秒到几分钟）。'); });
  const decide = (p: Proposal, d: 'accepted' | 'rejected' | 'deferred') => void act(() => send([{ op: 'proposal.decide', id: p.id, decision: d }]));
  const applyFixes = (fixes: Fix[]) => act(() => submitChunks(send, fixes.flatMap(f => f.ops)));
  const recheck = () => void act(async () => { const c = await adapter.check(); setSnap(s => s ? { ...s, check: c } : s); });
  const importOsm = () => void act(async () => {
    const b = bbox.current; if (!b) return;
    await adapter.importNetwork({ source: 'osm', bbox: b }); setNetMsg('开始导入当前视野的 OSM 路网（公共 Overpass 偶尔要排队一两分钟）。');
  });
  const importAzgaar = (f: File) => void act(async () => {
    const text = await f.text(); const { assetId } = await adapter.uploadAsset(f.name, text);
    await adapter.importNetwork({ source: 'azgaar', assetId }); setNetMsg(`已上传「${f.name}」，开始导入道路。`);
  });
  const setBasemap = (kind: 'real' | 'blank') => void act(async () => {
    const b = bbox.current ?? [73, 18, 135, 54];
    await send([{ op: 'world.set', patch: { basemap: kind === 'real' ? { kind: 'real', bbox: b } : { kind: 'blank', scaleKmPerUnit: null } } }]);
  });
  const saveVersion = () => void act(async () => { const v = await adapter.saveVersion(verName.trim() || '手动保存'); setVerName(''); setNotice(`已保存为 v${v.n}（${v.changes} 处改动）。`); await reload(); });

  // ── 左栏 ──
  const placeTree = (parent: string | null): { name: string; path: string; ext?: string; children?: any[]; meta?: any }[] =>
    places.filter(p => (p.place?.parentId ?? null) === parent).map(p => {
      const kids = placeTree(p.id);
      return { name: p.name, path: p.id, ext: '地', ...(kids.length ? { children: kids } : {}), meta: flags.people.has(p.id) ? <span className="cr-xp-meta" data-bad>▲</span> : undefined };
    });
  // 父级不在世界观里的地点也挂到根上，免得丢
  const orphan = places.filter(p => p.place?.parentId && !look.entities.has(p.place.parentId));
  const net = snap?.world.network;
  const add = (label: string, f: () => void) => !readOnly && <button className="cw-xp-add" onClick={f} title={label}>＋</button>;
  const sections: ExplorerSection[] = snap ? [
    { id: 'people', title: '人物', count: persons.length, actions: add('新建人物', () => openForm({ kind: 'entity', entityKind: 'person' })), body: <div className="dv-xp-list">{persons.map(p => <button key={p.id} aria-current={sel?.id === p.id || undefined} onClick={() => pick({ kind: 'person', id: p.id })}>
      <b>{p.name}{flags.people.has(p.id) && <i className="cw-dot" data-sev={flags.people.get(p.id)} />}</b><small>{(() => { const s = posMap.get(p.id); return s?.state === 'unknown' ? '位置未定' : s?.state === 'dead' ? '已故' : s?.state === 'move' ? '在路上' : s?.state === 'at' ? look.entities.get(look.events.get(s.eventId!)?.placeId ?? '')?.name ?? '在场' : '—'; })()}</small></button>)}</div> },
    { id: 'places', title: '地点', count: places.length, grow: true, actions: add('新建地点', () => openForm({ kind: 'entity', entityKind: 'place' })),
      body: <Tree nodes={[...placeTree(null), ...orphan.map(p => ({ name: p.name, path: p.id, ext: '地' }))]} active={sel?.kind === 'place' ? sel.id : undefined} onOpen={id => { if (look.entities.has(id)) pick({ kind: 'place', id }); }} /> },
    { id: 'modes', title: '交通方式', count: snap.modes.length, folded: true, actions: add('新建交通方式', () => openForm({ kind: 'mode' })), body: <div className="dv-xp-list">{snap.modes.map(m => <button key={m.id} onClick={() => pick({ kind: 'mode', id: m.id })}><b>{m.name}</b><small>{m.kmPerHour} km/h</small></button>)}</div> },
    { id: 'rules', title: '规则', count: snap.rules.length, folded: true, actions: add('新建规则', () => openForm({ kind: 'rule' })), body: <div className="dv-xp-list">{snap.rules.map(r => <button key={r.id} onClick={() => pick({ kind: 'rule', id: r.id })}><b>{r.text}</b><small>{r.machine ? '程序能判' : '未覆盖'}</small></button>)}</div> },
    { id: 'edits', title: '改造层', count: snap.edits.length, folded: snap.edits.length > 4, actions: add('新建改造层', () => openForm({ kind: 'edit' })), body: <div className="dv-xp-list">{snap.edits.map(e => <button key={e.id} onClick={() => pick({ kind: 'edit', id: e.id })}><b>{e.title}{e.needsRemap && <i className="cw-dot" data-sev="suspect" />}</b><small>{e.valid.from?.label ?? '一直'} 起</small></button>)}</div> },
    { id: 'net', title: '底图与路网', folded: !!snap.world.network.sources.length, body: <div className="cw-net">
      <div className="cw-seg" role="group" aria-label="底图">{([['real', '真实地图'], ['blank', '空白纸面']] as const).map(([k, l]) => <button key={k} aria-pressed={(k === 'real') === realMap} disabled={readOnly || busy || snap.world.basemap.kind === 'generated'} onClick={() => setBasemap(k)}>{l}</button>)}</div>
      {snap.world.basemap.kind === 'generated' && <small>架空地图（Azgaar）</small>}
      <p>{net?.state === 'importing' ? '导入中…' : net?.state === 'failed' ? `导入失败：${net.error ?? ''}` : net?.sources.length ? net.sources.map(s => `${s.kind === 'osm' ? 'OSM' : s.kind === 'azgaar' ? 'Azgaar' : '手绘'} · ${s.edges.toLocaleString()} 段`).join('；') : '还没有路网：没有路网就只能靠 AI 推断路线'}</p>
      {!readOnly && <><button className="rh-btn" disabled={busy || net?.state === 'importing'} onClick={importOsm}>按当前视野导入 OSM</button>
        <label className="rh-btn cw-file">上传 Azgaar 道路 GeoJSON<input type="file" accept=".geojson,.json,application/geo+json" onChange={e => { const f = e.target.files?.[0]; if (f) importAzgaar(f); e.target.value = ''; }} /></label></>}
      {netMsg && <small>{netMsg}</small>}
    </div> },
    { id: 'versions', title: '版本', count: snap.versions.length, folded: true, body: <div className="cw-net">
      <div className="dv-xp-list">{snap.versions.slice().reverse().map(v => <button key={v.n} aria-current={viewing === v.n || undefined} onClick={() => { setViewing(v.n); setSel(null); }}><b>v{v.n} · {v.summary}</b><small>{new Date(v.at).toLocaleString()} · {v.changes} 处</small></button>)}</div>
      {!readOnly && <div className="cw-row"><input value={verName} onChange={e => setVerName(e.target.value)} placeholder="这一版改了什么" /><button className="rh-btn" disabled={busy} onClick={saveVersion}>保存为版本</button></div>}
    </div> },
  ] : [];

  // ── 右栏 ──
  const formFor = (f: FormKind) => {
    const done = () => { setForm(null); setTab(sel ? 'detail' : 'check'); };
    if (f.kind === 'entity') return <EntityForm key={f.id ?? 'new' + f.entityKind} entityKind={f.entityKind} init={f.id ? look.entities.get(f.id) : undefined} places={places} submit={send} onDone={done} draw={requestDraw} />;
    if (f.kind === 'event') return <EventForm key={f.id ?? 'new'} init={f.id ? look.events.get(f.id) : undefined} personId={f.personId} persons={persons} places={places} modes={snap!.modes} submit={send} onDone={done} />;
    if (f.kind === 'mode') return <ModeForm key={f.id ?? 'new'} init={snap!.modes.find(m => m.id === f.id)} submit={send} onDone={done} />;
    if (f.kind === 'rule') return <RuleForm key={f.id ?? 'new'} init={f.id ? look.rules.get(f.id) : undefined} submit={send} onDone={done} />;
    return <EditForm key={f.id ?? 'new'} init={snap!.edits.find(e => e.id === f.id)} places={places} modes={snap!.modes} submit={send} onDone={done} draw={requestDraw} />;
  };
  const hard = conflicts.filter(c => c.severity === 'hard').length, sus = conflicts.length - hard;
  const pending = snap?.proposals.length ?? 0;
  const empty = snap && !snap.entities.length && !snap.events.length;
  const title = snap?.world.title ?? dossier?.title ?? '世界观';

  if (face === 'novel' && snap) return <LiveNovel adapter={adapter} snapshot={snap} initial={novelTarget} file={file} reduced={reduced} chrome={chrome} dossier={dossier} onWorld={s => { setFace('world'); if (s) pick(s); void reload(); }} />;

  return <BenchFrame code="CRTV" section="004" file={file} reduced={reduced} chrome={chrome} face="world" onFace={f => { if (f === 'novel') setFace('novel'); }}
    faces={[{ id: 'world', label: '世界观', en: 'WORLD', badge: hard }, { id: 'novel', label: '小说', en: 'NOVEL', locked: !snap }, { id: 'video', label: '视频', en: 'VIDEO', locked: true }]}
    strip={<>《{title}》 <i>·</i> 人物 {persons.length} <i>·</i> 事件 {snap?.events.length ?? 0} <i>·</i> 红 {hard} · 黄 {sus}</>}
    shutterLines={f => [`> open world · ${title}`, `> face · ${f.en.toLowerCase()}`, '> ready']}
    status={<><span><i className="en-sq" />《{title}》</span><span>修订 {snap?.world.revision ?? '—'} · v{snap?.world.version.latest ?? 0}{snap?.world.version.draftChanges ? ` ＋${snap.world.version.draftChanges} 处未成版` : ''}</span>
      <span data-alert={hard > 0 || undefined}>确定冲突 {hard}</span><span>疑似 {sus}</span><span>待确认 {pending}</span>
      <span>花费 {cost ? (cost.known && cost.value != null ? `¥${cost.value.toFixed(2)}` : '未知') : '—'}</span><span>真实数据</span></>}>
    <div className="cr rh cw">
      <Explorer key={snap ? 'ready' : 'loading'} code="CRTV" open={xpOpen} view={xpView} onView={setXpView} onToggle={() => setXpOpen(v => !v)} title="world/" sections={sections} badges={{ files: hard || undefined }} />
      <section className="cr-center cw-center" data-wb-panel>
        <header className="dv-bar cr-bar">
          <div className="dv-bar-id"><b>WORLD</b><small>世界观<br />CANON</small></div>
          <div className="cr-work"><small>WORLD · 以地图为主</small><strong>《{title}》</strong><span>{snap ? `${places.length} 个地点 · ${snap.events.length} 条事件 · ${snap.legs.length} 段行程` : '载入中…'}</span></div>
          {!readOnly && snap && <div className="cw-bar-acts"><button className="rh-btn" onClick={() => openForm({ kind: 'event', personId: sel?.kind === 'person' ? sel.id : undefined })}>＋ 事件</button></div>}
        </header>
        {readOnly && <div className="cw-banner">正在只读查看 v{viewing}（历史版本不做检查）<button className="rh-btn" onClick={() => setViewing(null)}>回到草稿</button></div>}
        {notice && <div className="cw-banner" role="status">{notice}<button className="rh-btn" onClick={() => setNotice(null)}>知道了</button></div>}
        {net?.state === 'failed' && <div className="cw-banner" role="alert">路网导入失败：{net.error || '原因未知'}。{realMap ? '把地图移到故事发生的地方，再按当前视野重新导入。' : '可以重新上传道路文件。'}</div>}
        {loadErr && !snap ? <div className="cw-blank"><p>世界观没读出来：{loadErr}</p><button className="rh-btn" onClick={() => void reload()}>重试</button></div>
          : !snap ? <div className="cw-blank"><p>载入中…</p></div>
          : <div className="cw-stage">
            <WorldMap cfg={cfg} real={realMap} network={netGeo}
              places={places} edits={edits} legs={[...legs.values()]} people={people}
              sel={{ entityId: sel?.kind === 'person' ? sel.id : undefined, placeId: sel?.kind === 'place' ? sel.id : undefined, legIds: sel?.kind === 'leg' ? [sel.id] : undefined }}
              flags={{ legs: flags.legs, people: flags.people }} hiLegs={new Set(selConf?.legIds ?? [])} focus={focus} draw={draw}
              onPick={onMapPick} onView={b => { bbox.current = b; }} />
            {empty && !draw && <div className="cw-guide" data-has-net={!!netGeo || undefined}><b>{netGeo ? '路网已经导入，还没有人物和地点' : '这是一个空世界观'}</b>
              <p>{netGeo ? '图上的细线就是导入的道路。先建地点和人物，给人物加几条带时间和地点的事件，就能沿这些路走。' : realMap ? '把地图移到故事发生的地方，导入那一块的路网；再建人物、地点，给人物加几条带时间和地点的事件，拖时间轴就能看到人物沿路移动。' : '故事发生在真实的地方，就先换成真实地图；架空世界可以上传 Azgaar 导出的道路，或者就在空白纸面上画。'}</p>
              <div className="cw-row">{!realMap && <button className="rh-btn is-solid" onClick={() => setBasemap('real')}>用真实地图</button>}
                <button className={`rh-btn${realMap ? ' is-solid' : ''}`} onClick={() => openForm({ kind: 'entity', entityKind: 'person' })}>建第一个人物</button><button className="rh-btn" onClick={() => openForm({ kind: 'entity', entityKind: 'place' })}>建一个地点</button>
                {realMap && <button className="rh-btn" onClick={importOsm}>按当前视野导入路网</button>}</div></div>}
            <StoryTimeline persons={persons} events={snap.events} span={span} t={t} onT={setT} flags={flags.events}
              selEvent={sel?.kind === 'event' ? sel.id : null} onPickEvent={id => pick({ kind: 'event', id })}
              selPerson={sel?.kind === 'person' ? sel.id : null} onPickPerson={id => pick({ kind: 'person', id })} pos={posMap} reduced={reduced} />
          </div>}
      </section>
      <aside className="cw-side" aria-label="检查与待确认">
        <nav className="cw-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'check'} onClick={() => setTab('check')}>检查<em data-sev={hard ? 'hard' : sus ? 'suspect' : undefined}>{hard + sus || ''}</em></button>
          <button role="tab" aria-selected={tab === 'props'} onClick={() => setTab('props')}>待确认<em>{pending || ''}</em></button>
          <button role="tab" aria-selected={tab === 'detail'} onClick={() => setTab('detail')} disabled={!sel}>详情</button>
          <button role="tab" aria-selected={tab === 'assistant'} onClick={() => setTab('assistant')}>顾问</button>
          {form && <button role="tab" aria-selected={tab === 'form'} onClick={() => setTab('form')}>编辑</button>}
        </nav>
        <div className="cw-side-body">
          {!snap ? null
            : tab === 'check' ? <CheckPanel check={snap.check} look={look} sel={selConf?.id ?? null} onSel={pickConflict} onApply={applyFixes} onRecheck={recheck} busy={busy || readOnly} />
            : tab === 'props' ? <><button className="rh-btn" onClick={() => setFace('novel')}>小说提议、候选与正文改稿 →</button><ProposalList voided={voided} proposals={snap.proposals.filter(p => p.kind === 'route')} legs={legs} look={look} onDecide={decide} onRedraw={redraw} onDraw={drawRoute} onFocusLeg={id => fly((legs.get(id)?.path?.coordinates ?? []) as LngLat[])} busy={busy || readOnly} /></>
            : tab === 'assistant' ? <CreativeAssistant adapter={adapter} onUpdate={() => void reload()} initialMode="creative_advisor" />
            : tab === 'form' && form ? formFor(form)
            : sel ? <Detail works={works} onOpenWork={ref => { setNovelTarget(ref); setFace('novel'); }} sel={sel} look={look} legs={legs} edits={snap.edits} modes={snap.modes} conflicts={conflicts} onPick={pick} onEdit={readOnly ? () => {} : editSel} onRemove={readOnly ? () => {} : removeSel} onDraw={drawRoute} onRedraw={id => redraw(id)} />
            : <p className="cw-muted cw-pane">在地图、时间轴或左栏里点一个东西看详情。</p>}
        </div>
        {selConf && tab !== 'check' && <button className="cw-confbar" data-sev={selConf.severity} onClick={() => setTab('check')}>{selConf.severity === 'hard' ? '确定冲突' : '疑似'} · {KIND_ZH[selConf.kind] ?? ''} · 回到检查</button>}
      </aside>
    </div>
  </BenchFrame>;
}

