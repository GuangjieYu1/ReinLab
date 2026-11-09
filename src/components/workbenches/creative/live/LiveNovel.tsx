import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { GenerateJob, ImportJob, Proposal, Scene, TextEdit, Work, WorkOp, WorldSnapshot } from '../../../../../packages/contracts/src/creative';
import BenchFrame from '../../BenchFrame';
import Explorer, { type ExplorerView } from '../../engineering/Explorer';
import type { BenchProps } from '../../WorkbenchStudio';
import { CreativeError, type CreativeAdapter } from './adapter';
import { batchable, CreativeAssistant, editOf, EventPicker, kinds, money, OutlineEditor, ProposalCard } from './NovelPanels';
import type { Sel } from './Panels';
import './novel-live.css';

type Target = { workId: string; sceneId?: string; chapterId?: string; para?: number };
export default function LiveNovel({ adapter, snapshot, onWorld, initial, ...props }: BenchProps & { adapter: CreativeAdapter; snapshot: WorldSnapshot; onWorld: (s?: Sel) => void; initial?: Target }) {
  const [entry] = useState<Target | undefined>(() => { if (initial) return initial; try { return JSON.parse(localStorage.getItem(`creative-selection:${snapshot.world.id}`) ?? 'null') ?? undefined; } catch { return undefined; } });
  const [works, setWorks] = useState<Work[]>([]), [work, setWork] = useState<Work | null>(null), [workId, setWorkId] = useState(entry?.workId ?? '');
  const [sceneId, setSceneId] = useState(entry?.sceneId ?? ''), [snap, setSnap] = useState(snapshot);
  const [panel, setPanel] = useState<'scene' | 'props' | 'assistant'>('scene'), [view, setView] = useState<'text' | 'outline' | 'import' | 'beats'>('text');
  const [xp, setXp] = useState(true), [xpView, setXpView] = useState<ExplorerView>('files');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [selected, setSelected] = useState<string[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]), [next, setNext] = useState<string | null>(null), [filters, setFilters] = useState<Record<string, string>>({});
  const [gen, setGen] = useState<GenerateJob | null>(null), [imp, setImp] = useState<ImportJob | null>(null);
  const [hint, setHint] = useState(''), [range, setRange] = useState<TextEdit['range']>(null), [sourcePara, setSourcePara] = useState<number | undefined>(initial?.para);
  const [newTitle, setNewTitle] = useState(''), [newKind, setNewKind] = useState('world');
  const [importText, setImportText] = useState(''), [importName, setImportName] = useState(''), [importStage, setImportStage] = useState(0);
  const [split, setSplit] = useState<{ index: number; title: string; chars: number; paragraphs: number; preview: string }[] | null>(null);
  const [jobCost, setJobCost] = useState<{ value: number | null; known: boolean } | null>(null);
  const targetRef = useRef<Target | undefined>(entry);
  const workRef = useRef(work); workRef.current = work;
  const idRef = useRef(workId); idRef.current = workId;
  const snapRef = useRef(snap); snapRef.current = snap;
  const editor = useRef<{ flush: () => Promise<boolean>; dirty: () => boolean } | null>(null);
  const outlineDirty = useRef(false);
  const propsToken = useRef(0), detailToken = useRef(0), locked = useRef(false);
  useEffect(() => { if (workId && sceneId) localStorage.setItem(`creative-selection:${snapshot.world.id}`, JSON.stringify({ workId, sceneId })); }, [workId, sceneId, snapshot.world.id]);
  const scene = work?.chapters.flatMap(c => c.scenes).find(s => s.id === sceneId);
  const loadProposals = useCallback(async (cursor?: string) => {
    const token = ++propsToken.current;
    if (!cursor) { setProposals([]); setNext(null); }
    const page = await adapter.proposals({ ...filters, limit: '40', ...(cursor ? { cursor } : {}) });
    if (token !== propsToken.current) return;
    setProposals(xs => cursor ? [...xs, ...page.proposals.filter(p => !xs.some(x => x.id === p.id))] : page.proposals); setNext(page.nextCursor);
  }, [adapter, filters]);
  const loadWork = useCallback(async (id = idRef.current) => {
    if (!id) return;
    const token = ++detailToken.current, w = await adapter.work(id);
    if (id !== idRef.current || token !== detailToken.current) return;
    if (workRef.current?.id === w.id && workRef.current.revision > w.revision) return;
    setWork(w); workRef.current = w;
    setSceneId(old => w.chapters.some(c => c.scenes.some(s => s.id === old)) ? old : w.chapters.find(c => c.id === targetRef.current?.chapterId)?.scenes[0]?.id ?? w.chapters[0]?.scenes[0]?.id ?? '');
  }, [adapter]);
  const refresh = useCallback(async () => {
    const [ws, ss] = await Promise.all([adapter.works(), adapter.load()]);
    setWorks(ws); setSnap(ss); snapRef.current = ss;
    if (!idRef.current && ws.length) setWorkId(ws[0].id);
    await Promise.all([loadWork(), loadProposals()]);
  }, [adapter, loadWork, loadProposals]);
  useEffect(() => { void refresh().catch(e => setError(e.message)); }, [refresh]);
  useEffect(() => { setWork(null); setSelected([]); setRange(null); void loadWork(workId).catch(e => setError(e.message)); }, [workId, loadWork]);
  useEffect(() => {
    let timer: number | undefined;
    const stop = adapter.subscribe(snapshot.cursor, ev => {
      if (ev.type === 'creative.generate') { setGen(ev.data); localStorage.setItem(`creative-generate:${snapshot.world.id}`, JSON.stringify({ id: ev.data.id, workId: ev.data.workId })); }
      if (ev.type === 'creative.import') { setImp(ev.data); localStorage.setItem(`creative-import:${snapshot.world.id}`, ev.data.id); }
      if (ev.type === 'creative.usage') setJobCost(ev.data.cost);
      window.clearTimeout(timer); timer = window.setTimeout(() => void refresh().catch(e => setError(e.message)), 350);
    }, () => void refresh().catch(e => setError(e.message)));
    return () => { stop(); window.clearTimeout(timer); };
  }, [adapter, snapshot.cursor, snapshot.world.id, refresh]);
  useEffect(() => {
    try {
      const g = localStorage.getItem(`creative-generate:${snapshot.world.id}`), i = localStorage.getItem(`creative-import:${snapshot.world.id}`);
      if (g) { const v = JSON.parse(g); void adapter.generation(v.workId, v.id).then(setGen).catch(() => {}); }
      if (i) void adapter.importJob(i).then(setImp).catch(() => {});
    } catch { /* 历史任务记录可能已失效 */ }
  }, [adapter, snapshot.world.id]);
  useEffect(() => {
    if (!gen || gen.state !== 'running') return;
    let off = false;
    const timer = window.setInterval(() => { void adapter.generation(gen.workId, gen.id).then(g => { if (!off) { setGen(g); if (g.state !== 'running') void refresh(); } }).catch(e => { if (!off) setError(e.message); }); }, 1800);
    return () => { off = true; clearInterval(timer); };
  }, [adapter, gen?.id, gen?.state, refresh]);
  useEffect(() => {
    if (!imp || !['queued', 'running'].includes(imp.state)) return;
    let off = false;
    const timer = window.setInterval(() => { void adapter.importJob(imp.id).then(i => { if (!off) { setImp(i); if (i.state !== 'running' && i.state !== 'queued') void refresh(); } }).catch(e => { if (!off) setError(e.message); }); }, 1800);
    return () => { off = true; clearInterval(timer); };
  }, [adapter, imp?.id, imp?.state, refresh]);
  const act = async (fn: () => Promise<unknown>) => { if (locked.current) return; locked.current = true; setBusy(true); setError(''); try { await fn(); } catch (e) { setError((e as Error).message); } finally { locked.current = false; setBusy(false); } };
  const mutate = async (ops: WorkOp[]) => {
    const w = workRef.current; if (!w) throw Error('请先选择作品');
    try {
      const result = await adapter.workOps(w.id, w.revision, ops);
      if (idRef.current === w.id) { workRef.current = result.work; setWork(result.work); }
      void adapter.works().then(setWorks); return result.work;
    } catch (e) {
      const x = e as CreativeError;
      if (['REVISION_STALE', 'TEXT_VERSION_STALE'].includes(x.code)) { await loadWork(w.id); throw new Error('正文或作品已被更新，已取回最新版本。你的未保存内容仍保留，请核对后再保存。'); }
      throw e;
    }
  };
  const flush = async () => {
    if (outlineDirty.current && !window.confirm('大纲改了还没保存，离开会丢掉这些改动。确定离开吗？')) return false;
    outlineDirty.current = false;
    return !editor.current || await editor.current.flush();
  };
  const navigate = async (target: Target) => { if (!await flush()) return; targetRef.current = target; setRange(null); setSourcePara(target.para); setWorkId(target.workId); setSceneId(target.sceneId ?? ''); if (target.chapterId && target.workId === workId) setSceneId(work?.chapters.find(c => c.id === target.chapterId)?.scenes[0]?.id ?? ''); setView('text'); };
  const goWorld = async (s?: Sel) => { if (await flush()) onWorld(s); };
  const decide = (p: Proposal, decision: 'accepted' | 'rejected' | 'deferred', candidate?: number) => void act(async () => {
    // 正文只可走 text.accept；拒绝/暂缓仍是世界观决定。
    const s = await adapter.load(); snapRef.current = s;
    await adapter.ops(s.world.revision, [{ op: 'proposal.decide', id: p.id, decision, ...(candidate != null ? { candidate } : {}) }]); await refresh();
  });
  const acceptText = (p: Proposal, text?: string) => void act(async () => {
    if (!await flush()) return;
    const ed = editOf(p)!; const target = await adapter.work(ed.workId);
    let fullText: string | undefined = ed.mode === 'continue' ? text ?? ed.after : undefined;
    if (ed.mode !== 'continue' && (text !== undefined || (ed.mode === 'rewrite' && ed.range))) {
      const sc = target.chapters.flatMap(c => c.scenes).find(s => s.id === ed.sceneId);
      if (!sc || sc.textVersion !== ed.baseTextVersion) throw Error('正文已更新，请重新生成改稿。');
      const after = text ?? ed.after;
      if (ed.mode === 'rewrite' && ed.range) {
        const para = paragraphSlices(sc.text)[ed.range.para];
        if (!para || para.text.slice(ed.range.from, ed.range.to) !== ed.before) throw Error('选段已变化，请重新生成改稿。');
        const from = para.start + ed.range.from, to = para.start + ed.range.to;
        fullText = sc.text.slice(0, from) + after + sc.text.slice(to);
      } else {
        // 改写只做替换：找不到原文就报错，绝不接到末尾（1C 验收 C2）
        const at = ed.before ? sc.text.indexOf(ed.before) : -1;
        if (at < 0) throw Error('改稿要替换的原文在这一场里找不到了（正文改过），请重新让助手改。');
        fullText = sc.text.slice(0, at) + after + sc.text.slice(at + ed.before.length);
      }
    }
    await adapter.workOps(target.id, target.revision, [{ op: 'text.accept', proposalId: p.id, ...(fullText !== undefined ? { text: fullText } : {}) }]); await refresh();
  });
  const generate = (mode: TextEdit['mode']) => void act(async () => {
    if (!work || !scene || !await flush()) return;
    if (mode === 'rewrite' && (!range || range.from === range.to)) throw Error('请先在一个段落内选择要改写的文字。');
    const j = await adapter.generate(work.id, { sceneIds: mode === 'draft' && selected.length ? selected : [scene.id], mode, hint, ...(range ? { range } : {}) }); setGen(j); localStorage.setItem(`creative-generate:${snapshot.world.id}`, JSON.stringify({ id: j.id, workId: j.workId })); setPanel('props');
  });
  const currentChapter = work?.chapters.find(c => c.scenes.some(s => s.id === sceneId));
  const sections = [{ id: 'works', title: '作品', body: <div className="cw-pane"><select aria-label="作品切换" value={workId} onChange={e => void navigate({ workId: e.target.value })}><option value="">选择作品</option>{works.map(w => <option key={w.id} value={w.id}>{w.title}</option>)}</select>
    <details><summary>＋ 建作品</summary><input aria-label="新作品标题" placeholder="作品标题" value={newTitle} onChange={e => setNewTitle(e.target.value)} /><select aria-label="创作方式" value={newKind} onChange={e => setNewKind(e.target.value)}><option value="world">从世界观写</option><option value="import">导入一部小说</option></select><button className="rh-btn" disabled={busy || !newTitle.trim()} onClick={() => void act(async () => { if (!await flush()) return; const w = await adapter.createWork(newTitle.trim()); setWorkId(w.id); setNewTitle(''); setView(newKind === 'import' ? 'import' : 'outline'); await adapter.works().then(setWorks); })}>建立</button></details>
    {work && <><small>{work.words} 字 / 目标 {work.targetWords ?? '未设'}</small>
      <SettingPanel work={work} snap={snap} busy={busy} run={ops => act(async () => { if (await flush()) await mutate(ops); })} onWorld={s => void goWorld(s)} />
      <details className="cn-work-set"><summary>作品设置</summary>
        <label>作品标题<input defaultValue={work.title} key={work.id + work.title} onBlur={e => { if (e.target.value.trim() && e.target.value !== work.title) void act(async () => { if (await flush()) await mutate([{ op: 'work.set', patch: { title: e.target.value } }]); }); }} /></label>
        <label>全书目标字数<input type="number" min="0" defaultValue={work.targetWords ?? ''} key={work.id + String(work.targetWords)} onBlur={e => { const n = e.target.value ? Number(e.target.value) : null; if (n !== work.targetWords) void act(async () => { if (await flush()) await mutate([{ op: 'work.set', patch: { targetWords: n } }]); }); }} /></label>
        <div className="cw-row">{(['md', 'docx'] as const).map(f => <button key={f} className="rh-btn" onClick={() => void act(async () => { if (await flush()) await adapter.exportWork(work.id, f); })}>导出 {f}</button>)}</div>
      </details></>}</div> },
    ...(work?.chapters.map(c => ({ id: c.id, title: `第 ${c.no} 章 · ${c.title}`, body: <div className="dv-xp-list">{c.scenes.map(s => <div key={s.id} className="cn-tree-scene"><input type="checkbox" aria-label={`选中生成 ${s.title}`} checked={selected.includes(s.id)} onChange={e => setSelected(xs => e.target.checked ? [...xs, s.id] : xs.filter(x => x !== s.id))} /><button aria-current={sceneId === s.id || undefined} onClick={() => void navigate({ workId: work.id, sceneId: s.id })}><b>{s.title}</b><small>{s.words} 字 · {{ empty: '未写', generating: '生成中', draft: '草稿', written: '已写' }[s.state]}</small></button></div>)}</div> })) ?? [])];
  // 批次下拉：从已载入的提议里归纳（按章抽取的同一批共用 batchId），标上所属章节，不让用户手填 id
  const batches = [...proposals.reduce((m, p) => { if (p.batchId) { const x = m.get(p.batchId) ?? { id: p.batchId, n: 0, label: p.origin.source ? work?.chapters.find(c => c.id === p.origin.source!.chapterId)?.title : undefined }; x.n++; m.set(p.batchId, x); } return m; }, new Map<string, { id: string; n: number; label?: string }>()).values()];
  const showSource = (p: Proposal) => { const src = p.origin.source; if (src) void navigate({ workId: src.workId, chapterId: src.chapterId, para: src.para }); };
  return <BenchFrame code="CRTV" section="004" file={props.file} reduced={props.reduced} chrome={props.chrome} face="novel" onFace={f => { if (f === 'world') void goWorld(); }}
    faces={[{ id: 'world', label: '世界观', en: 'WORLD' }, { id: 'novel', label: '小说', en: 'NOVEL' }, { id: 'video', label: '视频', en: 'VIDEO', locked: true }]}
    strip={<>《{snapshot.world.title}》 · {work?.title ?? '小说'} · 基于 v{work?.baseVersion ?? '—'}</>}
    status={<><span>真实数据</span><span>{work?.words ?? '—'} 字</span><span>作品修订 {work?.revision ?? '—'}</span><span>累计花费 {jobCost ? money(jobCost) : '未知'}</span></>}>
    <div className="cr rh cw cn"><Explorer code="CRTV" title="novel/" open={xp} onToggle={() => setXp(!xp)} view={xpView} onView={setXpView} sections={sections} />
      <section className="cr-center cw-center" data-wb-panel><header className="dv-bar cr-bar"><div className="dv-bar-id"><b>NOVEL</b><small>小说<br />MANUSCRIPT</small></div><div className="cr-work"><strong>{work?.title ?? '选择或建立作品'}</strong>{work && <small className="cn-setline">{settingLine(work)}</small>}</div><div className="cw-row">{(['text', 'beats', 'outline', 'import'] as const).map((v, i) => <button className="rh-btn" key={v} aria-pressed={view === v} onClick={() => void act(async () => { if (await flush()) setView(v); })}>{['正文', '节拍板', '大纲', '导入'][i]}</button>)}</div></header>
        {error && <div className="cw-banner" role="alert">{error}<button className="rh-btn" onClick={() => setError('')}>关闭</button></div>}
        {gen && (gen.state === 'running' || gen.workId === workId) && <div className="cw-banner">生成《{works.find(w => w.id === gen.workId)?.title ?? '作品'}》：{gen.done.length}/{gen.sceneIds.length} 场 · {{ running: '生成中', stopped: '已停止', done: '已完成', failed: '失败' }[gen.state]} · {money(gen.cost)} {gen.error}{gen.state === 'running' ? <button className="rh-btn" onClick={() => void act(async () => setGen(await adapter.generation(gen.workId, gen.id, true)))}>停止生成</button> : <button className="rh-btn" onClick={() => { setGen(null); localStorage.removeItem(`creative-generate:${snapshot.world.id}`); }}>知道了</button>}</div>}
        {imp && (['queued', 'running', 'paused'].includes(imp.state) || imp.workId === workId) && <div className="cw-banner">导入《{works.find(w => w.id === imp.workId)?.title ?? '作品'}》：{imp.chapters.done}/{imp.chapters.total} 章 · {imp.current?.title} · {{ queued: '排队', running: '导入中', paused: '已暂停', done: '已完成', failed: '失败' }[imp.state]} · {money(imp.cost)} {imp.error}{['queued', 'running', 'paused'].includes(imp.state) ? <button className="rh-btn" onClick={() => void act(async () => setImp(await adapter.importJob(imp.id, imp.state === 'paused' ? 'resume' : 'pause')))}>{imp.state === 'paused' ? '继续导入' : '暂停导入'}</button> : <button className="rh-btn" onClick={() => { setImp(null); localStorage.removeItem(`creative-import:${snapshot.world.id}`); }}>知道了</button>}</div>}
        {!work ? <div className="cw-blank">{workId ? '载入作品…' : '在左栏建立第一部作品'}</div>
          : view === 'outline' ? <div className="cn-scroll"><OutlineEditor key={work.id} work={work} snap={snap} busy={busy} onDirty={d => { outlineDirty.current = d; }} save={async (outline, confirm) => { await mutate([{ op: 'outline.set', outline }, ...(confirm ? [{ op: 'outline.confirm' as const }] : [])]); if (confirm) { setView('text'); await refresh(); } }} /></div>
          : view === 'import' ? <div className="cw-pane cw-form cn-scroll"><h3>导入小说 · {importStage + 1}/3</h3>{importStage === 0 ? <><label className="cn-file"><span className="rh-btn">选择 txt / md 文件</span><small>{importName || '还没选文件'}</small><input type="file" accept=".txt,.md,text/plain,text/markdown" onChange={e => { const f = e.target.files?.[0]; if (f) { setImportName(f.name); void f.text().then(setImportText).catch(e => setError(e.message)); } }} /></label><label>或粘贴原文<textarea aria-label="导入原文" rows={16} value={importText} onChange={e => setImportText(e.target.value)} /></label><button className="rh-btn is-solid" disabled={busy || !importText.trim()} onClick={() => void act(async () => { setSplit((await adapter.importPreview(work.id, importText)).chapters); setImportStage(1); })}>下一步：看分章</button></> : importStage === 1 ? <><p className="cw-muted">{importName || '粘贴的原文'} · 按下面的分章导入，每章抽一批待确认。分得不对就返回改原文里的章节标题。</p><ol className="cn-split">{(split ?? []).map(c => <li key={c.index}><b>{c.title || `第 ${c.index + 1} 章`}</b><small>{c.chars} 字 · {c.paragraphs} 段</small><p>{c.preview}</p></li>)}</ol>{split && !split.length && <p role="alert">没分出章节，请检查原文。</p>}<button className="rh-btn" onClick={() => setImportStage(0)}>返回编辑</button><button className="rh-btn is-solid" disabled={busy || !split?.length} onClick={() => void act(async () => { const j = await adapter.importText(work.id, importText, importName); setImp(j); localStorage.setItem(`creative-import:${snapshot.world.id}`, j.id); setImportStage(2); await refresh(); })}>开始导入</button></> : <><p>分章结果：{imp?.chapters.total ?? '—'} 章，已完成 {imp?.chapters.done ?? '—'} 章。正文可从左栏查看。</p><button className="rh-btn" onClick={() => { setPanel('props'); setView('text'); }}>查看正文与待确认</button><button className="rh-btn" onClick={() => { setImportStage(0); setImportText(''); }}>导入另一份原文</button></>}</div>
          : view === 'beats' ? <div className="nv-beats">{work.chapters.map(c => <section key={c.id} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); const id = e.dataTransfer.getData('text/plain'); if (work.chapters.some(ch => ch.scenes.some(sc => sc.id === id))) void act(async () => { await mutate([{ op: 'scene.move', id, chapterId: c.id, to: c.scenes.length }]); }); }}><header><em>{c.no}</em><b>{c.title}</b></header>{c.scenes.map((s, i) => <article key={s.id} draggable onDragStart={e => e.dataTransfer.setData('text/plain', s.id)} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); e.stopPropagation(); const id = e.dataTransfer.getData('text/plain'); if (work.chapters.some(ch => ch.scenes.some(sc => sc.id === id))) void act(async () => { await mutate([{ op: 'scene.move', id, chapterId: c.id, to: i }]); }); }} onClick={() => void navigate({ workId: work.id, sceneId: s.id })}><b>{s.title}</b><p>{s.goal}</p><small>{s.words} 字</small></article>)}</section>)}</div>
          : scene ? <><div className="cw-pane cw-row"><input aria-label="生成要求" placeholder="补充写作要求" value={hint} onChange={e => setHint(e.target.value)} />{(['draft', 'continue', 'complete', 'rewrite'] as const).map((m, i) => <button className="rh-btn" key={m} disabled={busy || gen?.state === 'running' || work.outline?.state !== 'confirmed'} onClick={() => generate(m)}>{['生成选定场景', '续写本场', '补全', '改写选段'][i]}</button>)}{work.outline?.state !== 'confirmed' && <small>请先确认大纲</small>}</div>
            <SceneEditor key={`${work.id}:${scene.id}`} scene={scene} chapter={currentChapter?.title ?? ''} snap={snap} sourcePara={sourcePara} save={async (text, version) => { const w = await mutate([{ op: 'text.set', sceneId: scene.id, baseTextVersion: version, text }]); return w.chapters.flatMap(c => c.scenes).find(s => s.id === scene.id)!; }} controller={editor} onRange={setRange} onWorld={s => void goWorld(s)} onProposal={() => setPanel('props')}
              onSync={(itemId, action) => void act(async () => { if (!await flush()) return; if (action === 'suggest') { await mutate([{ op: 'sync.suggest', itemId, sceneIds: [scene.id] }]); setPanel('props'); } else { const reason = window.prompt('为什么这段不用改？（会记下来）', '这段写的是旧事，不受影响'); if (reason == null) return; await mutate([{ op: 'sync.dismiss', itemId, sceneId: scene.id, reason }]); } })} />
          </> : <div className="cw-blank"><p>还没有场景，请先编辑并确认大纲，或导入小说。</p><button className="rh-btn" onClick={() => setView('outline')}>编辑大纲</button></div>}
      </section>
      <aside className="cw-side"><nav className="cw-tabs">{(['scene', 'props', 'assistant'] as const).map((p, i) => <button key={p} aria-selected={panel === p} onClick={() => setPanel(p)}>{['本场', '待确认', '助手'][i]}</button>)}</nav><div className="cw-side-body">
        {panel === 'scene' && work && <div className="cw-pane cw-form"><h3>{scene?.title ?? '作品'}</h3>{scene && <SceneSettings key={`${work.id}:${scene.id}:${scene.goal}`} scene={scene} snap={snap} save={patch => act(async () => { if (await flush()) await mutate([{ op: 'scene.update', id: scene.id, patch }]); })} />}
          {scene && scene.eventIds.length > 0 && <p className="cn-jumps">{scene.eventIds.map(id => <button key={id} className="cw-link" onClick={() => void goWorld({ kind: 'event', id })}>{snap.events.find(e => e.id === id)?.title ?? id} ↗</button>)}</p>}<p className="cw-muted">{scene?.words ?? 0} 字 · 目标 {scene?.targetWords ?? '未设'}</p></div>}
        {panel === 'props' && <><div className="cw-pane cw-form cn-filters"><label>种类<select value={filters.kind ?? ''} onChange={e => setFilters({ ...filters, kind: e.target.value })}><option value="">全部</option>{['entity', 'event', 'merge', 'relation', 'rule', 'map_edit', 'route', 'itinerary', 'text_edit'].map(k => <option key={k} value={k}>{kinds[k]}</option>)}</select></label><label>批次<select value={filters.batchId ?? ''} onChange={e => setFilters({ ...filters, batchId: e.target.value })}><option value="">全部批次</option>{batches.map((b, i) => <option key={b.id} value={b.id}>{b.label ?? `第 ${i + 1} 批`} · {b.n} 条</option>)}</select></label><select aria-label="疑点筛选" value={filters.doubt ?? ''} onChange={e => setFilters({ ...filters, doubt: e.target.value })}><option value="">全部疑点状态</option><option value="true">有疑点</option><option value="false">无疑点</option></select><select aria-label="处理状态" value={filters.status ?? ''} onChange={e => setFilters({ ...filters, status: e.target.value })}><option value="">待处理</option>{['accepted', 'rejected', 'deferred'].map(s => <option key={s} value={s}>{{ accepted: '已接受', rejected: '已拒绝', deferred: '暂缓' }[s]}</option>)}</select>
          <button className="rh-btn" disabled={busy || !proposals.some(batchable)} onClick={() => void act(async () => { const ps = proposals.filter(batchable).slice(0, 40); const s = await adapter.load(); await adapter.ops(s.world.revision, ps.map(p => ({ op: 'proposal.decide' as const, id: p.id, decision: 'accepted' as const }))); await refresh(); })}>接受当前列表明确项（最多 40 条）</button></div>
          {proposals.map(p => <ProposalCard key={p.id} proposal={p} busy={busy} decide={decide} acceptText={acceptText} source={showSource} />)}{!proposals.length && <p className="cw-pane">没有符合条件的提议。</p>}{next && <button className="rh-btn" onClick={() => void loadProposals(next).catch(e => setError(e.message))}>加载更多</button>}</>}
        <div hidden={panel !== 'assistant'}><CreativeAssistant adapter={adapter} workId={workId || undefined} sceneId={sceneId || undefined} onUpdate={() => void refresh().catch(e => setError(e.message))} /></div>
      </div></aside>
    </div>
  </BenchFrame>;
}

