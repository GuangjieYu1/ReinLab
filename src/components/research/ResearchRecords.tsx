import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpRight, Bookmark, Check, ChevronDown, CircleHelp, Download, FlaskConical, GitBranch, Layers3, MessageSquare, Plus, Send, SlidersHorizontal, Square, Timer, X } from 'lucide-react';
import {
  addResearchNote, BASELINE_SCORE, completeResearchDemo, decideResearchExperiment, freshResearch,
  isResearchStore, MAX_DEMO_ROUNDS, MAX_RESEARCH_NOTE_LENGTH, MAX_RESEARCH_NOTES,
  normalizeResearchArchive, RESEARCH_ARCHIVES, researchChampion, researchDecision,
  researchExperiments, researchLaneInfo, researchLanes, researchMarkdown, researchStorageKey,
  researchTrend, type ResearchDecision, type ResearchExperiment, type ResearchLane, type ResearchStore,
} from './researchState';
import './research.css';

export type ResearchLabProps = {
  archiveName: string;
  reduced: boolean;
  onBack: () => void;
  backLabel?: string;
  soundControl?: ReactNode;
  onArchiveChange?: (name: string) => void;
};
type DemoPhase = 'idle' | 'proposal' | 'comparison' | 'decision';
type SidePanel = 'discussion' | 'evidence';

function readStore(archiveName: string) {
  const store = freshResearch(archiveName);
  if (typeof localStorage === 'undefined') return { store, recovery: null, warning: '' };
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(researchStorageKey(archiveName));
    if (!raw) return { store, recovery: null, warning: '' };
    if (raw.length < 150_000) {
      const candidate: unknown = JSON.parse(raw);
      if (isResearchStore(candidate, archiveName)) return { store: candidate, recovery: null, warning: '' };
    }
    return { store, recovery: raw, warning: '原有记录无法完整读取，暂用初始样例。首次修改前会备份原始内容。' };
  } catch {
    return { store, recovery: raw, warning: '本地记录暂不可读取。你仍可体验实验室，保存失败时会保留当前会话。' };
  }
}

function ResearchMark() {
  return <svg className="research-brand-mark" viewBox="0 0 40 40" aria-hidden="true">
    <path d="M11 31V9h8.3c6.1 0 9.7 2.8 9.7 7.3 0 4-2.9 6.6-7.6 7.1L30 31" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <path d="M16 9v22M11 23h10" fill="none" stroke="currentColor" strokeWidth="1" opacity=".5" />
    <circle cx="30" cy="31" r="2" fill="currentColor" />
  </svg>;
}

function LaneIcon({ lane, size = 15 }: { lane: ResearchLane; size?: number }) {
  return lane === 'architecture' ? <Layers3 size={size} /> : lane === 'optimizer' ? <SlidersHorizontal size={size} /> : <Timer size={size} />;
}

function DecisionLabel({ decision }: { decision: ResearchDecision }) {
  return <span className={`research-decision research-decision-${decision}`}>
    {decision === 'keep' ? <Check size={10} /> : decision === 'reject' ? <X size={10} /> : <span className="research-tiny-dot" />}
    {decision === 'review' ? '待判断' : decision.toUpperCase()}
  </span>;
}

