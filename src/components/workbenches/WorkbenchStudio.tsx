import type React from 'react';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Logo from '../cinematic/WorkbenchLogo';
import { startTransit, transitActive } from '../entry/transitStore';
import { navigate } from '../../nav';
import { BENCHES, CODES, FILE_NOUN, benchInfo, fileNo, type BenchId } from './benches';
import ResearchBench from '../../data/ResearchStudioData';
import EngineeringBench from './engineering/EngineeringBench';
import CreativeBench from './creative/CreativeStudio';
import AutomationBench from './automation/AutomationStudio';
import DataBench from './data/DataStudio';
import ExplorationBench from '../../data/ExploreStudioData';
import CourseStudio from './course/CourseStudio';
import './workbench-shell.css';
import InboxHost, { INBOX_REFRESH } from '../inbox/InboxHost';
import { liveBackend } from '../../data/research-live';
import { liveInboxAdapter } from '../../data/inbox-live';
import DossierMenu from '../dossier/DossierMenu';
import ConfirmDialog from '../dossier/ConfirmDialog';
import DossierEmpty from '../dossier/DossierEmpty';
import AssistDock from '../dossier/AssistDock';
import { dossiers } from '../dossier/store';
import { DossierError, type Artifact, type Confirmation, type Dossier, type ResumePoint } from '../dossier/adapter';
import { backendMode, isDemoBench } from '../../backendMode';
import { lazy, Suspense } from 'react';
import { courseOrigin, courseToken } from '../classroom/native/courseOrigin';
const NativeCourse = lazy(() => import('../classroom/native/NativeCourse'));

/** 外壳交给工作台的三样东西：返回 Files、工作台标识（转场的落点）、档案切换。工作台把它们放进自己的头部。 */
export interface BenchChrome { back: ReactNode; logo: ReactNode; file: ReactNode }
/** file：示例内容的序号（mock 档案沿用原来的 4 份示例）；dossier：当前真实档案；resume / onPosition：续上次的工作面与位置。 */
export interface BenchProps { file: number; reduced: boolean; chrome: BenchChrome; dossier?: Dossier | null; resume?: ResumePoint | null; onPosition?: (p: ResumePoint) => void; onNewDossier?: (kind: 'reading' | 'topic') => Promise<void> }

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
/** 已迁到新设计、自己画头部的工作台；其余暂用一条细条承载外壳的三样东西。 */
const OWN_HEADER: BenchId[] = ['curriculum', 'engineering', 'research', 'creative', 'data', 'automation', 'exploration'];

// 返回入口：回到同一种选台（design）和这个工作台的 Files。
function entryHref(bench?: BenchId, file?: number) {
  const q = new URLSearchParams(window.location.search);
  const out = new URLSearchParams({ preview: 'entry' });
  if (q.get('design')) out.set('design', q.get('design')!);
  if (bench) { out.set('return', bench); out.set('file', String(file ?? 0)); }
  return `${window.location.pathname}?${out}`;
}
function initial(): { bench: BenchId; file: number; dossierId: string | null } {
  const q = new URLSearchParams(window.location.search);
  const bench = (BENCHES as string[]).includes(q.get('studio') ?? '') ? q.get('studio') as BenchId : 'research';
  const file = Math.min(3, Math.max(0, Number(q.get('file') ?? 0) || 0));
  return { bench, file, dossierId: q.get('dossier') };
}
/** mock 档案 id 形如 mock-<台>-<序号>：序号就是原来的示例内容。 */
const demoIndex = (id: string | null, fallback: number) => { const m = id?.match(/^mock-[a-z]+-([0-3])$/); return m ? Number(m[1]) : fallback; };