function SceneSettings({ scene, snap, save }: { scene: Scene; snap: WorldSnapshot; save: (p: Partial<Pick<Scene, 'title' | 'goal' | 'eventIds' | 'targetWords'>>) => Promise<void> }) {
  const [title, setTitle] = useState(scene.title), [goal, setGoal] = useState(scene.goal), [ids, setIds] = useState(scene.eventIds), [target, setTarget] = useState(String(scene.targetWords ?? ''));
  return <><label>场景名<input value={title} onChange={e => setTitle(e.target.value)} /></label><label>本场目标<textarea value={goal} onChange={e => setGoal(e.target.value)} /></label><label>目标字数<input type="number" min="0" value={target} onChange={e => setTarget(e.target.value)} /></label><div className="cn-field"><span>引用事件 <small>点名字跳到世界观</small></span><EventPicker ids={ids} snap={snap} onChange={setIds} /></div><button className="rh-btn is-solid" onClick={() => void save({ title, goal, eventIds: ids, targetWords: target ? Number(target) : null })}>保存本场</button></>;
}

function SceneEditor({ scene, chapter, snap, save, controller, onRange, onWorld, onProposal, sourcePara, onSync }: {
  onSync: (itemId: string, action: 'suggest' | 'dismiss') => void;
  scene: Scene; chapter: string; snap: WorldSnapshot; save: (text: string, version: number) => Promise<Scene>;
  controller: React.MutableRefObject<{ flush: () => Promise<boolean>; dirty: () => boolean } | null>;
  onRange: (r: TextEdit['range']) => void; onWorld: (s: Sel) => void; onProposal: () => void; sourcePara?: number;
}) {
  const [text, setText] = useState(scene.text), [error, setError] = useState(''), [saving, setSaving] = useState(false), [focused, setFocused] = useState<number | null>(null);
  const state = useRef({ text: scene.text, saved: scene.text, version: scene.textVersion });
  const inflight = useRef<Promise<boolean> | null>(null), saveRef = useRef(save); saveRef.current = save;
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { if (state.current.text === state.current.saved && !inflight.current) { state.current = { text: scene.text, saved: scene.text, version: scene.textVersion }; setText(scene.text); } }, [scene.text, scene.textVersion]);
  useEffect(() => { if (sourcePara != null) box.current?.querySelector(`[data-para="${sourcePara}"]`)?.scrollIntoView({ block: 'center' }); }, [sourcePara]);
  const flush = async (): Promise<boolean> => {
    if (inflight.current) { if (!await inflight.current) return false; return flush(); }
    const current = state.current; if (current.text === current.saved) return true;
    setSaving(true); setError('');
    const sent = current.text;
    const promise = (async () => { try { const result = await saveRef.current(sent, current.version); state.current.saved = sent; state.current.version = result.textVersion; return true; } catch (e) { setError((e as Error).message); return false; } finally { setSaving(false); } })();
    inflight.current = promise; const ok = await promise; inflight.current = null; return ok;
  };
  useLayoutEffect(() => { const handle = { flush, dirty: () => state.current.text !== state.current.saved }; controller.current = handle; return () => { if (controller.current === handle) controller.current = null; }; });
  useEffect(() => { const timer = setTimeout(() => { if (!error) void flush(); }, 2000); return () => clearTimeout(timer); }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const warn = (e: BeforeUnloadEvent) => { if (state.current.text !== state.current.saved) { e.preventDefault(); e.returnValue = ''; } }; window.addEventListener('beforeunload', warn); return () => { window.removeEventListener('beforeunload', warn); }; }, [controller]);
  const paras = paragraphSlices(text);
  return <div className="nv cn-manuscript"><div className="nv-ms" ref={box}><section className="nv-ch"><header><em>{chapter}</em><h2>{scene.title}</h2><small>{scene.words} 字 · {saving ? '保存中…' : state.current.text === state.current.saved ? '已保存' : '待保存'}</small></header>
    {error && <div role="alert" className="cw-banner">{error}<button className="rh-btn" onClick={() => { state.current.version = scene.textVersion; void flush(); }}>保留我的内容并重试保存</button><button className="rh-btn" onClick={() => { state.current = { text: scene.text, saved: scene.text, version: scene.textVersion }; setText(scene.text); setError(''); }}>采用服务端正文</button></div>}
    {paras.map(({ text: p, start }, pi) => {
      const all = text === scene.text ? scene.marks.filter(m => m.para === pi) : [];
      const marks = all.filter(m => m.kind !== 'sync'), syncs = [...new Set(all.filter(m => m.kind === 'sync').map(m => m.refId))];
      const bounds = [...new Set([0, p.length, ...marks.flatMap(m => [m.from, m.to])])].filter(n => n >= 0 && n <= p.length).sort((a, b) => a - b);
      return <div key={pi} data-para={pi} className="nv-para" data-sync={syncs.length ? true : undefined} data-focused={focused === pi || undefined} onMouseDown={e => { if (focused !== pi && !(e.target as HTMLElement).closest('.nv-term, .nv-mark')) { e.preventDefault(); e.currentTarget.querySelector('textarea')?.focus(); } }}>
        {syncs.map(id => <div key={id} className="cn-sync" contentEditable={false}><span>设定改了：{itemTitle(snap, id)}，这段可能要跟着改</span><button type="button" className="cw-link" onMouseDown={e => e.stopPropagation()} onClick={() => onSync(id, 'suggest')}>让助手改</button><button type="button" className="cw-link" onMouseDown={e => e.stopPropagation()} onClick={() => onSync(id, 'dismiss')}>这里不用改</button></div>)}
        <div className="nv-mirror">{bounds.slice(0, -1).map((from, i) => { const to = bounds[i + 1], ms = marks.filter(m => m.from <= from && m.to >= to), m = ms.find(x => x.kind === 'conflict') ?? ms[0]; const entity = m?.kind === 'entity' ? snap.entities.find(e => e.id === m.refId) : undefined; const conflict = m?.kind === 'conflict' ? snap.check?.conflicts.find(c => c.id === m.refId) : undefined;
          return <span key={from} className={m ? m.kind === 'entity' || m.kind === 'event' ? 'nv-term' : 'nv-mark' : undefined} data-kind={m?.kind} data-sev={conflict?.severity} title={entity ? `${entity.name}：${entity.summary ?? ''}` : conflict?.why} onClick={() => { if (m?.kind === 'event') onWorld({ kind: 'event', id: m.refId }); else if (m?.kind === 'entity' && entity) onWorld({ kind: entity.kind === 'place' ? 'place' : 'person', id: entity.id }); else if (m) onProposal(); }}>{p.slice(from, to)}{entity && <span className="nv-term-card"><b>{entity.name}</b>{entity.summary}</span>}</span>; })}{'\u200b'}</div>
        <textarea aria-label={`正文第 ${pi + 1} 段`} value={p} rows={Math.max(2, Math.ceil(p.length / 40))} onFocus={() => setFocused(pi)} onBlur={() => { setFocused(null); void flush(); }} onChange={e => { const t = text.slice(0, start) + e.target.value + text.slice(start + p.length); state.current.text = t; setText(t); const position = start + e.target.selectionStart; const slices = paragraphSlices(t); let index = 0; for (let n = 0; n < slices.length; n++) if (slices[n].start <= position) index = n; if (index !== pi) requestAnimationFrame(() => { const area = box.current?.querySelector<HTMLTextAreaElement>(`[data-para="${index}"] textarea`); area?.focus(); area?.setSelectionRange(position - slices[index].start, position - slices[index].start); }); }} onSelect={e => { const el = e.currentTarget; onRange({ para: pi, from: el.selectionStart, to: el.selectionEnd }); }} />
      </div>;
    })}
  </section></div></div>;
}

