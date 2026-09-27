import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowLeft, ArrowRight, ArrowUpRight, BookmarkPlus, Download, NotebookPen, Undo2, Wrench, X } from 'lucide-react';
import { RhineMark } from '../cinematic/BootStage';
import { absenceDays } from './courseState';
import { addEvidence, describeScene, freshLearning, isLearningStore, LEARNING_KEY, learningMarkdown, restoreEvidence, subjectIds, subjectInfo, updateScene, type Evidence, type LearningStore, type Scene, type SubjectId } from './learningState';
import MathLesson, { mathChapterNames } from './scenes/MathLesson';
import { PhysicsLesson, SystemsLesson } from './scenes/ScienceScenes';
import { GuitarLesson, PhotoLesson } from './scenes/MediaScenes';
import './learning.css';
const HistoryLesson = lazy(() => import('./scenes/HistoryLesson'));

function load() {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LEARNING_KEY);
    if (raw && raw.length < 2_000_000) { const value: unknown = JSON.parse(raw); if (isLearningStore(value)) return { store: value, warning: '', recovery: null }; }
    return { store: freshLearning(), warning: raw ? '保存的数据格式不兼容，当前使用新课堂；原始数据将在写入前另存备份。' : '', recovery: raw };
  } catch { return { store: freshLearning(), warning: '本地记录暂不可读取；课堂可以继续使用，原始内容将在写入前备份。', recovery: raw }; }
}
function StreamCopy({ text, reduced, paused = false }: { text: string; reduced: boolean; paused?: boolean }) {
  const parts = text.match(/[^，。！？]+[，。！？]?/g) ?? [text];
  const [count, setCount] = useState(reduced ? parts.length : 1);
  useEffect(() => {
    if (reduced) { setCount(parts.length); return; }
    setCount(1);
    if (paused) return;
    let shown = 1;
    const timer = setInterval(() => { shown++; setCount(shown); if (shown >= parts.length) clearInterval(timer); }, 300);
    return () => clearInterval(timer);
  }, [text, reduced, parts.length, paused]);
  return <p className="director-stream" aria-label={text}>{parts.slice(0, count).map((part, index) =>
    <span key={`${index}-${part}`} aria-hidden="true">{part}</span>)}</p>;
}

/** Reveal semantic rows rather than fading or scaling the complete lesson at once. */
function BreathingDisplay({ children, reduced, reveal, pane }: { children: ReactNode; reduced: boolean; reveal: boolean; pane: 'lecture' | 'object' }) {
  const root = useRef<HTMLDivElement>(null);
  const revealOnMount = useRef(reveal).current;
  useLayoutEffect(() => {
    if (!revealOnMount || reduced || !root.current) return;
    const scene = root.current.firstElementChild;
    if (!(scene instanceof HTMLElement)) return;
    const columns = scene.classList.contains('rl-split') ? Array.from(scene.children) : [scene];
    const targets = columns.flatMap(column => Array.from(column.children))
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element.getBoundingClientRect().height > 0)
      .sort((a, b) => {
        const first = a.getBoundingClientRect(), second = b.getBoundingClientRect();
        return first.top - second.top || first.left - second.left;
      });
    let row = -1, rowTop = -Infinity;
    const animations = targets.map(element => {
      const top = element.getBoundingClientRect().top;
      if (top - rowTop > 24) { row++; rowTop = top; }
      return element.animate([
        { opacity: 0, transform: 'translate3d(0,8px,0)', filter: 'blur(3px)' },
        { opacity: .58, transform: 'translate3d(0,2px,0)', filter: 'blur(.6px)', offset: .62 },
        { opacity: 1, transform: 'translate3d(0,0,0)', filter: 'blur(0)' },
      ], {
        duration: 620,
        delay: Math.min(row * 82, 740),
        easing: 'cubic-bezier(.22,.7,.2,1)',
        fill: 'backwards',
      });
    });
    return () => animations.forEach(animation => animation.cancel());
  }, [reduced, revealOnMount]);
  return <motion.div id="rl-display" data-pane={pane} ref={root} initial={false} animate={{ opacity: 1 }}
    exit={{ opacity: 0 }} transition={{ duration: reduced ? 0 : .18, ease: 'easeInOut' }}>
    {children}
  </motion.div>;
}