export default function WorkbenchStudio() {
  const [{ bench, file, dossierId }, setPlace] = useState(initial);
  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'none' | 'deleted'>('loading');
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  // 切档案时先清掉旧档案再打开新的：工作台不能带着上一份档案的数据重新挂载（精读适配器按档案 id 建）
  const switchTo = useCallback((id: string) => { setDossier(null); setStatus('loading'); setPlace(p => ({ ...p, dossierId: id, file: demoIndex(id, 0) })); setMenu(false); }, []);

  // 从入口的空槽进来（new=1）：用户点了「继续工作」就是明确要新建，建一份空档案。
  const wantsNew = useRef(new URLSearchParams(window.location.search).get('new') === '1');
  useEffect(() => {
    if (!wantsNew.current) return;
    wantsNew.current = false;
    const url = new URL(window.location.href); url.searchParams.delete('new'); window.history.replaceState(null, '', url.pathname + url.search);
    void dossiers().create({ bench }).then(d => switchTo(d.id), () => setStatus('none'));
  }, [bench, switchTo]);
  // 没指定档案：续上次；mock 下退回原来的示例档案；live 下没有就显示空状态，不自动建档。
  useEffect(() => {
    if (dossierId || wantsNew.current) return;
    let off = false;
    setStatus('loading');
    dossiers().resume(bench).then(d => {
      if (off) return;
      if (d) setPlace(p => ({ ...p, dossierId: d.id, file: demoIndex(d.id, p.file) }));
      else if (dossiers().kind === 'mock') setPlace(p => ({ ...p, dossierId: `mock-${bench}-${p.file}` }));
      else { setDossier(null); setStatus('none'); }
    }, () => { if (!off) setStatus('none'); });
    return () => { off = true; };
  }, [bench, dossierId]);
  // 打开档案（记一次 open、更新续上次）；不启动任何任务。
  useEffect(() => {
    if (!dossierId) return;
    let off = false;
    dossiers().open(dossierId).then(d => { if (!off) { setDossier(d); setStatus('ready'); } }, e => {
      if (off) return;
      setDossier(null); setStatus(e instanceof DossierError && e.code === 'DOSSIER_DELETED' ? 'deleted' : 'none');
    });
    return () => { off = true; };
  }, [dossierId]);
  // 侧边 Agent 或别的页面改了这份档案：重新取；删了：显示已删除。
  useEffect(() => dossiers().subscribe(bench, e => {
    if (e.type === 'dossier.changed' && e.id === dossierId) void dossiers().get(e.id).then(setDossier, () => {});
    if (e.type === 'dossier.deleted' && e.id === dossierId) { setDossier(null); setStatus('deleted'); }
    if (e.type === 'confirmation.created' && e.confirmation.target.id === dossierId) setConfirm(e.confirmation);
    if (e.type === 'confirmation.decided') setConfirm(c => (c && c.id === e.confirmation.id ? null : c));
    if (e.type === 'confirmation.created' || e.type === 'confirmation.decided') window.dispatchEvent(new Event(INBOX_REFRESH));
  }), [bench, dossierId]);
  const onPosition = useCallback((p: ResumePoint) => { if (dossierId) void dossiers().savePosition(dossierId, p).catch(() => {}); }, [dossierId]);
  const openArtifact = (a: Artifact) => {
    setMenu(false);
    if (a.open.to === 'dossier') { if (a.open.dossierId !== dossierId) switchTo(a.open.dossierId); if (a.open.resume) onPosition(a.open.resume); }
    else if (a.open.to === 'course') {
      const owner = a.dossierId || dossierId; // 服务端成果里没带 dossierId 时就是当前档案
      if (bench !== 'curriculum' || owner !== dossierId) navigate(`${window.location.pathname}?preview=workbench&studio=curriculum&dossier=${encodeURIComponent(owner ?? '')}&course=${encodeURIComponent(a.open.courseId)}&from=entry`);
      else { setCourse(a.open.courseId); const url = new URL(window.location.href); url.searchParams.set('course', a.open.courseId); window.history.replaceState(null, '', url.pathname + url.search); }
    }
  };
  const create = async () => { const d = await dossiers().create({ bench }); switchTo(d.id); };
  // 课程成果：在原生课程播放器里打开（沿用已有进度）；关掉回到档案。
  const [course, setCourse] = useState<string | null>(() => new URLSearchParams(window.location.search).get('course'));
  const closeCourse = () => { setCourse(null); const url = new URL(window.location.href); url.searchParams.delete('course'); window.history.replaceState(null, '', url.pathname + url.search); };
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const reduced = useMemo(reducedMotion, []);
  const info = benchInfo(bench);
  // 返回 Files：顶栏里的标识升到中央（倒放进入时的标识转场），切回 Files 后飞落到档案盒的印章上。
  function leaveTo(event: React.MouseEvent<HTMLAnchorElement>, toFiles: boolean) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    const href = event.currentTarget.href;
    const fromEntry = new URLSearchParams(window.location.search).get('from') === 'entry';
    event.preventDefault();
    // 页内跳转：真实模式的登录只在内存里，整页刷新会掉线
    if (!fromEntry) { navigate(href); return; }
    const logo = event.currentTarget.ownerDocument.querySelector('.wb-crumb-logo')?.getBoundingClientRect();
    if (!toFiles || reduced || !logo || transitActive()) { navigate(href); return; }
    startTransit({ direction: 'return', workbench: info, from: logo, land: '.cine-cassette.selected .entry-seal', target: href,
      caption: { code: CODES[bench], title: info.title, name: dossier?.title ?? info.files[file], fileNo: fileNo(file) } });
  }

  useEffect(() => {
    document.title = `${info.title} · ${dossier?.title ?? info.files[file]} — ReinLab`;
    const url = new URL(window.location.href); url.searchParams.set('studio', bench); url.searchParams.set('file', String(file));
    if (dossierId) url.searchParams.set('dossier', dossierId); else url.searchParams.delete('dossier');
    window.history.replaceState(null, '', url.pathname + url.search);
  }, [bench, file, info, dossierId, dossier?.title]);
  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent | KeyboardEvent) => { if (event instanceof KeyboardEvent ? event.key === 'Escape' : !menuRef.current?.contains(event.target as Node)) setMenu(false); };
    window.addEventListener('pointerdown', close); window.addEventListener('keydown', close);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', close); };
  }, [menu]);

  const Bench = { curriculum: CourseStudio, research: ResearchBench, engineering: EngineeringBench, creative: CreativeBench, automation: AutomationBench, data: DataBench, exploration: ExplorationBench }[bench];

  // 工作台之间的切换在入口的「选择工作台」里完成，这里不再放台签；外壳只留返回、标识、档案切换。
  const chrome: BenchChrome = {
    back: <a className="wb-back" onClick={e => leaveTo(e, true)} href={entryHref(bench, file)} title={`返回 ${CODES[bench]} Files`} aria-label={`返回 ${CODES[bench]} Files`}>←</a>,
    logo: <span className="wb-crumb-logo" title={info.title}><Logo key={bench} workbench={info} still={reduced} /></span>,
    file: <><div className="wb-file" ref={menuRef}>
      <button className="wb-crumb-file" aria-expanded={menu} aria-haspopup="dialog" onClick={() => setMenu(v => !v)}><em>{dossier ? fileNo(file) : '—'}</em><span>{dossier?.title ?? (status === 'loading' ? '读取中…' : `选择${FILE_NOUN[bench]}`)}</span><b>▾</b></button>
      {menu && <DossierMenu bench={bench} noun={FILE_NOUN[bench]} current={dossier} onSwitch={switchTo} onConfirm={c => { setConfirm(c); setMenu(false); }} onOpenArtifact={openArtifact} />}
    </div>{/* 收件箱：每个工作台都能打开（真实模式接 live 适配器）；只在真实模式下进来时自动弹一次 */}
    <InboxHost autoOpen={liveBackend} adapter={liveBackend ? liveInboxAdapter : undefined} /></>,
  };
  const own = OWN_HEADER.includes(bench);
  return <main className={`wb wb-${bench}`} data-reduced={reduced || undefined} data-own-header={own || undefined}>
    {!own && <header className="wb-strip" data-wb-bar>
      {chrome.back}{chrome.logo}<span className="wb-strip-bench"><b>{CODES[bench]}</b>{info.title}</span>{chrome.file}
      <span className="wb-status"><i />LOCAL PREVIEW<small>示例数据 · 不连接模型</small></span>
    </header>}
    <div className="wb-body" key={`${bench}:${dossierId ?? file}`}>
      {status === 'ready' && dossier && !isDemoBench(CODES[bench])
        ? <Bench file={file} reduced={reduced} chrome={chrome} dossier={dossier} resume={dossier.resume} onPosition={onPosition} onNewDossier={dossiers().kind === 'live' ? async kind => { const d = await dossiers().create({ bench, kind }); switchTo(d.id); } : undefined} />
        : <ShellFrame chrome={chrome} title={info.title}>
            {status === 'loading' ? null
              : status === 'ready' && dossier ? <div className="wb-assist">
                  <DossierEmpty mode="shell" title={CODES[bench]} noun={FILE_NOUN[bench]} dossier={dossier} onOpenMenu={() => setMenu(true)} />
                  {/* 档案助手：这个台的专业能力没接入，但档案可以和侧边 Agent 一起管理（D4） */}
                  {backendMode === 'live' && bench !== 'research' && <AssistDock key={dossier.id} dossier={dossier} onOpen={o => openArtifact({ id: '', dossierId: o.to === 'dossier' ? o.dossierId : dossier.id, kind: o.to === 'course' ? 'course' : 'file', title: '', runId: null, version: 0, createdAt: '', status: 'available', open: o })} />}
                </div>
              : <DossierEmpty mode={status === 'deleted' ? 'deleted' : 'none'} title={CODES[bench]} noun={FILE_NOUN[bench]} onCreate={() => void create()} onOpenMenu={() => setMenu(true)} />}
          </ShellFrame>}
    </div>
    {confirm && <ConfirmDialog c={confirm} onClose={() => setConfirm(null)} />}
    {course && <div className="wb-course"><Suspense fallback={<div className="de"><p>正在打开课程…</p></div>}>
      <NativeCourse courseId={course} origin={courseOrigin()} token={courseToken()} reduced={reduced} onBack={closeCourse} onOpenOnline={() => window.open(courseOrigin(), '_blank', 'noopener')} notify={() => {}} />
    </Suspense></div>}
  </main>;
}

/** 工作台本体不渲染时（没有档案 / 已删除 / 能力未接入），仍保留外壳的返回、标识、档案菜单和收件箱。 */
function ShellFrame({ chrome, title, children }: { chrome: BenchChrome; title: string; children: ReactNode }) {
  return <div className="wb-shellframe">
    <header className="wb-strip" data-wb-bar>{chrome.back}{chrome.logo}<span className="wb-strip-bench">{title}</span>{chrome.file}</header>
    <div className="wb-shellbody">{children}</div>
  </div>;
}