// 与服务端用同一空行边界；保留所有原始空白，编辑某段只替换对应切片。
function paragraphSlices(text: string) {
  const slices: { start: number; text: string }[] = [];
  let start = 0;
  for (const match of text.matchAll(/\n\s*\n/g)) {
    slices.push({ start, text: text.slice(start, match.index) }); start = match.index! + match[0].length;
  }
  slices.push({ start, text: text.slice(start) });
  return slices;
}

// ── 1C：作品的设定组合（契约 §6.5）──
const itemTitle = (snap: WorldSnapshot, id: string) => snap.entities.find(e => e.id === id)?.name ?? snap.events.find(e => e.id === id)?.title ?? snap.rules.find(r => r.id === id)?.text?.slice(0, 16) ?? id.slice(0, 8);
function settingLine(w: Work) {
  const st = w.setting; if (!st) return `基于 v${w.baseVersion}`;
  return [`基于 v${st.baseVersion}`, st.picks.length ? `采用了 ${st.picks.length} 条新设定` : '', st.overrides.length ? `本作品改写 ${st.overrides.length} 条` : '', st.pendingSync ? `待同步 ${st.pendingSync} 处` : ''].filter(Boolean).join(' · ');
}
function SettingPanel({ work, snap, busy, run, onWorld }: { work: Work; snap: WorldSnapshot; busy: boolean; run: (ops: WorkOp[]) => void; onWorld: (s: Sel) => void }) {
  const st = work.setting, [ent, setEnt] = useState(''), [text, setText] = useState(''), [note, setNote] = useState('');
  const people = snap.entities.filter(e => e.kind === 'person' || e.kind === 'place');
  const cur = snap.entities.find(e => e.id === ent);
  if (!st) return null;
  return <details className="cn-setting"><summary>设定组合 · {settingLine(work)}</summary>
    {st.picks.length > 0 && <><span className="rh-micro">采用的新设定</span><ul>{st.picks.map(p => <li key={p.itemId}>{itemTitle(snap, p.itemId)} <small>用 v{p.fromVersion}</small></li>)}</ul></>}
    {st.decisions.filter(d => d.decision === 'keep').length > 0 && <><span className="rh-micro">保留旧版</span><ul>{st.decisions.filter(d => d.decision === 'keep').map(d => <li key={d.itemId}>{itemTitle(snap, d.itemId)} <small>没跟 v{d.toVersion}</small></li>)}</ul></>}
    <span className="rh-micro">本作品改写 · 只对这部作品生效</span>
    {st.overrides.length ? <ul>{st.overrides.map(o => <li key={o.itemId}><button className="cw-link" onClick={() => onWorld({ kind: snap.entities.find(e => e.id === o.itemId)?.kind === 'place' ? 'place' : 'person', id: o.itemId })}>{itemTitle(snap, o.itemId)}</button>{o.note && <small>{o.note}</small>}
      <span className="cw-row"><button className="rh-btn" disabled={busy} onClick={() => run([{ op: 'override.remove', itemId: o.itemId }])}>取消改写</button><button className="rh-btn" disabled={busy} onClick={() => run([{ op: 'override.promote', itemId: o.itemId }])}>推广到共享世界观</button></span></li>)}</ul> : <p className="cw-muted">还没有。</p>}
    <div className="cn-ovform"><select value={ent} onChange={e => { setEnt(e.target.value); setText(snap.entities.find(x => x.id === e.target.value)?.summary ?? ''); }}><option value="">＋ 改写一个人物或地点…</option>{people.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
      {cur && <><textarea value={text} onChange={e => setText(e.target.value)} rows={3} aria-label="本作品里的设定" /><input value={note} onChange={e => setNote(e.target.value)} placeholder="为什么这部作品要不一样" />
        <button className="rh-btn is-solid" disabled={busy || !text.trim()} onClick={() => { run([{ op: 'override.set', itemId: cur.id, kind: 'entity', patch: { summary: text.trim() }, note: note.trim() }]); setEnt(''); setNote(''); }}>只在本作品改</button></>}</div>
  </details>;
}
