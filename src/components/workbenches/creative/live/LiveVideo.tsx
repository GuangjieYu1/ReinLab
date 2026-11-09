// MVP-3 视频面（契约 §13.6）：左正文、中白模视口、下镜头条、右详情 / 导演 / 提议。
// 取向照 1D：导演交的白模和镜头先是虚影，接受才落账；导演在看什么，正文、视口、镜头条上描一圈。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BoardFocus, Proposal, ProposalPreview, Shot, V3, Whitebox, WhiteboxPrim, Work, WorldSnapshot } from '../../../../../packages/contracts/src/creative';
import BenchFrame from '../../BenchFrame';
import type { BenchProps } from '../../WorkbenchStudio';
import { CreativeError, type CreativeAdapter } from './adapter';
import { ProposalBar } from './Board';
import { exportGlb } from './gltf';
import { CreativeAssistant } from './NovelPanels';
import { fileUrl } from './PersonLook';
import { recordShot, Viewport3, type Doll, type Mark, type Scene3, type ViewportHandle } from './Viewport3';
import './video-live.css';

type Face = 'world' | 'novel' | 'video';
const isGhost = (id: string) => id.startsWith('pv:');

export default function LiveVideo({ adapter, snapshot, onFace, ...props }: BenchProps & { adapter: CreativeAdapter; snapshot: WorldSnapshot; onFace: (f: Face) => void }) {
  const [snap, setSnap] = useState(snapshot); const snapRef = useRef(snap); snapRef.current = snap;
  const [works, setWorks] = useState<Work[]>([]), [workId, setWorkId] = useState(''), [work, setWork] = useState<Work | null>(null), [sceneId, setSceneId] = useState('');
  const [shots, setShots] = useState<Shot[]>([]), [wb, setWb] = useState<Whitebox | null>(null), [placeId, setPlaceId] = useState('');
  const [sel, setSel] = useState<string | null>(null), [draft, setDraft] = useState<Shot | null>(null), [selDoll, setSelDoll] = useState<string | null>(null);
  const [mode, setMode] = useState<'editor' | 'camera'>('editor'), [t, setT] = useState(0), [playing, setPlaying] = useState(false);
  const [tab, setTab] = useState<'shot' | 'director' | 'props'>('shot'), [busy, setBusy] = useState(false), [err, setErr] = useState(''), [rec, setRec] = useState<{ id: string; t: number } | null>(null);
  const [props2, setProps2] = useState<Proposal[]>([]), [ghostId, setGhostId] = useState<string | null>(null), [preview, setPreview] = useState<ProposalPreview | null>(null), [pvErr, setPvErr] = useState('');
  const vp = useRef<ViewportHandle>(null);
  const [ai, setAi] = useState<BoardFocus | null>(null), [pv2, setPv2] = useState<ProposalPreview | null>(null);

  // ── 读 ──
  useEffect(() => { void adapter.works().then(ws => {
    setWorks(ws);
    let saved: { workId?: string; sceneId?: string } = {}; try { saved = JSON.parse(localStorage.getItem(`creative-video:${snapshot.world.id}`) ?? '{}'); } catch { /* 没存过 */ }
    setWorkId(ws.some(w => w.id === saved.workId) ? saved.workId! : ws[0]?.id ?? ''); if (saved.sceneId) setSceneId(saved.sceneId);
  }, e => setErr(e.message)); }, [adapter, snapshot.world.id]);
  useEffect(() => { if (!workId) return; void adapter.work(workId).then(w => { setWork(w); setSceneId(s => w.chapters.some(c => c.scenes.some(x => x.id === s)) ? s : w.chapters[0]?.scenes[0]?.id ?? ''); }, e => setErr(e.message)); }, [adapter, workId]);
  useEffect(() => { if (workId && sceneId) localStorage.setItem(`creative-video:${snapshot.world.id}`, JSON.stringify({ workId, sceneId })); }, [workId, sceneId, snapshot.world.id]);
  const loadShots = useCallback(async () => { if (!workId || !sceneId) return; const r = await adapter.shots(workId, sceneId); setShots(r.shots); setPlaceId(p => p || r.shots[0]?.placeId || ''); }, [adapter, workId, sceneId]);
  useEffect(() => { setShots([]); setSel(null); void loadShots().catch(e => setErr(e.message)); }, [loadShots]);
  const rooms = snap.entities.filter(e => e.place?.room);
  useEffect(() => { if (!placeId && rooms[0]) setPlaceId(rooms[0].id); }, [placeId, rooms]);
  const loadWb = useCallback(async () => { if (placeId) setWb(await adapter.whitebox(placeId)); }, [adapter, placeId]);
  useEffect(() => { void loadWb().catch(e => setErr(e.message)); }, [loadWb]);
  const loadProps = useCallback(async () => { const r = await adapter.proposals({ status: 'pending', limit: '60' }); setProps2(r.proposals.filter(p => p.kind === 'whitebox' || p.kind === 'shots')); }, [adapter]);
  useEffect(() => { void loadProps().catch(() => {}); }, [loadProps]);
  // 事件流：只订一次，游标跟着走（换场、换房间不重订，免得从头重放旧事件）
  const cur = useRef({ placeId, sceneId, workId, loadShots, loadWb, loadProps }); cur.current = { placeId, sceneId, workId, loadShots, loadWb, loadProps };
  const cursor = useRef(snapshot.cursor);
  useEffect(() => {
    let timer: number | undefined; const soon = () => { window.clearTimeout(timer); timer = window.setTimeout(() => { const c = cur.current; void adapter.load().then(s => setSnap(s)); void c.loadShots(); void c.loadWb(); void c.loadProps(); }, 300); };
    const stop = adapter.subscribe(cursor.current, ev => {
      cursor.current = Math.max(cursor.current, ev.seq); const c = cur.current;
      if (ev.type === 'creative.whitebox') { if (ev.data.placeId === c.placeId) setWb(ev.data); }
      else if (ev.type === 'creative.shot') { if (ev.data.sceneId === c.sceneId && (!ev.data.workId || ev.data.workId === c.workId)) { setShots(xs => { const m = new Map(xs.map(x => [x.id, x])); ev.data.shots.forEach(x => m.set(x.id, x)); return [...m.values()].sort((a, b) => a.n - b.n); }); void c.loadShots(); } }
      else if (ev.type === 'creative.focus') {
        const f = ev.data;
        if (f.done) { setAi(x => x?.runId === f.runId ? { ...x, step: '看完了' } : x); window.setTimeout(() => setAi(x => x?.runId === f.runId ? null : x), 4000); }
        else setAi(x => { const prev = x?.runId === f.runId ? x.refs : [], k = (r: unknown) => JSON.stringify(r), seen = new Set(prev.map(k)); return { ...f, refs: [...prev, ...f.refs.filter(r => !seen.has(k(r)))] }; });
        if (f.proposalId) { setGhostId(f.proposalId); soon(); }
      }
      else if (ev.type === 'creative.proposal' || ev.type === 'creative.op') soon();
    }, soon);
    return () => { window.clearTimeout(timer); stop(); };
  }, [adapter]);
  // 提议预览（虚影）
  useEffect(() => {
    if (!ghostId) { setPreview(null); setPvErr(''); return; } let off = false; setPvErr('');
    const kind = props2.find(p => p.id === ghostId)?.kind; // 白模归地点，不按作品算
    adapter.preview(ghostId, kind === 'whitebox' ? null : workId || null).then(p => { if (!off) setPreview(p); }, e => { if (off) return; setPreview(null); if ((e as CreativeError).code === 'PROPOSAL_SETTLED') setGhostId(null); else setPvErr((e as Error).message); });
    return () => { off = true; };
  }, [adapter, ghostId, workId, snap.world.revision]);

  // 同一轮导演交的另一条（白模 ↔ 镜头表）：一起画成虚影，镜头才有场景
  const mate = useMemo(() => { const g = props2.find(p => p.id === ghostId); return g?.runId ? props2.find(p => p.runId === g.runId && p.id !== g.id && p.kind !== g.kind) ?? null : null; }, [props2, ghostId]);
  useEffect(() => { if (!mate) { setPv2(null); return; } let off = false; adapter.preview(mate.id, mate.kind === 'whitebox' ? null : workId || null).then(p => { if (!off) setPv2(p); }, () => { if (!off) setPv2(null); }); return () => { off = true; }; }, [adapter, mate?.id, workId, snap.world.revision]); // eslint-disable-line react-hooks/exhaustive-deps
  // ── 派生 ──
  const scene = work?.chapters.flatMap(c => c.scenes).find(s => s.id === sceneId);
  const paras = useMemo(() => (scene?.text ?? '').split(/\n\s*\n/).map(x => x.trim()).filter(Boolean), [scene?.text]);
  const room = snap.entities.find(e => e.id === placeId)?.place?.room ?? null;
  const ghostProp = props2.find(p => p.id === ghostId) ?? null;
  const pv = preview?.proposalId === ghostId ? preview : null;
  const hiIds = new Set((pv?.vsPrevious ?? []).map(c => c.itemId));
  const aiIds = new Set((ai?.refs ?? []).flatMap(r => 'id' in r ? [r.id] : []));
  const aiScene = (ai?.refs ?? []).some(r => r.kind === 'scene' && r.sceneId === sceneId && r.para == null);
  const aiParas = new Set((ai?.refs ?? []).flatMap(r => r.kind === 'scene' && r.sceneId === sceneId && r.para != null ? [r.para] : []));
  const pvs = [pv, pv2?.proposalId === mate?.id ? pv2 : null].filter(Boolean) as ProposalPreview[];
  const ghostShots = pvs.flatMap(x => x.added.shots ?? []).filter(s => s.sceneId === sceneId);
  const ghostPrims = pvs.flatMap(x => x.added.prims ?? []);
  const allShots = [...shots, ...ghostShots].sort((a, b) => a.n - b.n || (isGhost(a.id) ? 1 : -1));
  const shot = (draft && draft.id === sel ? draft : allShots.find(s => s.id === sel)) ?? null;
  useEffect(() => { setDraft(null); setT(0); setPlaying(false); }, [sel]);
  // 白模提议归哪个地点、选中的镜头在哪个房间：视口跟过去
  useEffect(() => { const op = ghostProp?.ops.find(o => 'placeId' in o && o.op.startsWith('whitebox')) as { placeId?: string } | undefined; if (op?.placeId) setPlaceId(op.placeId); }, [ghostProp?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (shot?.placeId && shot.placeId !== placeId) setPlaceId(shot.placeId); }, [shot?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const person = (id: string) => snap.entities.find(e => e.id === id);
  const cloth = useClothColors(snap.entities.filter(e => e.kind === 'person').map(e => ({ id: e.id, portrait: e.person?.portrait?.url ?? null })));
  const dolls: Doll[] = (shot?.cast ?? []).map(c => { const p = person(c.entityId); return { id: c.entityId, name: p?.name ?? '未知', at: c.at, to: c.to, facing: c.facing, heightM: p?.person?.body?.heightM ?? 1.7, build: p?.person?.body?.build ?? null, color: cloth[c.entityId], ghost: isGhost(shot!.id), hi: hiIds.has(shot!.id), ai: aiIds.has(c.entityId) }; });
  const mark = (p: WhiteboxPrim, m: Mark) => ({ ...p, ...m, hi: m.hi || hiIds.has(p.id), ai: aiIds.has(p.id) });
  const scene3: Scene3 = { room, prims: [...(wb?.prims ?? []).map(p => mark(p, {})), ...ghostPrims.map(p => mark(p, { ghost: true }))], dolls };
  const cleanScene: Scene3 = { room: null, prims: (wb?.prims ?? []), dolls: dolls.map(d => ({ ...d, ghost: false, hi: false, ai: false })) };

  // 播放预演：机位从起点运到终点
  useEffect(() => {
    if (!playing || !shot) return; let raf = 0; const t0 = performance.now() - t * shot.durationSec * 1000;
    const tick = () => { const x = Math.min(1, (performance.now() - t0) / (shot.durationSec * 1000)); setT(x); if (x < 1) raf = requestAnimationFrame(tick); else setPlaying(false); };
    raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf);
  }, [playing]); // eslint-disable-line react-hooks/exhaustive-deps

  const fitKey = `${placeId}|${wb?.version ?? 0}|${ghostId ?? ''}|${pv ? 1 : 0}|${pv2 ? 1 : 0}`;
  useEffect(() => { const h = window.setTimeout(() => vp.current?.fit(), 50); return () => window.clearTimeout(h); }, [fitKey]);
  // ── 写 ──
  const act = async (f: () => Promise<unknown>) => { setBusy(true); setErr(''); try { await f(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const ops = async (list: Parameters<CreativeAdapter['ops']>[1]) => {
    try { const r = await adapter.ops(snapRef.current.world.revision, list); setSnap(s => ({ ...s, world: { ...s.world, revision: r.revision } })); }
    catch (e) { const x = e as CreativeError; if (x.code === 'REVISION_STALE') { const s = await adapter.load(); setSnap(s); snapRef.current = s; const r = await adapter.ops(s.world.revision, list); setSnap(v => ({ ...v, world: { ...v.world, revision: r.revision } })); } else throw e; }
  };
  const editable = !!shot && !isGhost(shot.id) && !busy && !rec;
  // 拖动中的镜头：放 ref 里同步更新（pointermove 不会立刻重渲染，松手时要拿到最新的）
  const draftRef = useRef<Shot | null>(null);
  useEffect(() => { draftRef.current = null; }, [sel]);
  const edit = (f: (s: Shot) => Shot) => { const base = draftRef.current && draftRef.current.id === shot?.id ? draftRef.current : shot; if (!base) return; const next = f(base); draftRef.current = next; setDraft(next); };
  const moveDoll = (id: string, p: V3) => edit(s => ({ ...s, cast: s.cast.map(c => c.entityId === id ? { ...c, at: p } : c) }));
  const moveCam = (which: 'eye' | 'target' | 'end', p: V3) => edit(s => { const c = s.camera; return { ...s, camera: which === 'eye' ? { ...c, eye: p } : which === 'target' ? { ...c, target: p } : { ...c, end: c.end ? { ...c.end, eye: p } : null } }; });
  const commit = () => { const d = draftRef.current; if (!d || isGhost(d.id)) return; void act(async () => { await ops([{ op: 'shot.update', id: d.id, patch: { cast: d.cast, camera: d.camera } }]); await loadShots(); }); };
  const record = (s: Shot) => act(async () => {
    setSel(s.id); setRec({ id: s.id, t: 0 });
    try { const r = await recordShot(cleanSceneFor(s), s.camera, s.durationSec, x => setRec({ id: s.id, t: x })); await adapter.uploadPreview(s.id, r.video, r.poster); await loadShots(); }
    finally { setRec(null); }
  });
  const cleanSceneFor = (s: Shot): Scene3 => ({ ...cleanScene, dolls: s.cast.map(c => { const p = person(c.entityId); return { id: c.entityId, name: p?.name ?? '', at: c.at, to: c.to, facing: c.facing, heightM: p?.person?.body?.heightM ?? 1.7, build: p?.person?.body?.build ?? null, color: cloth[c.entityId] }; }) });
  const decide = (p: Proposal, d: 'accepted' | 'rejected') => act(async () => { await ops([{ op: 'proposal.decide', id: p.id, decision: d }]); setGhostId(null); await Promise.all([loadShots(), loadWb(), loadProps()]); });
  const glb = () => act(async () => { const place = snap.entities.find(e => e.id === placeId); await exportGlb(`${place?.name ?? '白模'}-白模-v${wb?.version ?? 0}`, placeId, room, wb?.prims ?? [], dolls.filter(d => !d.ghost)); });

  const stepLabel = ai ? `导演 · ${ai.step}` : null;
  const recorded = shots.filter(s => s.preview).length;
  return <BenchFrame code="CRTV" section="004" file={props.file} reduced={props.reduced} chrome={props.chrome} face="video" onFace={f => onFace(f as Face)}
    faces={[{ id: 'world', label: '世界观', en: 'WORLD' }, { id: 'novel', label: '小说', en: 'NOVEL' }, { id: 'video', label: '视频', en: 'VIDEO', badge: shots.length }]}
    strip={<>《{snap.world.title}》 · {work?.title ?? '作品'} · {scene?.title ?? '场'}</>}
    status={<><span>真实数据</span><span>{shots.length} 镜</span><span>预演 {recorded}/{shots.length}</span><span>白模 v{wb?.version ?? 0} · {wb?.prims.length ?? 0} 部件</span></>}>
    <div className="cr rh cw lv">
      <aside className="lv-text">
        <div className="cw-row lv-pick">
          <select aria-label="作品" value={workId} onChange={e => { setWorkId(e.target.value); setSceneId(''); }}>{works.map(w => <option key={w.id} value={w.id}>{w.title}</option>)}</select>
          <select aria-label="场" value={sceneId} onChange={e => setSceneId(e.target.value)}>{work?.chapters.flatMap(c => c.scenes.map(s => <option key={s.id} value={s.id}>{c.title} · {s.title}</option>))}</select>
        </div>
        <div className="lv-paras" data-ai={aiScene || undefined}>{paras.length ? paras.map((p, i) => { const n = i + 1, hit = allShots.filter(s => s.para === n);
          return <p key={i} data-on={shot?.para === n || undefined} data-ai={aiParas.has(n) || undefined} onClick={() => hit[0] && setSel(hit[0].id)}><small>{n}{hit.length ? ` · 镜 ${hit.map(s => s.n).join('、')}` : ''}</small>{p}</p>; }) : <p className="cw-muted">这一场还没有正文。</p>}</div>
      </aside>
      <section className="lv-stage">
        <header className="lv-bar">
          <select aria-label="房间" value={placeId} onChange={e => setPlaceId(e.target.value)}>{rooms.map(r => <option key={r.id} value={r.id}>{r.name}{r.place?.room ? ` · ${Math.round(r.place.room.height * 10) / 10} m 高` : ''}</option>)}{placeId && !rooms.some(r => r.id === placeId) && <option value={placeId}>{snap.entities.find(e => e.id === placeId)?.name ?? '地点'} · 没有房间几何</option>}{!rooms.length && <option value="">还没有房间几何</option>}</select>
          <div className="lv-seg">{(['editor', 'camera'] as const).map(m => <button key={m} aria-pressed={mode === m} disabled={m === 'camera' && !shot} onClick={() => setMode(m)}>{m === 'editor' ? '编辑视角' : '机位视角'}</button>)}</div>
          {shot && <><button className="rh-btn" disabled={!!rec} onClick={() => { if (t >= 1) setT(0); setMode('camera'); setPlaying(p => !p); }}>{playing ? '暂停' : '▶ 预演'}</button>
            <input className="lv-scrub" type="range" min={0} max={1} step={.01} value={t} onChange={e => { setPlaying(false); setT(+e.target.value); }} aria-label="预演进度" /></>}
          <button className="rh-btn" onClick={() => vp.current?.fit()}>看全部</button><span className="lv-grow" />
          {shot && !isGhost(shot.id) && <button className="rh-btn" disabled={busy || !!rec} onClick={() => void record(shot)}>{rec?.id === shot.id ? `录制中 ${Math.round(rec.t * 100)}%` : shot.preview ? '重录预演' : '录预演'}</button>}
          <button className="rh-btn" disabled={busy || !wb} onClick={() => void glb()}>导出 glTF</button>
        </header>
        <div className="lv-view">
          <Viewport3 ref={vp} scene={scene3} cam={shot?.camera ?? null} mode={mode} t={t} selDoll={selDoll} editable={editable} onSelDoll={setSelDoll} onMoveDoll={moveDoll} onMoveCam={moveCam} onCommit={commit} />
          {stepLabel && <div className="cw-ai-step" role="status"><i />{stepLabel}</div>}
          {!wb?.prims.length && !ghostPrims.length && <div className="lv-empty">这个房间还没有白模。去右边「导演」说「把这一场拆成镜头」。</div>}
        </div>
        {ghostProp && (pv || pvErr) && <ProposalBar proposal={ghostProp} preview={pv} previewError={pvErr} proposals={props2} busy={busy}
          onDecide={d => void decide(ghostProp, d)} onClose={() => setGhostId(null)}
          onRevise={text => ghostProp.runId ? adapter.sayAssistant(ghostProp.runId, text, { proposalId: ghostProp.id }).then(() => undefined) : Promise.reject(Error('这条提议不是在导演对话里交的。'))} />}
        {ghostProp && mate && <p className="lv-mate">同一轮导演还交了《{mate.title}》，一起画在上面；两条分开接受。<button className="cw-link" onClick={() => setGhostId(mate.id)}>切到那条</button></p>}
        <ol className="lv-shots" aria-label="镜头">
          {allShots.map(s => <li key={s.id} data-sel={s.id === sel || undefined} data-ghost={isGhost(s.id) || undefined} data-hi={hiIds.has(s.id) || undefined} data-ai={aiIds.has(s.id) || undefined}>
            <button onClick={() => { setSel(s.id); setTab('shot'); }}>
              {s.preview?.posterUrl ? <img src={fileUrl(s.preview.posterUrl)} alt="" /> : <span className="lv-noposter">{isGhost(s.id) ? '提议' : '未录预演'}</span>}
              <b>镜 {String(s.n).padStart(2, '0')}</b><small>{s.durationSec} 秒{s.para ? ` · 第 ${s.para} 段` : ''}</small>
              <span className="lv-act">{s.action}</span>
              {!!s.stale?.length && <em className="lv-stale" title={s.stale.join('；')}>依据旧了</em>}
            </button></li>)}
          {!allShots.length && <li className="lv-none">这一场还没有镜头。</li>}
        </ol>
      </section>
      <aside className="cw-side lv-side"><nav className="cw-tabs">{(['shot', 'director', 'props'] as const).map((p, i) => <button key={p} aria-selected={tab === p} onClick={() => setTab(p)}>{['镜头', '导演', `提议${props2.length ? ` ${props2.length}` : ''}`][i]}</button>)}</nav><div className="cw-side-body">
        {err && <p className="cw-warn" role="alert">{err}</p>}
        {tab === 'shot' && (shot ? <div className="cw-pane lv-detail">
          <span className="rh-micro">镜 {shot.n} · {shot.durationSec} 秒{isGhost(shot.id) ? ' · 提议（未接受）' : ''}</span>
          <h3>{shot.action}</h3>
          {!!shot.stale?.length && <p className="cw-warn">依据旧了：{shot.stale.join('；')}</p>}
          {shot.dialogue && <p>对白：{shot.dialogue}</p>}{shot.light && <p className="cw-muted">光线：{shot.light}</p>}
          <dl><div><dt>机位</dt><dd>{fmt(shot.camera.eye)} → 看 {fmt(shot.camera.target)} · {shot.camera.fov}°{shot.camera.end ? ` · 运到 ${fmt(shot.camera.end.eye)}` : ' · 固定'}</dd></div>
            {shot.cast.map(c => <div key={c.entityId}><dt>{person(c.entityId)?.name ?? '未知'}</dt><dd>{({ stand: '站', sit: '坐', walk: '走' })[c.pose]} · {fmt(c.at)}{c.to ? ` → ${fmt(c.to)}` : ''} · 朝 {c.facing}° · {person(c.entityId)?.person?.body?.heightM ?? '?'} m{c.assetVersionId ? '' : ' · 没挂形象版本'}</dd></div>)}</dl>
          {shot.preview && <><span className="rh-micro">预演片段</span><video className="lv-prev" src={fileUrl(shot.preview.url)} poster={fileUrl(shot.preview.posterUrl)} controls muted playsInline /></>}
          {editable && <div className="cw-row lv-cast">
            <select aria-label="加人物到这一镜" value="" onChange={e => { const id = e.target.value; if (!id) return; const c = room ? [room.outline.reduce((a, p) => a + p[0], 0) / room.outline.length, 0, room.outline.reduce((a, p) => a + p[1], 0) / room.outline.length] as V3 : [0, 0, 0] as V3;
              void act(async () => { await ops([{ op: 'shot.update', id: shot.id, patch: { cast: [...shot.cast, { entityId: id, assetVersionId: null, at: c, facing: 0, pose: 'stand', to: null }] } }]); await loadShots(); }); }}>
              <option value="">加人物到这一镜…</option>{snap.entities.filter(e => e.kind === 'person' && !shot.cast.some(c => c.entityId === e.id)).map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
            <button className="cw-link" onClick={() => { const c = shot.camera; const dir = [c.target[0] - c.eye[0], 0, c.target[2] - c.eye[2]] as V3, l = Math.hypot(dir[0], dir[2]) || 1;
              const end = c.end ? null : { eye: [c.eye[0] + dir[0] / l * 1.2, c.eye[1], c.eye[2] + dir[2] / l * 1.2] as V3, target: c.target };
              void act(async () => { await ops([{ op: 'shot.update', id: shot.id, patch: { camera: { ...c, end } } }]); await loadShots(); }); }}>{shot.camera.end ? '去掉运镜' : '加运镜（推近 1.2 米）'}</button>
            {shot.cast.map(c => <button key={c.entityId} className="cw-link" onClick={() => void act(async () => { await ops([{ op: 'shot.update', id: shot.id, patch: { cast: shot.cast.filter(x => x.entityId !== c.entityId) } }]); await loadShots(); })}>移出{person(c.entityId)?.name}</button>)}
          </div>}
          {editable && <p className="cw-muted">在视口里拖人偶、拖机位（橙点：机位 / 看向 / 终点），松手就存。</p>}
        </div> : <p className="cw-pane cw-muted">点一个镜头看详情。</p>)}
        <div hidden={tab !== 'director'}><CreativeAssistant adapter={adapter} workId={workId || undefined} sceneId={sceneId || undefined} placeId={placeId || undefined} initialMode="creative_director" modes={['creative_director']}
          onUpdate={() => { void loadShots(); void loadWb(); void loadProps(); }} onBoard={id => setGhostId(id)} /></div>
        {tab === 'props' && <div className="cw-pane">{props2.map(p => <button key={p.id} className="lv-prop" data-on={p.id === ghostId || undefined} onClick={() => setGhostId(p.id)}><b>{p.title}</b><small>{p.kind === 'whitebox' ? '白模' : '镜头表'} · {p.ops.length} 项 · {(() => { const o = p.ops[0] as { placeId?: string; shot?: { placeId?: string } }; const id = o?.placeId ?? o?.shot?.placeId; return snap.entities.find(e => e.id === id)?.name ?? '地点未定'; })()}</small></button>)}{!props2.length && <p className="cw-muted">没有待确认的白模或镜头提议。</p>}</div>}
      </div></aside>
    </div>
  </BenchFrame>;
}
const fmt = (v: V3) => `(${v.map(x => Math.round(x * 10) / 10).join(', ')})`;

/** 人偶衣服颜色：取选用立绘中段（身体）不太亮的像素的平均色；没有立绘按人分一个固定色。 */
const PALETTE: [number, number, number][] = [[98, 120, 138], [146, 92, 74], [104, 124, 92], [128, 104, 140], [150, 128, 84], [86, 108, 116]];
function useClothColors(people: { id: string; portrait?: string | null }[]) {
  const [cols, setCols] = useState<Record<string, [number, number, number]>>({});
  const key = people.map(p => `${p.id}:${p.portrait ?? ''}`).join('|');
  useEffect(() => {
    let off = false;
    people.forEach((p, i) => {
      const fallback = PALETTE[[...p.id].reduce((a, c) => a + c.charCodeAt(0), i) % PALETTE.length];
      if (!p.portrait) { setCols(c => ({ ...c, [p.id]: fallback })); return; }
      const img = new Image(); img.crossOrigin = 'anonymous';
      img.onload = () => {
        if (off) return; const W = 48, H = 72, c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d')!; g.drawImage(img, 0, 0, W, H);
        const d = g.getImageData(W * .3, H * .35, W * .4, H * .4).data; let r = 0, gg = 0, b = 0, n = 0;
        for (let k = 0; k < d.length; k += 4) { const l = (d[k] + d[k + 1] + d[k + 2]) / 3; if (l > 205 || l < 25) continue; r += d[k]; gg += d[k + 1]; b += d[k + 2]; n++; }
        setCols(cur => ({ ...cur, [p.id]: n ? [r / n, gg / n, b / n] : fallback }));
      };
      img.onerror = () => { if (!off) setCols(cur => ({ ...cur, [p.id]: fallback })); };
      img.src = fileUrl(p.portrait);
    });
    return () => { off = true; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return cols;
}