export function MathPager({ page, onPage }: { page: number; onPage: (page: number) => void }) {
  return <nav className="learning-math-pager" aria-label="数学讲义翻页">
    <button aria-label="上一页数学讲义" disabled={page === 0} onClick={() => onPage(page - 1)}><ArrowLeft size={14} />上一页</button>
    <span aria-live="polite"><b>{mathChapterNames[page]}</b><small>{String(page + 1).padStart(2, '0')} / {String(mathChapterNames.length).padStart(2, '0')}</small></span>
    <button aria-label="下一页数学讲义" disabled={page === mathChapterNames.length - 1} onClick={() => onPage(page + 1)}>下一页<ArrowRight size={14} /></button>
  </nav>;
}
type SharedElementSurface = 'archive' | 'classroom';
type SharedTransitionPhase = 'opening' | 'returning' | null;
export default function LearningClassroom({ initialSubject, reduced, sharedElementSurface = 'classroom', sharedTransitionPhase = null, preparing = false, onPrepared, soundControl, onBack, onReturnStart, onMediaPlaying, onSharedTransitionReady, onSharedTransitionComplete }: {
  initialSubject: SubjectId; reduced: boolean; soundControl: ReactNode; onBack: () => void;
  preparing?: boolean; onPrepared?: () => void;
  sharedElementSurface?: SharedElementSurface; sharedTransitionPhase?: SharedTransitionPhase;
  onSharedTransitionReady?: () => void; onSharedTransitionComplete?: () => void;
  onReturnStart?: () => void;
  onMediaPlaying: (playing: boolean) => void;
}) {
  const [initial] = useState(load);
  const [store, setStore] = useState<LearningStore>(() => ({ ...initial.store, active: initialSubject }));
  const [notice, setNotice] = useState(initial.warning);
  const [storageFailed, setStorageFailed] = useState(false);
  const [director, setDirector] = useState(true);
  const [maintenance, setMaintenance] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [mobilePane, setMobilePane] = useState<'lecture' | 'object'>('lecture');
  const [returning, setReturning] = useState(false);
  const [revision, setRevision] = useState(0);
  const [older, setOlder] = useState(false);
  const [sessionVisits] = useState(() => Object.fromEntries(subjectIds.map(id => [id, initial.store.subjects[id].visited])));
  const root = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const lastStore = useRef(store); lastStore.current = store;
  const changed = useRef(false);
  const recovered = useRef(false);
  const recoveryKey = useRef(`${LEARNING_KEY}-recovery-${Date.now()}`);
  const noteStart = useRef<{ id: SubjectId; text: string } | null>(null);
  const active = initialSubject, r = store.subjects[active], info = subjectInfo[active];
  const mutate = useCallback((fn: (v: LearningStore) => LearningStore) => { changed.current = true; setStore(fn); }, []);
  const persist = useCallback((value: LearningStore) => {
    if (!changed.current) return;
    try {
      if (initial.recovery && !recovered.current) { localStorage.setItem(recoveryKey.current, initial.recovery); recovered.current = true; }
      localStorage.setItem(LEARNING_KEY, JSON.stringify(value)); setStorageFailed(false);
    }
    catch { setStorageFailed(true); }
  }, [initial]);
  useEffect(() => {
    const timer = setTimeout(() => persist(store), 300);
    return () => clearTimeout(timer);
  }, [store, persist]);
  useEffect(() => {
    const save = () => { if (changed.current) { try {
      if (initial.recovery && !recovered.current) { localStorage.setItem(recoveryKey.current, initial.recovery); recovered.current = true; }
      localStorage.setItem(LEARNING_KEY, JSON.stringify(lastStore.current));
    } catch { /* Keep the in-memory session. */ } } };
    window.addEventListener('pagehide', save);
    return () => { save(); window.removeEventListener('pagehide', save); };
  }, []);
  useEffect(() => {
    document.title = `${subjectInfo[active].name} · 沉浸课堂 — REINLAB`;
  }, [active]);
  useLayoutEffect(() => { if (preparing) onPrepared?.(); }, [preparing, onPrepared]);
  useLayoutEffect(() => {
    if (sharedTransitionPhase === 'opening' && sharedElementSurface === 'archive') onSharedTransitionReady?.();
  }, [sharedElementSurface, sharedTransitionPhase, onSharedTransitionReady]);
  useEffect(() => { if (!preparing) root.current?.focus({ preventScroll: true }); }, [preparing]);
  useEffect(() => {
    if (maintenance && !dialog.current?.open) dialog.current?.showModal();
    if (!maintenance && dialog.current?.open) dialog.current.close();
  }, [maintenance]);
  useEffect(() => {
    if (!returning) return;
    const timer = setTimeout(onBack, reduced ? 0 : 640);
    return () => clearTimeout(timer);
  }, [returning, reduced, onBack]);
  const change = useCallback((patch: Partial<Scene>, capture = false) => {
    const id = crypto.randomUUID(), at = Date.now();
    mutate(current => {
      let next = updateScene(current, active, patch);
      if (capture) {
        const scene = next.subjects[active].scene;
        next = addEvidence(next, active, { id, at, scene, kind: active === 'math' && scene.page === 4 ? 'example' : 'snapshot', text: describeScene(active, scene) });
      }
      return next;
    });
  }, [active, mutate]);
  const record = useCallback((text?: string, kind: Evidence['kind'] = 'snapshot') => {
    const id = crypto.randomUUID(), at = Date.now();
    mutate(current => addEvidence(current, active, { id, at, kind, scene: current.subjects[active].scene, text: (text ?? describeScene(active, current.subjects[active].scene)).slice(0, 2000) }));
  }, [active, mutate]);
  function enter(review = false) {
    mutate(s => ({ ...s, active, subjects: { ...s.subjects, [active]: { ...s.subjects[active], visited: Date.now(), scene: review ? { ...s.subjects[active].scene, stage: 0, page: 0 } : s.subjects[active].scene } } }));
    setDirector(false); setMobilePane('lecture');
  }
  function noteCommit() {
    const before = noteStart.current; noteStart.current = null;
    if (!before) return;
    mutate(s => {
      const c = s.subjects[before.id]; if (c.note === before.text) return s;
      return { ...s, subjects: { ...s.subjects, [before.id]: { ...c, noteVersions: [...c.noteVersions, before.text].slice(-12) } } };
    });
  }
  function send() {
    const text = r.draft.trim(); if (!text) return;
    record(text, 'student');
    mutate(s => ({ ...s, subjects: { ...s.subjects, [active]: { ...s.subjects[active], draft: '' } } }));
    setNotice('已保留你的原话与当前对象状态。尚未连接真实教授，不生成虚构回答。');
  }
  function download() {
    const url = URL.createObjectURL(new Blob([learningMarkdown(store, active)], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = `reinlab-${active}-notes.md`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const common = { scene: r.scene, change, record, reduced, onMediaPlaying };
  const splitScene = active === 'math' || active === 'physics' && r.scene.stage === 0 || active === 'systems' && r.scene.stage === 1 || active === 'history' && r.scene.stage === 0;
  const displayKey = `${active}-${r.scene.stage}-${director}-${revision}-${active === 'math' ? r.scene.page : ''}-${mobilePane}`;
  const day = absenceDays(sessionVisits[active] as number | null);
  const sceneNode = active === 'math' ? <MathLesson {...common} /> : active === 'physics' ? <PhysicsLesson {...common} evidence={r.evidence} /> : active === 'systems' ? <SystemsLesson {...common} /> : active === 'history' ? <Suspense fallback={<div className="learning-loading" role="status">地理资料正在展开…</div>}><HistoryLesson {...common} /></Suspense> : active === 'guitar' ? <GuitarLesson {...common} /> : <PhotoLesson {...common} />;
  return <div className={`learning-terminal ${reduced ? 'learning-reduced' : ''} ${returning && !reduced ? 'learning-returning' : ''}`} ref={root} tabIndex={-1} aria-label={`${info.name}沉浸课堂`}>
    <div id="rhine-wide" className={`${store.largeType ? 'learning-large' : ''} ${sharedTransitionPhase === 'opening' ? 'learning-shared-opening' : ''}`} style={{ '--rl-note': store.notesWide ? '30%' : '24%' } as React.CSSProperties}>
      <header className="rl-header"><div className="rl-brand"><RhineMark /><div>莱茵生命<span>RHINE LAB · EDUCATION ARCHIVE</span></div></div><nav className="learning-top-actions" aria-label="课堂导航"><button onClick={() => { persist(lastStore.current); onMediaPlaying(false); if (onReturnStart) { onReturnStart(); return; } setReturning(true); }} disabled={returning}><ArrowLeft size={14} />归还档案</button><button onClick={() => { onMediaPlaying(false); setDirector(v => !v); }}>{director ? '回到课堂' : '主任'}</button><button className="learning-note-toggle" aria-controls="learning-notebook" aria-expanded={notesOpen} onClick={() => setNotesOpen(value => !value)}><NotebookPen size={14} />手记</button>{soundControl}<button aria-label="课堂维护" onClick={() => setMaintenance(true)}><Wrench size={15} /></button></nav></header>
      <div className="rl-layout">
        {sharedTransitionPhase === 'opening' && sharedElementSurface === 'archive' && <div className="rl-main" aria-hidden="true" />}
        <AnimatePresence initial={false} mode="sync">
          {sharedElementSurface === 'classroom' && <motion.main key={preparing ? 'prepared-study-surface' : 'classroom-study-surface'} data-surface={preparing ? 'prepared' : 'live'} className="rl-main"
            layoutId={preparing ? undefined : 'reinlab-study-surface'}
            transition={{ layout: { duration: sharedTransitionPhase === 'returning' ? .68 : .42, ease: sharedTransitionPhase === 'returning' ? [.32, .08, .3, 1] : [.2, .72, .16, 1] } }}
            onLayoutAnimationComplete={sharedTransitionPhase === 'opening' ? onSharedTransitionComplete : undefined}>
        <div className="rl-heading"><div><div className="rl-kicker">{info.code} / TEACHING SESSION</div><h1>{info.title}</h1></div><span className="rl-type">本地课堂 · 未接模型</span></div>
        {!director && <nav className="rl-stages" aria-label="课堂活动">{info.stages.map((title, i) => <button key={title} aria-pressed={r.scene.stage === i} onClick={() => { change({ stage: i as 0 | 1 }); setMobilePane('lecture'); }}>{String(i + 1).padStart(2, '0')}　{title}</button>)}</nav>}
        {!director && active === 'math' && r.scene.stage === 0 && <MathPager page={r.scene.page} onPage={page => change({ page })} />}
        {!director && splitScene && <div className="learning-pane-switch" role="group" aria-label="课堂展示视图"><button aria-pressed={mobilePane === 'lecture'} onClick={() => setMobilePane('lecture')}>讲义</button><button aria-pressed={mobilePane === 'object'} onClick={() => setMobilePane('object')}>交互对象</button></div>}
        <AnimatePresence mode="wait" initial={false}><BreathingDisplay key={displayKey} pane={mobilePane} reduced={reduced} reveal={!preparing && sharedTransitionPhase !== 'opening'}>
          {director ? <section className="learning-director"><span className="rl-kicker">COURSE DIRECTOR / 课程主任</span><h2>{day === null ? <>从一个问题，<br />开始这份档案。</> : <>欢迎回来，<br />研究员。</>}</h2><StreamCopy reduced={reduced} paused={preparing || sharedTransitionPhase === 'opening'} text={day === null ? `这里是${info.name}课堂。我负责学习接续与记录，具体讲解交给单元教授。先从一份讲义开始，再让右侧的对象帮助你验证理解。` : `${day === 0 ? '你的课堂还在原来的地方。' : `距上次打开这份课堂，已经过了${day}天。`}书签停在「${info.stages[r.scene.stage]}」。手记和${r.evidence.length}条本地证据已经保留，继续之前需要先回看讲义吗？`} /><div className="rl-controls"><button className="rl-primary" onClick={() => enter()}>{day === null ? '进入课堂' : '从书签继续'}<ArrowUpRight size={16} /></button>{day !== null && <button onClick={() => enter(true)}>先回看讲义</button>}</div><p className="rl-result">本档案只保留{info.name}的课堂与手记。其他课程请回到档案库选择。</p></section> : sceneNode}
        </BreathingDisplay></AnimatePresence>
          </motion.main>}
        </AnimatePresence>
      {notesOpen && <button className="learning-note-scrim" aria-label="关闭手记" onClick={() => setNotesOpen(false)} />}
      <div className="learning-note-shell" data-open={notesOpen}>
      <motion.aside id="learning-notebook" className="rl-notebook" aria-label="自动化助教笔记"
        initial={sharedTransitionPhase === 'opening' && !reduced ? { opacity: 0, x: 20 } : false}
        animate={(preparing || sharedTransitionPhase === 'returning') && !reduced ? { opacity: 0, x: 14 } : { opacity: 1, x: 0 }}
        transition={{ duration: reduced ? 0 : .3, delay: sharedTransitionPhase === 'opening' && !reduced ? .1 : 0, ease: [.2, .72, .16, 1] }}>
        <div className="rl-note-head"><div><div className="rl-kicker">PERSISTENT / 持久层</div><h2>{info.name}手记</h2><span className="learning-note-status">随这份档案持续保留</span></div><button className="learning-note-save" aria-label="存入手记" title="保存当前对象状态" onClick={() => record()}><BookmarkPlus size={17} /><span>收录</span></button></div>
        <section className="rl-note-section"><span className="rl-index">01 / 学习目标</span><p>{info.goal}</p></section>
        <section className="rl-note-section"><label className="rl-index" htmlFor="learning-note">02 / 我的理解 · 可直接修改</label><textarea id="learning-note" rows={5} maxLength={6000} value={r.note} onFocus={() => { noteStart.current = { id: active, text: r.note }; }} onBlur={noteCommit} onChange={e => {
          const note = e.target.value; mutate(s => ({ ...s, subjects: { ...s.subjects, [active]: { ...s.subjects[active], note } } }));
        }} /><div className="learning-note-actions"><small>自动记录不会覆盖你的文字。</small><button className="rl-small" aria-label="撤回上一次笔记编辑" disabled={!r.noteVersions.length} onClick={() => mutate(s => { const c = s.subjects[active]; if (!c.noteVersions.length) return s; return { ...s, subjects: { ...s.subjects, [active]: { ...c, note: c.noteVersions.at(-1)!, noteVersions: c.noteVersions.slice(0, -1) } } }; })}><Undo2 size={13} /></button></div></section>
        <section className="rl-note-section"><span className="rl-index">03 / 学习证据 · 本地自动整理</span>{r.evidence.length ? r.evidence.slice(older ? 0 : -5).reverse().map((e, i) => <details className="rl-evidence-item" key={e.id} open={i === 0 ? true : undefined}><summary>{e.kind === 'student' ? '你的原话 · 待核验' : e.kind === 'example' ? '教授示范 · 非独立完成' : '对象快照'} · {info.stages[e.scene.stage]}</summary><p>{e.text}</p><button onClick={() => { mutate(s => restoreEvidence(s, active, e.id)); setDirector(false); setRevision(v => v + 1); setNotice('已恢复对象快照。笔记、草稿与其他证据保持不变；新操作会创建新的记录。'); }}>回到这个状态 ↗</button></details>) : <p className="rl-empty">关键操作后自动归档；也可以手动存入快照。</p>}{r.evidence.length > 5 && <button className="rl-small" onClick={() => setOlder(v => !v)}>{older ? '收起较早记录' : `查看更早的 ${r.evidence.length - 5} 条`}</button>}</section>
        <details className="rl-tutor"><summary>教授的边注</summary><p>{active === 'math' ? '先区分研究对象、操作顺序与记号。每次得到结论，都问：我使用了哪条定义？' : active === 'history' ? '地理图只能帮助定位；路线必须有来源，模拟路径不能替代真实证据。' : '先预测，再操作；把观察与解释分开记录。这里不自动评价真实掌握程度。'}</p></details>
        <section className="rl-interaction" aria-label="在手记旁提问"><label htmlFor="learning-message" className="rl-index">{director ? '与主任沟通' : '与教授讨论'}</label><div className="rl-answer-row"><textarea id="learning-message" rows={2} maxLength={2000} placeholder="写下理解，或提出一个具体问题…" value={r.draft} onChange={e => { const draft = e.target.value; mutate(s => ({ ...s, subjects: { ...s.subjects, [active]: { ...s.subjects[active], draft } } })); }} /><button className="rl-primary" disabled={!r.draft.trim()} onClick={send}>保存提问<ArrowUpRight size={14} /></button></div><div className="rl-feedback" role="status">{storageFailed ? '浏览器存储不可用。记录暂留本次会话，建议导出手记。' : notice || '未连接真实 Agent；不生成虚构回应或成绩。'}</div></section>
        <div className="rl-note-bottom"><span>{r.evidence.length} 条证据 · 每科最多 60 条</span><button className="rl-small" aria-label="导出当前课程手记" onClick={download}><Download size={13} />导出</button></div>
      </motion.aside></div></div>
      <footer className="rl-footer"><span>RESEARCH BEGINS WITH CURIOSITY.</span><span>讲义与对象并置 · 无 WebGL · 记录保存在此浏览器</span></footer>
    </div>
    <dialog className="learning-settings" ref={dialog} aria-label="课堂维护" onCancel={() => setMaintenance(false)}><header><span>维护 / 只调整呈现</span><button aria-label="关闭课堂维护" onClick={() => setMaintenance(false)}><X size={18} /></button></header><h2>让环境适合你的思考。</h2><label><input type="checkbox" checked={store.largeType} onChange={e => mutate(s => ({ ...s, largeType: e.target.checked }))} />增大讲义字号</label><label><input type="checkbox" checked={store.notesWide} onChange={e => mutate(s => ({ ...s, notesWide: e.target.checked }))} />加宽侧边手记</label><p>当前档案的讲义、对象与手记独立保存。模型、任意代码运行、真实演奏评分均未接入。AI 画布使用固定对象操作预演。</p><small>切换课程请归还档案，回到档案库选择。</small></dialog>
  </div>;
}
