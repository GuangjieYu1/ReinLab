import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUpRight, BookOpen, Check, ChevronLeft, ChevronRight, Download, FileText, GitBranch, Layers, Plus, RotateCcw, Wrench, X } from 'lucide-react';
import { RhineMark } from '../cinematic/BootStage';
import { absenceDays, COURSE_KEY, courseUnits, freshCourse, isCourseRecord, makeHandoff, submitUnitReport, type CoursePreferences, type CourseRecord, type ReadingMode } from './courseState';
import './classroom.css';

type View = 'director' | 'lesson' | 'report';
type Panel = 'progress' | 'tree' | 'maintenance' | 'resources' | null;
function readCourse(): CourseRecord {
  try { const saved = JSON.parse(localStorage.getItem(COURSE_KEY) ?? 'null'); if (isCourseRecord(saved)) return saved; } catch { /* The course remains usable without storage. */ }
  return freshCourse();
}
const rounds = [{ id: 'intro', title: '变换的直觉' }, { id: 'direction', title: '不变的方向' }, { id: 'review', title: '短暂复习', branch: true }, { id: 'check', title: '核验与反馈' }];

type SharedElementSurface = 'archive' | 'classroom';
type SharedTransitionPhase = 'opening' | 'returning' | null;
export default function ImmersiveClassroom({ reduced, sharedElementSurface = 'classroom', sharedTransitionPhase = null, preparing = false, onPrepared, soundControl, onBack, onReturnStart, onSharedTransitionReady, onSharedTransitionComplete }: {
  reduced: boolean; soundControl: ReactNode; onBack: () => void;
  preparing?: boolean; onPrepared?: () => void;
  sharedElementSurface?: SharedElementSurface; sharedTransitionPhase?: SharedTransitionPhase;
  onReturnStart?: () => void; onSharedTransitionReady?: () => void; onSharedTransitionComplete?: () => void;
}) {
  const [record, setRecord] = useState(readCourse);
  const [days] = useState(() => absenceDays(record.lastVisit));
  const [view, setView] = useState<View>('director');
  const [unit, setUnit] = useState(2);
  const [round, setRound] = useState(record.bookmark);
  const [page, setPage] = useState(0);
  const [panel, setPanel] = useState<Panel>(null);
  const [expandedVector, setExpandedVector] = useState(false);
  const [draft, setDraft] = useState('');
  const [directorReply, setDirectorReply] = useState('');
  const [feedback, setFeedback] = useState('');
  const [storageWarning, setStorageWarning] = useState(false);
  const [proposal, setProposal] = useState<CoursePreferences>(record.preferences);
  const [previousPreferences, setPreviousPreferences] = useState<CoursePreferences | null>(null);
  const [previewProposal, setPreviewProposal] = useState(false);
  const [notice, setNotice] = useState('');
  const [handedOff, setHandedOff] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [returning, setReturning] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const viewHeading = useRef<HTMLHeadingElement>(null);
  const initializedFocus = useRef(false);
  const latestRecord = useRef(record);
  latestRecord.current = record;
  const lesson = courseUnits[unit];
  const branch = record.branches.find(b => b.id === round);
  const isHistory = unit < 2;
  const isFuture = unit > 2;

  useEffect(() => { setRecord(current => ({ ...current, lastVisit: Date.now() })); }, []);
  useEffect(() => {
    try { localStorage.setItem(COURSE_KEY, JSON.stringify(record)); }
    catch { setStorageWarning(true); }
  }, [record]);
  useEffect(() => {
    const saveDeparture = () => {
      try { localStorage.setItem(COURSE_KEY, JSON.stringify({ ...latestRecord.current, lastVisit: Date.now() })); } catch { /* Optional local storage. */ }
    };
    window.addEventListener('pagehide', saveDeparture);
    return () => { window.removeEventListener('pagehide', saveDeparture); saveDeparture(); };
  }, []);
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (panel && !el.open) el.showModal();
    if (!panel && el.open) el.close();
  }, [panel]);
  useEffect(() => {
    if (!preparing && !initializedFocus.current) { initializedFocus.current = true; root.current?.focus({ preventScroll: true }); }
  }, [preparing]);
  useEffect(() => {
    if (!returning) return;
    const timer = setTimeout(onBack, reduced ? 0 : 640);
    return () => clearTimeout(timer);
  }, [returning, reduced, onBack]);
  useLayoutEffect(() => { if (preparing) onPrepared?.(); }, [preparing, onPrepared]);
  useLayoutEffect(() => {
    if (sharedTransitionPhase === 'opening' && sharedElementSurface === 'archive') onSharedTransitionReady?.();
  }, [sharedElementSurface, sharedTransitionPhase, onSharedTransitionReady]);
  const changeView = (next: View) => {
    setPanel(null); setView(next); setDraft(''); setFeedback(''); setDirectorReply(''); setNotice('');
    root.current?.scrollTo({ top: 0 });
  };
  function openUnit(index: number, review = false, target?: string) {
    setUnit(index); setRound(target ?? (review ? 'review' : record.bookmark)); setPage(0);
    setExpandedVector(false); changeView('lesson');
  }
  function chooseRound(id: string) {
    setRound(id); setPage(0); setExpandedVector(false); setFeedback(''); setPanel(null); setDraft('');
    root.current?.scrollTo({ top: 0 });
    if (rounds.some(r => r.id === id) && id !== 'review') setRecord(current => ({ ...current, bookmark: id }));
  }
  function sendMessage(event: React.FormEvent) {
    event.preventDefault();
    const question = draft.trim();
    if (!question) return;
    setDraft('');
    if (view === 'director') {
      setDirectorReply('已记下你的安排。本轮是本地交互演示，尚未连接模型；正式接入后，主任会调整学习计划，并把具体讲解交给单元教授。');
      return;
    }
    if (record.branches.length >= 40) { setNotice('本地原型最多保留 40 个追问分支。'); return; }
    const id = `branch-${crypto.randomUUID()}`;
    setRecord(current => ({ ...current, branches: [...current.branches, { id, parent: round, question }] }));
    setRound(id); setPage(0); setFeedback('');
  }
  function answer(index: 0 | 1, correct: boolean) {
    if (!correct) { setFeedback(index === 0 ? '再看看坐标：A(1, 0) = (2, 0)。它与原向量还在同一条直线上吗？' : 'v 是向量，λ 是比例系数。这里的比例系数是多少？'); return; }
    setRecord(current => { const answers: [boolean, boolean] = [...current.answers]; answers[index] = true; return { ...current, answers }; });
    setFeedback(index === 0 ? '第一项通过。再区分一下“方向”和“比例”。' : '两个示例目标均已核验，可以整理交接文件。');
  }
  function handoff() {
    if (!record.answers.every(Boolean)) return;
    setRecord(current => submitUnitReport(current)); setHandedOff(true); changeView('director');
  }
  function downloadReport() {
    const url = URL.createObjectURL(new Blob([makeHandoff(record)], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = 'linear-algebra-unit-03-demo-handoff.md'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function openPanel(next: Panel) {
    if (next === 'maintenance') { setProposal({ ...record.preferences }); setPreviewProposal(false); setConfirmReset(false); }
    setPanel(next);
  }
  const setMode = (mode: ReadingMode) => { setRecord(current => ({ ...current, preferences: { ...current.preferences, mode } })); };
  const lessonPage = page === 0 ? '有些方向，从未离开原来的直线。' : page === 1 ? '特征值，是这个方向上的比例。' : '把几何直觉，写成一个方程。';
  const showGeometry = record.preferences.mode === 'document' || page === 0;
  const showRatio = record.preferences.mode === 'document' || page === 1;
  const showEquation = record.preferences.mode === 'document' || page === 2;

  return <div className={`course-terminal ${reduced ? 'course-reduced' : ''} ${record.preferences.largeType ? 'course-large-type' : ''} ${returning && !reduced ? 'course-returning' : ''} ${sharedTransitionPhase === 'opening' ? 'course-shared-opening' : ''}`} ref={root} tabIndex={-1} aria-label="线性代数沉浸课堂" data-view={view}>
    <div className="course-shell-edge" aria-hidden="true"><div className="course-edge-ring" /><span>RHINE LAB / LA—001</span><i /></div>
    <header className="course-header">
      <div className="course-brand"><RhineMark /><div>RHINE LAB<span>INTERNAL LEARNING ARCHIVE</span></div></div>
      <nav aria-label="课堂终端导航">
        <button aria-label="归还档案" onClick={() => { if (onReturnStart) { onReturnStart(); return; } setReturning(true); }} disabled={returning}><ArrowLeft size={14} /><span>归还档案</span></button>
        {soundControl}
        <button onClick={() => openPanel('maintenance')} aria-label="终端维护"><Wrench size={15} /><span>维护</span></button>
      </nav>
    </header>
    <div className="course-identity"><div><span className="course-code">COURSE FILE / LA—001</span><h1>线性代数<span>Linear algebra</span></h1></div><span className="course-local-label">本地课堂原型 · 无模型连接</span></div>
    <button className="course-spine-index" onClick={() => openPanel('progress')} aria-label="打开课程进度"><span>INDEX</span><div>{courseUnits.map((_, i) => <i key={i} className={i < (record.passed ? 3 : 2) ? 'done' : ''} />)}</div><b>{record.passed ? '03' : '02'}<small> / 06</small></b></button>
    <AnimatePresence initial={false} mode="sync">
      {sharedElementSurface === 'classroom' && <motion.main key={preparing ? 'prepared-study-surface' : 'classroom-study-surface'} data-surface={preparing ? 'prepared' : 'live'} className="course-main"
        layoutId={preparing ? undefined : 'reinlab-study-surface'}
        transition={{ layout: { duration: sharedTransitionPhase === 'returning' ? .68 : .42, ease: sharedTransitionPhase === 'returning' ? [.32, .08, .3, 1] : [.2, .72, .16, 1] } }}
        onLayoutAnimationComplete={sharedTransitionPhase === 'opening' ? onSharedTransitionComplete : undefined}>
      <div className="course-fold-seam"><span className="course-seam-square" /><span>{view === 'director' ? 'COURSE DIRECTOR' : view === 'report' ? 'LEARNING RECORD' : `UNIT ${String(unit + 1).padStart(2, '0')} / PROFESSOR`}</span><i /><span className="course-seam-end">+</span></div>
      <AnimatePresence mode="wait" initial={false}>
        <motion.section className="course-open-page" key={`${view}-${unit}-${round}`}
          initial={preparing || reduced || sharedTransitionPhase === 'opening' ? false : { opacity: 0, scaleY: .04, rotateX: 7 }}
          animate={{ opacity: 1, scaleY: 1, rotateX: 0 }}
          exit={{ opacity: 0, scaleY: reduced ? 1 : .035, rotateX: reduced ? 0 : -5 }}
          transition={{ duration: reduced ? 0 : .38, ease: [.22, 1, .36, 1] }}
          onAnimationComplete={() => { if (view !== 'director') viewHeading.current?.focus({ preventScroll: true }); }}>
          {view === 'director' ? <>
            <div className="course-agent-label"><span />课程主任<span className="course-agent-note">学习接续</span></div>
            <h2 className="course-welcome">{handedOff ? <>这一步，<br />已经留下记录。</> : <>欢迎回来，<br /><span>研究员。</span></>}</h2>
            <div className="course-welcome-copy">
              <p>{handedOff ? '教授的交接记录已收到，两个示例目标通过核验。' : days === null ? '距上次学习，已经过了 8 天。' : days === 0 ? '你的课堂还在原来的地方。' : `距上次学习，已经过了 ${days} 天。`}</p>
              <p>{handedOff ? '推导与迁移能力仍待确认；我不会把完成阅读，等同于掌握。' : `上次，你停在了「${rounds.find(r => r.id === record.bookmark)?.title ?? '不变的方向'}」。`}</p>
              {!handedOff && days === null && <span className="course-example-note">首次预览：8 天间隔及既往学习记录为示例</span>}
              <p className="course-invitation">{handedOff ? '要回看刚才的课堂，还是整理一下下一步？' : '继续之前，要先找回一点感觉吗？'}</p>
              <div className="course-welcome-actions"><button className="course-action-main" onClick={() => openUnit(2, !handedOff)}>{handedOff ? '回看本次课堂' : '先做一次短复习'}<ArrowUpRight size={17} /></button><button className="course-action-subtle" onClick={() => handedOff ? openPanel('progress') : openUnit(2)}>{handedOff ? '查看更新的学习记录' : '从上次继续'}<ArrowRight size={15} /></button></div>
              <button className="course-record-link" onClick={() => openPanel('progress')}><span className="course-record-line" />{record.passed ? '03' : '02'} / 06 单元 · 查看进度与复习依据<Plus size={12} /></button>
            </div>
            {directorReply && <div className="course-local-reply"><span>主任 · 演示回应</span><p>{directorReply}</p></div>}
          </> : view === 'report' ? <>
            <div className="course-agent-label"><FileText size={13} />教授的单元交接</div>
            <h2 className="course-lesson-title" ref={viewHeading} tabIndex={-1}>把理解，留下依据。</h2>
            <p className="course-lesson-lead">这是一份待交给主任的记录，而不是一句“已经学会”。</p>
            <div className="course-report-sheet"><span>UNIT 03 / HANDOFF.md</span><h3>特征方向 · 示例核验记录</h3><dl><div><dt>已核验</dt><dd>辨认特征方向；区分特征向量与特征值。</dd></div><div><dt>待核验</dt><dd>特征多项式推导、独立解题和间隔后的回忆。</dd></div><div><dt>保留的上下文</dt><dd>{record.branches.length} 个追问分支；原有学习书签。</dd></div><div><dt>记录边界</dt><dd>仅覆盖两个演示目标，不代表真实课程已掌握。</dd></div></dl><button className="course-text-button" onClick={downloadReport}><Download size={14} />下载演示记录</button></div>
            <div className="course-welcome-actions"><button className="course-action-main" disabled={!record.answers.every(Boolean)} onClick={handoff}>交给主任<ArrowUpRight size={17} /></button><button className="course-action-subtle" onClick={() => { setRound('check'); changeView('lesson'); }}>回到核验<ArrowLeft size={14} /></button></div>
          </> : <>
            <div className="course-lesson-topline"><div className="course-agent-label"><span />单元教授<span className="course-agent-note">{isHistory ? '历史回看' : isFuture ? '课程预告' : round === 'review' ? '复习分支' : '教学与核验'}</span></div><div className="course-reading-controls"><button aria-label="卡片阅读" aria-pressed={record.preferences.mode === 'cards'} onClick={() => setMode('cards')}><Layers size={14} /></button><button aria-label="连续讲义阅读" aria-pressed={record.preferences.mode === 'document'} onClick={() => setMode('document')}><BookOpen size={14} /></button><button aria-label="打开课堂分支" onClick={() => openPanel('tree')}><GitBranch size={14} /></button></div></div>
            {isHistory || isFuture ? <>
              <h2 className="course-lesson-title" ref={viewHeading} tabIndex={-1}>{lesson.title}</h2><p className="course-lesson-lead">{lesson.subtitle}</p><div className="course-history-note"><span>{isHistory ? 'SAVED CLASSROOM / 历史示例' : 'UPCOMING / 尚未开启'}</span><p>{lesson.summary}</p><p>{isHistory ? '回看历史不会覆盖第三单元的书签，也不会让课程进度倒退。' : '当前原型只完整演示第三单元。此处仅预览课程目标，不生成虚构教学记录。'}</p></div><button className="course-action-main" onClick={() => openUnit(2)}>回到上次学习书签<ArrowRight size={16} /></button>
            </> : branch ? <>
              <div className="course-question"><span>你的追问 · 从「{rounds.find(r => r.id === branch.parent)?.title ?? '已有追问'}」分支</span><p>{branch.question}</p></div><h2 className="course-lesson-title" ref={viewHeading} tabIndex={-1}>为这个问题，留一条支线。</h2><div className="course-history-note"><p>这条追问已保留在本地课堂树里，原来的课堂没有被覆盖。</p><p>尚未连接 DeepSeek Harness，因此不会伪装成真实教授回答。接入后，教授将在这里展开与你的问题对应的完整教学回应。</p></div><button className="course-action-subtle" onClick={() => chooseRound(branch.parent)}>回到分支起点<ArrowLeft size={15} /></button>
            </> : round === 'check' ? <>
              <h2 className="course-lesson-title" ref={viewHeading} tabIndex={-1}>先确认，我们真的理解了。</h2><p className="course-lesson-lead">两个短问题。不是按阅读时间判断掌握。</p>
              <div className="course-check-block"><span>01 / 几何方向 {record.answers[0] && <Check size={14} />}</span><p>A = diag(2, 1)，v = (1, 0)。施加 A 后，v 会怎样？</p><div className="course-answer-options"><button className={record.answers[0] ? 'correct' : ''} onClick={() => answer(0, true)}>方向不变，长度变成 2 倍</button><button onClick={() => answer(0, false)}>旋转 90°，长度不变</button></div></div>
              <div className="course-check-block"><span>02 / 概念区分 {record.answers[1] && <Check size={14} />}</span><p>在 Av = 2v 中，这个方向对应的特征值是什么？</p><div className="course-answer-options"><button onClick={() => answer(1, false)}>向量 (1, 0)</button><button className={record.answers[1] ? 'correct' : ''} onClick={() => answer(1, true)}>数值 2</button></div></div>
              <p className="course-check-feedback" role="status">{feedback || '这里使用固定题目与本地判定，仅演示教授的核验流程。'}</p><button className="course-action-main" disabled={!record.answers.every(Boolean)} onClick={() => changeView('report')}>整理单元交接文件<ArrowUpRight size={17} /></button>
            </> : <>
              <div className="course-question"><span>{round === 'review' ? '你的选择 · 先做一次短复习' : '上次的提问'}</span><p>{round === 'review' ? '“先帮我找回变换的几何直觉。”' : '“能不能先不背公式，从图形理解特征向量？”'}</p></div>
              <h2 className="course-lesson-title" ref={viewHeading} tabIndex={-1}>{round === 'intro' ? '先看，空间怎样发生变化。' : round === 'review' ? '从一个熟悉的方向，重新开始。' : lessonPage}</h2>
              <motion.div className="course-teaching-content" key={`${page}-${record.preferences.mode}`} initial={reduced ? false : { opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reduced ? 0 : .3 }}>
                {showGeometry && <section className="course-geometric-lesson"><p>想象把水平方向拉长两倍、竖直方向保持不变。沿着水平方向的向量，不会偏离原来的直线。</p><div className="course-vector-study"><svg viewBox="0 0 560 220" role="img" aria-label={expandedVector ? '向量由一单位伸长至两单位，方向不变' : '水平的一单位向量'}><defs><pattern id="classroom-grid" width="28" height="28" patternUnits="userSpaceOnUse"><path d="M28 0H0V28" fill="none" stroke="#d4d8c840" strokeWidth="1" /></pattern></defs><rect width="560" height="220" fill="url(#classroom-grid)" /><path d="M70 182V34M42 154H513" stroke="#b4bcaa" strokeWidth="1" fill="none" /><path d="M70 154H180" stroke="#aeb89d" strokeWidth="2" strokeDasharray="3 4" /><g className={expandedVector ? 'vector-transformed' : ''}><path className="course-vector-line" d="M70 154H180" fill="none" stroke="#66744e" strokeWidth="3" /><path className="course-vector-tip" d="M172 149L180 154L172 159" fill="none" stroke="#66744e" strokeWidth="2" /></g><text x="48" y="178">0</text><text x="174" y="178">1</text><text x="284" y="178">2</text><text x="495" y="178">x</text><text x="52" y="31">y</text><text x="352" y="72">{expandedVector ? 'Av = 2v' : 'v = (1, 0)'}</text></svg><button className="course-text-button" onClick={() => setExpandedVector(v => !v)}>{expandedVector ? <RotateCcw size={13} /> : <ArrowUpRight size={13} />}{expandedVector ? '还原向量' : '施加一次变换'}</button></div></section>}
                {showRatio && <section className="course-ratio-lesson"><div>Av = <span>λ</span>v</div><p>v 是那个保持在同一直线上的方向；λ 是变换的比例。在刚才的例子里，Av = 2v，所以 λ = 2。</p><p className="course-quiet-note">λ 也可能为负数：向量会反向，但仍在同一条直线上。</p></section>}
                {showEquation && <section className="course-equation-lesson"><div>(A − λI)v = 0</div><p>把 λv 移到等式左侧。因为特征向量 v 不能为零，我们要找的是：什么样的 λ，能让这个齐次方程存在非零解？</p><p className="course-quiet-note">这里先留下推导线索；完整推导与迁移能力仍需教授进一步核验。</p></section>}
              </motion.div>
              <div className="course-lesson-bottom"><button className="course-text-button" onClick={() => openPanel('resources')}><FileText size={13} />本轮讲义与资料</button>{record.preferences.mode === 'cards' ? <div className="course-pagination"><button aria-label="上一张回应卡片" disabled={page === 0} onClick={() => setPage(p => p - 1)}><ChevronLeft size={16} /></button><span>0{page + 1} / 03</span><button aria-label="下一张回应卡片" disabled={page === 2} onClick={() => setPage(p => p + 1)}><ChevronRight size={16} /></button></div> : <span className="course-quiet-note">连续讲义 · 同一轮完整回应</span>}</div>
              <button className="course-next-step" onClick={() => chooseRound(round === 'review' ? record.bookmark === 'review' ? 'direction' : record.bookmark : 'check')}>{round === 'review' ? '回到上次的学习位置' : '我理解了，开始核验'}<ArrowRight size={15} /></button>
            </>}
            <button className="course-director-return" onClick={() => changeView('director')}><ArrowLeft size={12} />随时回到主任</button>
          </>}
        </motion.section>
      </AnimatePresence>
      {view !== 'report' && (view === 'director' || !isFuture && !isHistory) && <form className="course-input-line" onSubmit={sendMessage}><label htmlFor="course-message">{view === 'director' ? '与主任沟通' : '继续向教授提问'}<span>{view === 'director' ? '进度 · 节奏 · 安排' : '新追问将保留为课堂分支'}</span></label><div><input id="course-message" value={draft} maxLength={1000} onChange={e => setDraft(e.target.value)} placeholder={view === 'director' ? '今天想怎样安排学习？' : '这里，还有哪里不明白？'} autoComplete="off" /><button type="submit" aria-label={view === 'director' ? '发送给主任' : '发送给教授'} disabled={!draft.trim()}><ArrowUpRight size={19} /></button></div></form>}
      </motion.main>}
    </AnimatePresence>
    <footer className="course-footer"><span>RESEARCH BEGINS WITH CURIOSITY.</span><span>学习记录仅保存在此浏览器 · 演示数据</span></footer>
    {(notice || storageWarning) && <p className="course-notice" role="status">{storageWarning ? '浏览器存储不可用，本次记录仅在当前会话中保留。' : notice}</p>}
    <dialog className="course-drawer" aria-label={panel === 'progress' ? '课程进度' : panel === 'tree' ? '课堂分支' : panel === 'maintenance' ? '课程终端维护' : '课堂资料'} ref={dialog} onCancel={() => setPanel(null)} onClick={event => { if (event.target === event.currentTarget) { const r = event.currentTarget.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) setPanel(null); } }}>
      <div className="course-drawer-head"><span>{panel === 'progress' ? 'LEARNING RECORD' : panel === 'tree' ? 'CLASSROOM BRANCHES' : panel === 'maintenance' ? 'TERMINAL MAINTENANCE' : 'CLASSROOM SOURCES'}</span><button onClick={() => setPanel(null)} aria-label="关闭侧页"><X size={18} /></button></div>
      {panel === 'progress' && <><h2>每一步，都可以回去。</h2><p className="course-drawer-description">课程进度与课堂证据。回看节点不改变当前书签。</p><div className="course-unit-index">{courseUnits.map((u, i) => <button key={u.title} onClick={() => openUnit(i)}><span>0{i + 1}</span><div><strong>{u.title}</strong><small>{i < 2 ? '已核验 · 示例历史' : i === 2 ? record.passed ? '示例目标已核验 · 推导待核验' : '上次停留 · 待核验' : '尚未开启'}</small></div>{i < (record.passed ? 3 : 2) ? <Check size={14} /> : <ArrowUpRight size={14} />}</button>)}</div><section className="course-memory-note"><span>RECALL / 复习依据</span><h3>不是一条曲线，就能说明你记得多少。</h3><svg viewBox="0 0 300 130" role="img" aria-label="复习节奏示意，不代表学生实际记忆率"><path d="M14 17V106H287" stroke="#c2c8b7" fill="none" /><path d="M15 24C42 79 87 90 287 96" stroke="#acb49e" strokeWidth="1.5" strokeDasharray="3 4" fill="none" /><path d="M15 24C30 56 47 76 74 81L75 23C110 59 133 71 155 77L156 22C192 50 242 66 287 70" stroke="#758465" strokeWidth="2" fill="none" /><text x="15" y="123">学习后</text><text x="222" y="123">间隔时间 →</text></svg><p>遗忘曲线仅作为复习节奏示意。主任依据课堂核验、错误与复习记录更新侧写，不把示意曲线当作个人记忆预测。</p></section></>}
      {panel === 'tree' && <><h2>保留走过的每条支线。</h2><p className="course-drawer-description">一个节点，包含一次用户输入和对应的完整教授回应。</p><div className="course-round-tree">{rounds.map(r => <button key={r.id} className={`${round === r.id ? 'selected' : ''} ${r.branch ? 'branch' : ''}`} onClick={() => { setUnit(2); chooseRound(r.id); }}><i /><span>{r.title}<small>{r.branch ? '复习分支 · 不覆盖主线书签' : '示例课堂回合'}</small></span><ArrowUpRight size={13} /></button>)}{record.branches.map(b => <button className={`branch ${round === b.id ? 'selected' : ''}`} key={b.id} onClick={() => { setUnit(2); chooseRound(b.id); }}><i /><span>{b.question}<small>追问 · 来自 {rounds.find(r => r.id === b.parent)?.title ?? '已有分支'}</small></span><ArrowUpRight size={13} /></button>)}</div></>}
      {panel === 'maintenance' && <><h2>调整环境，不打断思考。</h2><p className="course-drawer-description">维护工程师只管理终端呈现。本轮仅演示界面偏好，不执行代码，也不改写教学记录。</p><label className="course-maintenance-control">默认阅读方式<select value={proposal.mode} onChange={e => { setProposal(p => ({ ...p, mode: e.target.value as ReadingMode })); setPreviewProposal(false); }}><option value="cards">逐页卡片</option><option value="document">连续讲义</option></select></label><label className="course-maintenance-toggle"><input type="checkbox" checked={proposal.largeType} onChange={e => { setProposal(p => ({ ...p, largeType: e.target.checked })); setPreviewProposal(false); }} />增大课堂正文字号</label><button className="course-action-subtle" onClick={() => setPreviewProposal(true)}>先看修改预览<ArrowDown size={14} /></button>{previewProposal && <div className={`course-maintenance-preview ${proposal.largeType ? 'large' : ''}`}><span>修改预览 · {proposal.mode === 'cards' ? '逐页卡片' : '连续讲义'}</span><p>让讲义适合你的阅读节奏。</p><small>只修改阅读方式与字号。进度、答案、分支均保持不变。</small><button className="course-action-main" onClick={() => { setPreviousPreferences(record.preferences); setRecord(r => ({ ...r, preferences: { ...proposal } })); setPanel(null); setNotice('终端呈现已调整。可以在维护侧页撤回上一次修改。'); }}>确认应用<Check size={14} /></button></div>}{previousPreferences && <button className="course-text-button" onClick={() => { setRecord(r => ({ ...r, preferences: previousPreferences })); setProposal(previousPreferences); setPreviousPreferences(null); setPreviewProposal(false); setNotice('上一次呈现修改已撤回。'); }}><RotateCcw size={13} />撤回上一次修改</button>}</>}
      {panel === 'resources' && <><h2>讲义，与它的来处。</h2><p className="course-drawer-description">以下只包含当前原型的本地示例内容。不伪造文献或视频来源。</p><button className="course-resource-row" onClick={() => { setMode('document'); setPanel(null); }}><BookOpen size={18} /><span>特征方向 · 连续讲义<small>当前回应的完整阅读版本</small></span><ArrowUpRight size={14} /></button><button className="course-resource-row" onClick={() => { setMode('cards'); setPage(0); setPanel(null); }}><Layers size={18} /><span>三页教学卡片<small>几何直觉 → 比例 → 方程</small></span><ArrowUpRight size={14} /></button><div className="course-resource-placeholder"><span>视频资料</span><p>待课程资源接入。正式课堂由教授引用经过确认的视频链接；当前不提供虚构播放入口。</p></div></>}
      {panel === 'maintenance' && <div className="course-demo-reset"><button className="course-text-button" onClick={() => setConfirmReset(true)}>重置本课程的演示记录</button>{confirmReset && <><p>将清除本课程的示例核验、追问、书签和阅读偏好；其他工作区不受影响。</p><button className="course-action-subtle" onClick={() => { setRecord(freshCourse()); setUnit(2); setRound('direction'); setPage(0); setHandedOff(false); setPreviousPreferences(null); setConfirmReset(false); changeView('director'); }}>确认重置演示记录</button><button className="course-text-button" onClick={() => setConfirmReset(false)}>保留记录</button></>}</div>}
    </dialog>
  </div>;
}