function Trend({ store }: { store: ResearchStore }) {
  const id = useId().replace(/:/g, '');
  const points = researchTrend(store);
  const width = 330, left = 10, right = 310, top = 8, bottom = 56;
  const position = (score: number, index: number) => [left + index * (right - left) / (points.length - 1), bottom - (score - 91) / 5 * (bottom - top)];
  const coordinates = points.map((point, index) => position(point.score, index));
  const path = coordinates.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  const last = coordinates[coordinates.length - 1];
  return <svg className="research-trend-svg" viewBox={`0 0 ${width} 75`} role="img" aria-label={`共享最优准确率趋势，从 ${BASELINE_SCORE}% 到 ${points[points.length - 1].score.toFixed(1)}%，均为演示指标`}>
    <defs><linearGradient id={`research-trend-${id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#7a8d69" stopOpacity=".16" /><stop offset="1" stopColor="#7a8d69" stopOpacity="0" /></linearGradient></defs>
    {[16, 36, 56].map(y => <line key={y} x1={left} y1={y} x2={right} y2={y} stroke="#e7e8e0" strokeDasharray="2 4" />)}
    <path d={`${path} L${right},${bottom} L${left},${bottom} Z`} fill={`url(#research-trend-${id})`} />
    <path d={path} fill="none" stroke="#697f57" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    {coordinates.map(([x, y], index) => <circle key={points[index].id} cx={x} cy={y} r={index === coordinates.length - 1 ? 3.5 : 2} fill={index === coordinates.length - 1 ? '#64784f' : '#fafbf6'} stroke="#7d8b6c" strokeWidth="1" />)}
    <circle cx={last[0]} cy={last[1]} r="7" fill="none" stroke="#7d8b6c" strokeOpacity=".2" />
    <text x={left} y="72">BASELINE</text><text x={right} y="72" textAnchor="end">EXP {String(points.length - 1).padStart(2, '0')}</text>
  </svg>;
}

function ExperimentCard({ experiment, decision, selected, champion, onSelect, panelId }: {
  experiment: ResearchExperiment; decision: ResearchDecision; selected: boolean; champion: boolean; onSelect: () => void; panelId: string;
}) {
  return <button className={`research-experiment ${selected ? 'research-experiment-selected' : ''}`} data-decision={decision} onClick={onSelect}
    aria-pressed={selected} aria-controls={panelId} aria-label={`${experiment.id}，${experiment.title}，${experiment.score.toFixed(1)}%，${decision === 'review' ? '待判断' : decision.toUpperCase()}；查看证据`}>
    <span className="research-experiment-top"><span className="research-mono">{experiment.id}</span><DecisionLabel decision={decision} /></span>
    <span className="research-experiment-title">{experiment.title}</span>
    <span className="research-experiment-change">{experiment.change}</span>
    <span className="research-experiment-result"><span className="research-card-metric">{experiment.score.toFixed(1)}<small>%</small></span>
      <span className="research-card-delta">+{(experiment.score - BASELINE_SCORE).toFixed(1)} <small>pp</small></span>
      {champion ? <span className="research-card-champion">p*</span> : <ArrowUpRight size={14} />}
    </span>
    <span className="research-experiment-footer"><span className={`research-agent-dot research-agent-${experiment.lane}`} />{researchLaneInfo[experiment.lane].researcher}<span>{champion ? '共享最优' : '查看对照证据'}</span></span>
  </button>;
}

function PendingExperiment({ lane, phase, round }: { lane: ResearchLane; phase: DemoPhase; round: number }) {
  return <div className="research-pending-card" aria-label={`${researchLaneInfo[lane].name}演示，${phase === 'proposal' ? '展开假设' : phase === 'comparison' ? '读取对照样例' : '读取预设判定'}`}>
    <div><span className="research-mono">ROUND {String(round).padStart(2, '0')}</span><span className="research-demo-pulse" /></div>
    <p>{phase === 'proposal' ? '展开新的研究假设' : phase === 'comparison' ? '对照固定样例与基准' : '读取预设的研究判定'}</p>
    <span className="research-pending-description">本地流程演示 · 不执行训练</span>
    <span className={`research-pending-progress research-progress-${phase}`}><i /></span>
  </div>;
}

const discussionExamples = [
  { lane: 'architecture' as const, label: '提出假设', text: '先缩短信息的路径，再增加模型的复杂度。EXP-004 可以成为下一轮的结构基准。', reference: 'EXP-004' },
  { lane: 'optimizer' as const, label: '记录反例', text: '更大的学习率没有带来更好的样例结果。保留这次反例，避免下一轮重复相同尝试。', reference: 'EXP-005' },
  { lane: 'schedule' as const, label: '等待判断', text: 'EXP-006 的准确率略低，但延迟也略低。是否值得保留？把研究取舍交给你。', reference: 'EXP-006' },
];

function EvidencePanel({ experiment, store, onDecision, running, compare, setCompare }: {
  experiment: ResearchExperiment; store: ResearchStore; onDecision: (decision: ResearchDecision) => void; running: boolean;
  compare: 'baseline' | 'champion'; setCompare: (value: 'baseline' | 'champion') => void;
}) {
  const champion = researchChampion(store), decision = researchDecision(store, experiment);
  const referenceScore = compare === 'champion' ? champion?.score ?? BASELINE_SCORE : BASELINE_SCORE;
  const referenceLatency = compare === 'champion' ? champion?.latency ?? 13.4 : 13.4;
  const referenceParams = compare === 'champion' ? champion?.parameters ?? 2.8 : 2.8;
  const delta = experiment.score - referenceScore;
  return <div className="research-evidence-content">
    <div className="research-evidence-kicker"><span className="research-mono">{experiment.id}</span><DecisionLabel decision={decision} /></div>
    <h3>{experiment.title}</h3>
    <p className="research-hypothesis">{experiment.hypothesis}</p>
    <div className="research-change-label"><GitBranch size={13} /><span>{experiment.change}</span></div>
    <div className="research-evidence-section-heading"><span>对照证据</span><span className="research-demo-word">固定示例</span></div>
    <div className="research-compare-control" role="group" aria-label="选择对照基准">
      <button aria-pressed={compare === 'baseline'} onClick={() => setCompare('baseline')}>初始基准</button>
      <button aria-pressed={compare === 'champion'} onClick={() => setCompare('champion')}>共享最优 p*</button>
    </div>
    <table className="research-evidence-table">
      <caption className="research-sr-only">{experiment.id}与{compare === 'champion' ? '共享最优' : '初始基准'}的预设演示指标对比</caption>
      <thead><tr><th scope="col">演示指标</th><th scope="col">对照</th><th scope="col">本实验</th></tr></thead>
      <tbody>
        <tr><th scope="row">准确率 ↑</th><td>{referenceScore.toFixed(1)}%</td><td>{experiment.score.toFixed(1)}%</td></tr>
        <tr><th scope="row">延迟 ↓</th><td>{referenceLatency.toFixed(1)} ms</td><td>{experiment.latency.toFixed(1)} ms</td></tr>
        <tr><th scope="row">参数量 ↓</th><td>{referenceParams.toFixed(1)} M</td><td>{experiment.parameters.toFixed(1)} M</td></tr>
      </tbody>
    </table>
    <div className="research-comparison-summary">{delta > 0 ? '+' : ''}{delta.toFixed(1)} <span>个百分点 · 相对{compare === 'champion' ? '当前 p*' : '初始基准'}</span></div>
    <details className="research-evidence-details">
      <summary>查看控制条件与证据说明<ChevronDown size={13} /></summary>
      <dl><div><dt>验证集</dt><dd>固定验证集 · 示例</dd></div><div><dt>随机种子</dt><dd>17 · 演示约定</dd></div><div><dt>改变项</dt><dd>{researchLaneInfo[experiment.lane].name}</dd></div></dl>
      <p>{experiment.evidence}</p>
      <p>尚未连接数据集、模型或执行器；这些指标不能作为真实研究结论。</p>
    </details>
    <div className="research-evidence-section-heading"><span>你的研究判断</span><span>可随时修改</span></div>
    <div className="research-decision-actions">
      <button className="research-keep-action" aria-pressed={decision === 'keep'} disabled={running} onClick={() => onDecision('keep')}><Check size={14} />KEEP<span>保留</span></button>
      <button className="research-reject-action" aria-pressed={decision === 'reject'} disabled={running} onClick={() => onDecision('reject')}><X size={14} />REJECT<span>淘汰</span></button>
    </div>
    <button className="research-review-action" disabled={running || decision === 'review'} onClick={() => onDecision('review')}>暂缓判断，标记为待复核</button>
    <p className="research-decision-footnote">KEEP 会参与共享最优的比较；REJECT 保留证据，不删除实验。</p>
  </div>;
}

export default function ResearchLab(props: ResearchLabProps) {
  return <ResearchLabSession key={normalizeResearchArchive(props.archiveName)} {...props} />;
}

function ResearchLabSession({ archiveName, reduced, onBack, soundControl, onArchiveChange, backLabel = '返回档案' }: ResearchLabProps) {
  const archive = normalizeResearchArchive(archiveName);
  const [initial] = useState(() => readStore(archive));
  const [store, setStore] = useState(initial.store);
  const [sidePanel, setSidePanel] = useState<SidePanel>('discussion');
  const [compare, setCompare] = useState<'baseline' | 'champion'>('baseline');
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<DemoPhase>('idle');
  const [notice, setNotice] = useState(initial.warning);
  const [storageFailed, setStorageFailed] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const discussionScroll = useRef<HTMLDivElement>(null);
  const forumScroll = useRef<HTMLDivElement>(null);
  const lastStore = useRef(store); lastStore.current = store;
  const dirty = useRef(false);
  const recovered = useRef(false);
  const panelId = useId();
  const draftId = useId();
  const storageKey = researchStorageKey(archive);
  const change = useCallback((update: (current: ResearchStore) => ResearchStore) => {
    dirty.current = true;
    setStore(update);
  }, []);
  const persist = useCallback((value: ResearchStore, report = true) => {
    if (!dirty.current) return;
    try {
      if (initial.recovery && !recovered.current) {
        localStorage.setItem(`${storageKey}:recovery`, initial.recovery);
        recovered.current = true;
      }
      localStorage.setItem(storageKey, JSON.stringify(value));
      if (report) setStorageFailed(false);
    } catch { if (report) setStorageFailed(true); }
  }, [initial.recovery, storageKey]);
  useEffect(() => {
    const timer = setTimeout(() => persist(store), 160);
    return () => clearTimeout(timer);
  }, [store, persist]);
  useEffect(() => {
    const save = () => persist(lastStore.current, false);
    window.addEventListener('pagehide', save);
    return () => { save(); window.removeEventListener('pagehide', save); };
  }, [persist]);
  useEffect(() => { root.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    if (!running) return;
    const done = () => {
      change(completeResearchDemo);
      setRunning(false); setPhase('idle'); setSidePanel('discussion');
      setNotice('本轮演示已展开：3 个固定样例已加入实验区，可查看证据并重新判断。未执行真实训练。');
    };
    if (reduced) { done(); return; }
    const timers = [
      setTimeout(() => setPhase('comparison'), 850),
      setTimeout(() => setPhase('decision'), 1700),
      setTimeout(done, 2650),
    ];
    return () => timers.forEach(clearTimeout);
  }, [running, reduced, change]);
  useEffect(() => {
    if (sidePanel === 'discussion' && discussionScroll.current) discussionScroll.current.scrollTop = discussionScroll.current.scrollHeight;
  }, [store.round, sidePanel]);
  useEffect(() => {
    if (forumScroll.current) forumScroll.current.scrollTop = forumScroll.current.scrollHeight;
  }, [store.notes.length]);
  const experiments = researchExperiments(store.round);
  const champion = researchChampion(store);
  const selected = experiments.find(experiment => experiment.id === store.selectedId) ?? experiments[3];
  const kept = experiments.filter(experiment => researchDecision(store, experiment) === 'keep').length;
  const bestScore = champion?.score ?? BASELINE_SCORE;
  const finished = store.round >= MAX_DEMO_ROUNDS;
  const phaseText = phase === 'proposal' ? '01 · 展开假设' : phase === 'comparison' ? '02 · 比较证据' : '03 · 读取判定';
  const noteLimitReached = store.notes.length >= MAX_RESEARCH_NOTES;

  function startDemo() {
    if (running || finished) return;
    setPhase('proposal'); setRunning(true);
    setNotice('正在播放本地预设研究流程；不会调用 AI 或执行训练。');
  }
  function decide(decision: ResearchDecision) {
    change(current => decideResearchExperiment(current, selected.id, decision));
    setNotice(`${selected.id} 已${decision === 'keep' ? '保留并参与共享最优比较' : decision === 'reject' ? '淘汰，原有证据仍然保留' : '标记为待复核'}。`);
  }
  function saveNote() {
    if (!store.draft.trim() || noteLimitReached) return;
    const kind = store.draftKind;
    change(current => addResearchNote(current, { id: crypto.randomUUID(), createdAt: Date.now() }));
    setNotice(kind === 'question' ? '已保存你的研究问题，等待后续研究。尚未连接 AI，不会生成虚构回答。' : '你的手记与当前实验引用已保存在本地。');
  }
  function download() {
    const url = URL.createObjectURL(new Blob([researchMarkdown(store)], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `REINLAB-${archive.replace(/[\\/:*?"<>|]/g, '-')}-研究记录.md`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice('研究记录已导出，包含你的判断、手记与演示数据说明。');
  }

  return <div className={`research-lab ${reduced ? 'research-reduced' : ''}`} ref={root} tabIndex={-1} aria-label={`${archive} · AI 研究实验室`}>
    <header className="research-lab-header">
      <div className="research-header-brand"><ResearchMark /><span>REINLAB<small>RESEARCH DIVISION</small></span><span className="research-header-divider" /><span className="research-header-label">AI 研究实验室</span></div>
      <nav className="research-header-actions" aria-label="实验室导航">
        <button onClick={() => { persist(lastStore.current); onBack(); }} className="research-back"><ArrowLeft size={14} /><span>{backLabel}</span></button>
        <button onClick={download} className="research-icon-button" aria-label="导出研究记录" title="导出研究记录"><Download size={16} /></button>
        {soundControl}
      </nav>
    </header>
    <div className="research-lab-main">
      <div className="research-page-heading">
        <div><div className="research-eyebrow"><span className="research-tiny-square" />RESEARCH ENVIRONMENT<span className="research-eyebrow-divider">/</span>
          {onArchiveChange ? <label className="research-archive-select"><span className="research-sr-only">选择研究档案</span><select value={archive} onChange={event => onArchiveChange(event.target.value)}>
            {!RESEARCH_ARCHIVES.some(name => name === archive) && <option value={archive}>{archive}</option>}
            {RESEARCH_ARCHIVES.map(name => <option key={name} value={name}>{name}</option>)}
          </select><ChevronDown size={11} /></label> : <span>{archive}</span>}
        </div><h1>假设、实验、证据。</h1><p>让每一次尝试，都成为下一步的起点。</p></div>
        <div className="research-run-controls">
          <span className="research-demo-label"><span className="research-tiny-dot" />本地交互演示<span className="research-mono">{String(store.round).padStart(2, '0')} / 04</span></span>
          <button className={`research-run-button ${running ? 'research-run-active' : ''}`} onClick={running ? () => { setRunning(false); setPhase('idle'); setNotice('已停止本轮演示；已保存的实验与手记没有改变。'); } : startDemo} disabled={finished && !running}>
            {running ? <Square size={12} /> : <Plus size={16} />}<span>{running ? '停止演示' : finished ? '全部演示已展开' : '演示一轮研究'}</span>{!running && !finished && <ArrowRight size={15} />}
          </button>
        </div>
      </div>
      <div className="research-state-rail">
      <section className="research-shared-state" aria-label="共享研究状态">
        <div className="research-shared-intro"><span className="research-section-code"><GitBranch size={12} />SHARED STATE</span><h2>结论随证据更新</h2><p><span className="research-tiny-dot" />固定样例 · 未连接执行器</p></div>
        <div className="research-champion"><span className="research-metric-label">Champion <i>p*</i><span>{champion?.id ?? 'BASELINE'}</span></span><div className="research-main-metric">{bestScore.toFixed(1)}<small>%</small></div><span className="research-metric-caption"><ArrowUpRight size={12} />+{(bestScore - BASELINE_SCORE).toFixed(1)} pp<span>相对初始基准</span></span></div>
        <div className="research-performance"><div className="research-performance-heading"><span className="research-metric-label">PERFORMANCE</span><span>验证准确率 · 示例</span></div><Trend store={store} /></div>
        <div className="research-shared-summary"><div><span>{String(experiments.length).padStart(2, '0')}</span><span>实验记录<small>EXPERIMENTS</small></span></div><div><span>{String(kept).padStart(2, '0')}</span><span>保留方案<small>KEPT IDEAS</small></span></div></div>
      </section>
      <section className="research-forum" aria-label="研究手记与问题">
        <div className="research-forum-header"><span className="research-section-code"><Bookmark size={12} />FORUM / 手记</span><span>{String(store.notes.length).padStart(2, '0')}</span></div>
        <div className="research-forum-scroll" ref={forumScroll}>
          <article className="research-log-entry"><span className="research-mono">LAB LOG / {String(store.round + 1).padStart(3, '0')}</span><p>{champion ? `${champion.id} 暂为共享最优；未保留的方向仍可回看。` : '暂无保留方案；可以重新检查每个实验的证据。'}</p></article>
          {store.notes.map(note => <article className="research-post research-user-post" key={note.id}><div className="research-post-heading"><span className="research-avatar research-avatar-user">你</span><div><strong>我的{note.kind === 'question' ? '研究问题' : '研究手记'}</strong><span>{new Date(note.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span></div>{note.kind === 'question' ? <CircleHelp size={13} /> : <Bookmark size={13} />}</div><p>{note.text}</p><button className="research-post-reference" onClick={() => { change(current => ({ ...current, selectedId: note.experimentId })); setSidePanel('evidence'); }}><GitBranch size={10} />{note.experimentId}<ArrowUpRight size={10} /></button>{note.kind === 'question' && <span className="research-question-status">待研究 · 不生成模拟回答</span>}</article>)}
        </div>
        <form className="research-note-composer" onSubmit={event => { event.preventDefault(); saveNote(); }}>
          <div className="research-note-topline"><div role="group" aria-label="记录类型"><button type="button" aria-pressed={store.draftKind === 'note'} onClick={() => change(current => ({ ...current, draftKind: 'note' }))}><Bookmark size={11} />手记</button><button type="button" aria-pressed={store.draftKind === 'question'} onClick={() => change(current => ({ ...current, draftKind: 'question' }))}><CircleHelp size={11} />问题</button></div><span className="research-mono">{selected.id}</span></div>
          <label className="research-sr-only" htmlFor={draftId}>{store.draftKind === 'question' ? '记录待研究的问题' : '写下研究手记'}</label>
          <textarea id={draftId} value={store.draft} maxLength={MAX_RESEARCH_NOTE_LENGTH} rows={2}
            placeholder={store.draftKind === 'question' ? '这个结果，还留下了什么问题？' : '写下观察，也写下你的判断…'}
            onChange={event => change(current => ({ ...current, draft: event.target.value.slice(0, MAX_RESEARCH_NOTE_LENGTH) }))}
            onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); saveNote(); } }} />
          <div className="research-note-bottom"><span>{noteLimitReached ? '已达 40 条上限，请先导出记录' : store.draft ? `${store.draft.length} / ${MAX_RESEARCH_NOTE_LENGTH}` : '仅保存在这台设备'}</span><button type="submit" aria-label={store.draftKind === 'question' ? '保存研究问题' : '保存研究手记'} disabled={!store.draft.trim() || noteLimitReached}>{store.draftKind === 'question' ? '保存问题' : '存入手记'}<Send size={12} /></button></div>
        </form>
      </section>
      </div>
      <div className="research-workspace">
        <section className="research-experiments-panel" aria-label="研究实验画布">
          <div className="research-panel-heading"><div><span className="research-section-code"><FlaskConical size={13} />EXPERIMENTS</span><h2>让不同的思路并行生长</h2></div><span className={`research-flow-status ${running ? 'research-flow-running' : ''}`} aria-live="polite">{running ? <><span className="research-demo-pulse" />{phaseText}</> : <><span className="research-tiny-dot" />{finished ? '全部样例已展开' : '选择实验，查看证据'}</>}</span></div>
          <div className="research-experiment-canvas" aria-busy={running}>
            <div className="research-lanes">
              {researchLanes.map((lane, index) => <section className={`research-lane research-lane-${lane}`} key={lane} aria-label={`${researchLaneInfo[lane].name}实验方向`}>
                <div className="research-lane-heading"><span className="research-lane-icon"><LaneIcon lane={lane} /></span><div><h3>{researchLaneInfo[lane].name}</h3><span>{lane.toUpperCase()}</span></div><span className="research-lane-index">0{index + 1}</span></div>
                <div className="research-lane-agent"><span className={`research-avatar research-avatar-${lane}`}>{researchLaneInfo[lane].letter}</span><span>{researchLaneInfo[lane].researcher}<small>示例研究员</small></span><span className="research-agent-connection" /></div>
                <div className="research-lane-cards">
                  {running && <PendingExperiment lane={lane} phase={phase} round={store.round + 1} />}
                  {experiments.filter(experiment => experiment.lane === lane).reverse().map(experiment => <ExperimentCard key={experiment.id} experiment={experiment}
                    decision={researchDecision(store, experiment)} selected={selected.id === experiment.id} champion={champion?.id === experiment.id} panelId={panelId}
                    onSelect={() => { change(current => ({ ...current, selectedId: experiment.id })); setSidePanel('evidence'); }} />)}
                </div>
              </section>)}
            </div>
            <div className="research-canvas-caption"><span /><span>不同假设 · 相同证据标准 · 所有结果可追溯</span><span /></div>
          </div>
        </section>
        <aside className="research-discussion-panel" aria-label="研究讨论与实验证据" id={panelId}>
          <div className="research-side-heading"><span className="research-section-code"><MessageSquare size={13} />DISCUSSION</span><span className="research-forum-label">研究协同 / 固定示例</span></div>
          <div className="research-side-tabs" role="group" aria-label="研究侧栏视图">
            <button aria-pressed={sidePanel === 'discussion'} onClick={() => setSidePanel('discussion')}>研究讨论<span>{3 + (store.round ? 1 : 0)}</span></button>
            <button aria-pressed={sidePanel === 'evidence'} onClick={() => setSidePanel('evidence')}>实验证据<ArrowUpRight size={12} /></button>
          </div>
          <div className="research-side-scroll" ref={discussionScroll}>
            {sidePanel === 'discussion' ? <>
              <p className="research-discussion-disclaimer"><CircleHelp size={12} />以下为预设讨论示例，非实时 AI 输出</p>
              {discussionExamples.map(post => <article className="research-post" key={post.lane}>
                <div className="research-post-heading"><span className={`research-avatar research-avatar-${post.lane}`}>{researchLaneInfo[post.lane].letter}</span><div><strong>{researchLaneInfo[post.lane].researcher}</strong><span>{researchLaneInfo[post.lane].role} · 示例</span></div><span className="research-post-kind">{post.label}</span></div>
                <p>{post.text}</p><button className="research-post-reference" onClick={() => { change(current => ({ ...current, selectedId: post.reference })); setSidePanel('evidence'); }}><GitBranch size={10} />{post.reference}<ArrowUpRight size={10} /></button>
              </article>)}
              {store.round > 0 && <article className="research-post research-round-post"><div className="research-post-heading"><span className="research-avatar research-avatar-system"><FlaskConical size={12} /></span><div><strong>演示记录</strong><span>第 {store.round} 轮 · 固定流程</span></div><Check size={13} /></div><p>本轮的 3 个样例已加入画布。你可以改变 KEEP / REJECT 判断，观察共享状态如何随之更新。</p><span className="research-round-tag">未执行模型训练</span></article>}
            </> : <EvidencePanel experiment={selected} store={store} onDecision={decide} running={running} compare={compare} setCompare={setCompare} />}
          </div>
        </aside>
      </div>
    </div>
    <footer className="research-lab-footer"><span><span className={`research-tiny-dot ${storageFailed ? 'research-warning-dot' : ''}`} />{storageFailed ? '暂未能保存到本地，请导出保留当前记录' : 'LOCAL WORKSPACE'}<span className="research-footer-archive">{archive}</span></span><p role="status" aria-live="polite">{notice || '实验与指标均为预设演示；手记与你的判断会独立保存。'}</p><span className="research-footer-signature">REINLAB · RESEARCH</span></footer>
  </div>;
}
