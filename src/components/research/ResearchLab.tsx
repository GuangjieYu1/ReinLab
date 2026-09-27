import { useEffect, useRef, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { ArrowLeft, Pause, Play, RotateCcw, X, NotebookPen, History, ArrowRight } from 'lucide-react';
import ResearchRecords, { type ResearchLabProps } from './ResearchRecords';
import { groupCenters, sceneGroups } from './researchScene';
import { nextResearchEvent, projectResearchEvents, workflowPosition, workflowScript, type ResearchEvent, type Task } from './researchWorkflow';
import './research-reference.css';
export type { ResearchLabProps } from './ResearchRecords';
type Selection = { kind: 'agent'; id: number } | { kind: 'task' | 'event'; id: string } | { kind: 'group'; id: number } | { kind: 'log' | 'forum' | 'champion' | 'discussion' | 'report' };
const executionText = { running: '执行中', completed: '已完成', blocked: '待资源' };
const verdictText = { pending: '未判断', unsupported: '本轮未支持', candidate: '待核验', supported: '条件内支持' };

function SvgButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return <g className="ref-svg-button" role="button" tabIndex={0} aria-label={label} onClick={onClick} onKeyDown={event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onClick(); }
  }}>{children}</g>;
}
function PaperStack({ x, y, count, color = '#e4e2dc' }: { x: number; y: number; count: number; color?: string }) {
  return <g aria-hidden="true">{Array.from({ length: Math.min(count, 7) }, (_, i) => <g key={i}>
    <rect x={x + (i % 3) * 8} y={y - i * 7} width="40" height="25" rx="2" fill={color} stroke="#a6a39b" strokeWidth=".8" />
    <path d={`M${x + (i % 3) * 8 + 7} ${y - i * 7 + 8}h22 m-22 5h15`} stroke="#aaa69d" strokeWidth="1" />
  </g>)}</g>;
}

export default function ResearchLab(props: ResearchLabProps) {
  // Keying the session keeps archives separate without touching legacy persistent notes.
  return <ResearchSession key={props.archiveName} {...props} />;
}
function ResearchSession(props: ResearchLabProps) {
  const [events, setEvents] = useState<ResearchEvent[]>([]);
  const [mode, setMode] = useState<'manual' | 'auto'>('manual');
  const [running, setRunning] = useState(!props.reduced);
  const [cursor, setCursor] = useState<number | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [records, setRecords] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const focusOrigin = useRef<Element | null>(null);
  const visibleEvents = cursor === null ? events : events.slice(0, cursor);
  const state = projectResearchEvents(visibleEvents);
  const liveState = projectResearchEvents(events);
  const lastEvent = visibleEvents.at(-1);
  const waiting = events.length === 10 && mode === 'manual';
  const finished = events.length === workflowScript.length;
  const replaying = cursor !== null;

  useEffect(() => { root.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => { if (props.reduced) setRunning(false); }, [props.reduced]);
  useEffect(() => { if (selection) panel.current?.focus({ preventScroll: true }); }, [selection]);
  useEffect(() => {
    if (!running || waiting || finished || replaying || records || selection) return;
    const timer = setTimeout(() => {
      if (document.hidden) { setRunning(false); return; }
      setEvents(current => { const next = nextResearchEvent(current, mode); return next ? [...current, next] : current; });
    }, 1600);
    return () => clearTimeout(timer);
  }, [events.length, mode, running, waiting, finished, replaying, records, selection]);

  function inspect(value: Selection) { if (!selection) focusOrigin.current = document.activeElement; setSelection(value); }
  function closeInspector() { setSelection(null); const el = focusOrigin.current; if (el instanceof HTMLElement || el instanceof SVGElement) el.focus({ preventScroll: true }); }
  function step() { setRunning(false); setEvents(current => { const next = nextResearchEvent(current, mode); return next ? [...current, next] : current; }); }
  function approve() {
    if (replaying || !waiting) return;
    setEvents(current => { const next = nextResearchEvent(current, 'manual', true); return next ? [...current, next] : current; });
    setSelection(null); setRunning(true);
  }
  function reset() { setRunning(false); setCursor(null); setEvents([]); setSelection(null); }
  function taskDetails(task: Task) {
    return <article className="wf-task-detail" key={task.id}>
      <div className="wf-detail-kicker">{task.id} / {task.agents.map(id => `a${id}`).join(' · ')}</div><h3>{task.title}</h3>
      <p>{task.hypothesis}</p><div className="wf-status-pair"><span>执行：{executionText[task.execution]}</span><span>判断：{verdictText[task.verdict]}</span></div>
      <dl><dt>输入与约束</dt><dd>{task.input}</dd><dt>方法</dt><dd>{task.method}</dd><dt>观察</dt><dd>{task.finding}</dd><dt>产物</dt><dd>{task.execution === 'running' ? '尚未生成；执行完成后才会存入 Log。' : task.artifact}</dd></dl>
      {task.execution !== 'running' && <pre>{`# ${task.id} / SIMULATED ARTIFACT\ndata_version: D2\nconfig: C4\nseed: 17\nexecution: ${task.execution}\nmetric: ${task.score?.toFixed(4) ?? 'not_available'}\ncomparison_checked: ${task.verified ? 'yes (simulated)' : 'no'}\nsource: local_fixture`}</pre>}
      <p className="wf-disclaimer">这是可核对的演示文本，不是真实运行日志、代码仓库或实验数据。</p>
      {state.posts.some(post => post.task === task.id) && <button className="wf-link" onClick={() => inspect({ kind: 'forum' })}>查看引用 {task.id} 的解释与质疑 →</button>}
    </article>;
  }
  if (records) return <ResearchRecords {...props} backLabel="返回实验场景" onBack={() => setRecords(false)} />;

  return <div className={`research-lab research-reference research-workflow${props.reduced ? ' research-reduced' : ''}`} ref={root} tabIndex={-1} aria-label={`${props.archiveName} · AI 研究实验室`}>
    <header className="reference-header">
      <button onClick={props.onBack}><ArrowLeft size={14} />返回档案</button>
      <span>REINLAB <span>/</span> {props.archiveName} <span>/</span> 事件模拟</span>
      <div><button onClick={() => { setRunning(false); setRecords(true); }}><NotebookPen size={14} />原有记录</button>{props.soundControl}</div>
    </header>
    <div className="wf-mission"><span>RESEARCH QUESTION</span><p>固定计算预算下，模型结构的收益是否依赖优化方法？</p><button onClick={() => inspect({ kind: 'report' })}>研究报告 <span>{state.reportReady ? 'v2' : 'v1'}</span><ArrowRight size={12} /></button></div>
    <main className="research-lab-main reference-main">
      <svg className="reference-scene" role="group" viewBox="0 0 1120 720" aria-label="事件驱动研究场景：共享成果、跨组讨论与三条研究方向">
        <text className="ref-label" x="35" y="40">SHARED STATE</text><rect className="ref-shared-box" x="25" y="56" width="245" height="626" rx="18" />
        <SvgButton label="查看 Champion 的依据与限制" onClick={() => inspect({ kind: 'champion' })}>
          <rect className="wf-hitbox" x="34" y="64" width="227" height="232" rx="10" />
          <text className="ref-title" x="147" y="92" textAnchor="middle">Champion <tspan fontStyle="italic">p*</tspan></text>
          {!state.champion ? <><text className="ref-muted" x="147" y="172" textAnchor="middle">等待候选核验</text><text className="ref-small" x="147" y="200" textAnchor="middle">不以讨论共识替代证据</text></> : <>
            <text className="ref-small" x="47" y="128">{state.champion.id} · 比较条件已核验（模拟）</text><path className="ref-chart-axis" d="M52 144V238H244" />
            <motion.path key={state.champion.id} d={state.champion.id === 'E11' ? 'M68 215L228 154' : 'M68 215H228'} fill="none" stroke="#5d7362" strokeWidth="2" initial={{ pathLength: props.reduced ? 1 : 0 }} animate={{ pathLength: 1 }} transition={{ duration: .8 }} />
            <text className="ref-score" x="242" y="264" textAnchor="end">{state.champion.score!.toFixed(4)}</text>
          </>}
          <text className="ref-small" x="147" y="285" textAnchor="middle">固定验证任务 · 当前候选，不是定论</text>
        </SvgButton>
        <SvgButton label={`打开 Log，${visibleEvents.filter(e => e.kind === 'result').length} 条结果`} onClick={() => inspect({ kind: 'log' })}>
          <rect className="wf-hitbox" x="34" y="307" width="227" height="190" rx="10" /><text className="ref-title" x="147" y="349" textAnchor="middle">Log</text>
          <PaperStack x={125} y={430} count={visibleEvents.filter(e => e.kind === 'result').length} /><text className="ref-small" x="147" y="480" textAnchor="middle">事实与产物 / {visibleEvents.filter(e => e.kind === 'result').length}</text>
        </SvgButton>
        <SvgButton label={`打开 Forum，${state.posts.length} 条讨论`} onClick={() => inspect({ kind: 'forum' })}>
          <rect className="wf-hitbox" x="34" y="510" width="227" height="162" rx="10" /><text className="ref-title" x="147" y="541" textAnchor="middle">Forum</text>
          <PaperStack x={125} y={610} count={state.posts.length} color="#f1e5cd" /><text className="ref-small" x="147" y="656" textAnchor="middle">解释、质疑与决定 / {state.posts.length}</text>
        </SvgButton>
        <text className="ref-label" x="742" y="74" textAnchor="middle">DISCUSSION</text>
        <ellipse className="ref-discussion-orbit" cx="742" cy="232" rx="327" ry="118" />
        {!state.discussion && !state.approved ? <><text className="wf-orbit-hint" x="742" y="229" textAnchor="middle">让证据先发生。</text><text className="ref-small" x="742" y="254" textAnchor="middle">出现跨组分歧时，仅召集相关研究员</text></> : <SvgButton label="打开跨组讨论与决策记录" onClick={() => inspect({ kind: 'discussion' })}>
          <rect className="wf-topic-card" x="567" y="164" width="350" height="123" rx="9" />
          <text className="wf-topic-kicker" x="585" y="186">{state.approved ? 'DECISION RECORDED / 已形成决定' : 'D01 / 跨组讨论'}</text>
          <text className="wf-topic-title" x="585" y="215">结构收益是否依赖优化方法？</text>
          <text className="ref-small" x="585" y="240">{state.approved ? '收窄 H1 → a2、a5 联合对照 → a3 核验' : 'E07 未支持预期；a5 质疑优化设置的影响'}</text>
          <text className="wf-topic-link" x="585" y="266">{state.approved ? '查看决定、依据与新任务 E11 →' : replaying ? '历史状态 · 查看本轮讨论 →' : mode === 'manual' ? '等待你的决定 · 查看证据并确认 →' : '按规则 R1 确认匹配预算对照 →'}</text>
        </SvgButton>}
        {sceneGroups.map((group, lane) => {
          const x = groupCenters[lane], tasks = state.tasks.filter(task => task.lane === lane);
          const status = lane === 2 && tasks.some(t => t.execution === 'blocked') ? '待资源 · 不作研究判断' : state.discussion && lane === 0 ? '暂缓原方案 · 进入复核' : lane === 0 && state.approved ? 'H1′ · 联合验证' : ['H1 · 结构是否限制表现？', 'H2 · 优化是否限制收敛？', 'H3 · 调度是否影响表现？'][lane];
          return <g key={group} className={`ref-group ref-group-${lane}`}>
            <SvgButton label={`研究方向 ${group}`} onClick={() => inspect({ kind: 'group', id: lane })}>
              <text className="ref-group-title" x={x} y="392" textAnchor="middle">{group}</text><text className="ref-small" x={x} y="416" textAnchor="middle">{status}</text><rect className="ref-group-box" x={x - 103} y="428" width="206" height="237" rx="17" />
            </SvgButton>
            <text className="ref-label ref-experiments-title" x={x - 85} y="529">EXPERIMENTS</text>
            {tasks.map((task, index) => <SvgButton key={task.id} label={`打开 ${task.id} ${task.title}`} onClick={() => inspect({ kind: 'task', id: task.id })}>
              <rect x={x - 87} y={548 + index * 51} width="174" height="43" rx="4" fill={task.verified ? '#e6eee2' : task.execution === 'blocked' ? '#f5ead4' : '#f0eee8'} stroke="#d4d1c6" strokeWidth=".7" />
              <text className="wf-task-name" x={x - 77} y={564 + index * 51}>{task.id}<tspan x={x + 77} textAnchor="end">{executionText[task.execution]}</tspan></text>
              <text className="ref-small" x={x - 77} y={581 + index * 51}>{verdictText[task.verdict]}{task.score !== undefined ? ` · ${task.score.toFixed(4)}` : ''}</text>
            </SvgButton>)}
            {!tasks.length && <text className="ref-small" x={x} y="582" textAnchor="middle">等待任务分配</text>}
          </g>;
        })}
        {Array.from({ length: 9 }, (_, index) => {
          const agent = index + 1, position = workflowPosition(agent, state), lane = Math.floor(index / 3);
          const tasks = state.tasks.filter(task => task.agents.includes(agent));
          const action = state.participants.includes(agent) ? '参与 D01 跨组讨论' : tasks.at(-1)?.title ?? '等待任务';
          return <motion.g key={agent} className={`ref-agent ref-agent-${lane}`} role="button" tabIndex={0} aria-label={`研究员 a${agent}：${action}`}
            initial={false} animate={{ x: position.x, y: position.y }} transition={{ duration: props.reduced ? 0 : 1.1, ease: [.22, 1, .36, 1] }}
            onClick={() => inspect({ kind: 'agent', id: agent })} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); inspect({ kind: 'agent', id: agent }); } }}>
            <title>{`a${agent} · ${action}`}</title><circle className="ref-agent-halo" r="22" /><circle className="ref-agent-body" r="13" /><circle cy="-4" r="3.4" fill="#fff" fillOpacity=".88" /><path d="M-6 7c0-8 12-8 12 0" fill="#fff" fillOpacity=".88" /><text className="ref-agent-name" y="33" textAnchor="middle">a{agent}</text>
          </motion.g>;
        })}
        {!props.reduced && lastEvent?.kind === 'result' && lastEvent.task && <motion.g key={`${lastEvent.id}-${replaying}`} aria-hidden="true" initial={{ x: groupCenters[lastEvent.task.lane], y: 565, opacity: 0 }} animate={{ x: 147, y: 408, opacity: [0, 1, 1, 0] }} transition={{ duration: 1.4, ease: 'easeInOut' }}><rect width="11" height="11" rx="2" fill="#a5ad8d" /><text className="ref-small" x="18" y="10">{lastEvent.task.id} · 存入 Log</text></motion.g>}
      </svg>
    </main>
    {selection && <aside className="ref-inspector wf-inspector" ref={panel} tabIndex={-1} role="dialog" aria-label="研究对象详情" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); closeInspector(); } }}>
      <button className="ref-close" aria-label="关闭研究记录" onClick={closeInspector}><X size={15} /></button><span>{replaying ? 'HISTORY / 历史回放' : 'RESEARCH OBJECT / 事件模拟'}</span>
      <nav className="wf-inspector-tabs" aria-label="共享记录"><button onClick={() => inspect({ kind: 'log' })}>Log</button><button onClick={() => inspect({ kind: 'forum' })}>Forum</button><button onClick={() => inspect({ kind: 'report' })}>报告</button></nav>
      {selection.kind === 'task' && (() => { const task = state.tasks.find(t => t.id === selection.id); return task ? taskDetails(task) : <p>当前历史节点尚未创建该任务。</p>; })()}
      {selection.kind === 'event' && (() => { const event = visibleEvents.find(item => item.id === selection.id); return event?.task ? <><h2>{event.id} / 原始事件快照</h2><p>{event.title}。此记录不会随后续解释或核验被改写。</p>{taskDetails(event.task)}</> : <p>当前回放位置尚无此事件。</p>; })()}
      {selection.kind === 'agent' && <><h2>研究员 a{selection.id}</h2><p>{state.participants.includes(selection.id) ? '当前参与 D01：结构收益是否依赖优化方法？' : '当前归属：' + (state.tasks.find(t => t.id === 'E11' && t.agents.includes(selection.id)) ? '结构 × 优化联合对照' : sceneGroups[Math.floor((selection.id - 1) / 3)])}</p><h3>任务与可核对产物</h3>{state.tasks.filter(t => t.agents.includes(selection.id)).map(task => <button className="wf-record-row" key={task.id} onClick={() => inspect({ kind: 'task', id: task.id })}>{task.id} · {task.title}<small>{executionText[task.execution]} / {verdictText[task.verdict]}</small></button>)}<h3>资料与行为边界</h3><p>本轮只使用 D2 / C4 的固定演示配置，没有联网检索或真实论文阅读记录。</p><h3>参与讨论</h3>{state.posts.filter(p => p.agent === selection.id).map(post => <p key={post.id}>{post.kind} · {post.text}</p>)}{!state.posts.some(p => p.agent === selection.id) && <p>尚无发言记录。</p>}</>}
      {selection.kind === 'group' && <><h2>{sceneGroups[selection.id]}</h2><p>{['H1：结构是否限制固定预算下的表现？', 'H2：优化是否限制收敛？', 'H3：调度是否影响最终表现？'][selection.id]}</p><p>方向暂缓只限于本轮范围与预算，不代表已证明方向无效。</p>{state.tasks.filter(t => t.lane === selection.id).map(task => <button className="wf-record-row" key={task.id} onClick={() => inspect({ kind: 'task', id: task.id })}>{task.id} · {task.title}<small>{executionText[task.execution]} / {verdictText[task.verdict]}</small></button>)}</>}
      {selection.kind === 'log' && <><h2>Log / 事实与产物</h2><p>保存已经发生的模拟事件。解释与质疑另存 Forum。</p>{visibleEvents.map(event => <div className="wf-log-event" key={event.id}><span>{event.id} / {event.kind}</span><p>{event.title}</p>{event.task && <button className="wf-link" onClick={() => inspect({ kind: 'event', id: event.id })}>打开 {event.task.id} 此刻的原始快照 →</button>}{event.approval && <small>{event.approval === 'manual' ? '用户明确确认' : '自动规则 R1：匹配预算、无新增外部访问'}</small>}</div>)}{!visibleEvents.length && <p>尚无事件。</p>}</>}
      {selection.kind === 'forum' && <><h2>Forum / 解释与质疑</h2>{state.posts.map(post => <article className="wf-forum-post" key={post.id}><span>{post.id} · a{post.agent} · {post.kind}</span><p>{post.text}</p><button className="wf-link" onClick={() => inspect({ kind: 'task', id: post.task })}>引用证据 {post.task} →</button></article>)}{!state.posts.length && <p>尚无解释或质疑；不能提前补写讨论。</p>}</>}
      {selection.kind === 'champion' && <><h2>当前候选成果</h2>{state.champion ? <><p>仅在 D2 / C4、seed 17 与相同预算条件下比较。指标和检查过程均为模拟。</p>{taskDetails(state.champion)}<p>限制：单一验证条件，未作多种子复现，不应外推到其他模型或数据集。</p></> : <p>还没有通过比较条件检查的候选。任务完成不等于自动成为最佳成果。</p>}</>}
      {selection.kind === 'discussion' && <><h2>D01 / 跨组讨论</h2><h3>结构收益是否依赖优化方法？</h3><p>参与者：a2（结构）、a5（优化）、a3（核验）。其他研究员不被强制召回。</p><h3>新证据与分歧</h3><p>E07 本轮未支持 H1；a5 认为优化设置可能掩盖收益。E08 只是单因素对照，不能直接回答交互问题。</p><button className="wf-link" onClick={() => inspect({ kind: 'task', id: 'E07' })}>检查 E07 原始条件 →</button><h3>{state.approved ? '已记录的决定' : '待确认的方案'}</h3><p>保留并收窄 H1；安排 E11 联合对照，a2 与 a5 执行，a3 检查比较条件。保持预算和数据不变。</p>{state.approved ? <p>决定已记录。新任务及参与关系由该决定派生。</p> : !replaying && waiting ? <button className="wf-approve" onClick={approve}>确认方案，派发联合实验 E11</button> : <p>{replaying ? '这是历史状态，不可在回放中派发任务。' : '尚未到达人工确认点。'}</p>}</>}
      {selection.kind === 'report' && <><h2>研究报告 {state.reportReady ? 'v2' : 'v1'} / 草稿</h2><h3>01 / 研究问题与方法</h3><p>固定计算预算下，结构收益是否依赖优化方法？匹配数据、配置、随机种子与预算，先做单因素对照，再检查交互。</p><h3>02 / 已有证据</h3>{state.tasks.filter(t => t.execution !== 'running').map(task => <button className="wf-record-row" key={task.id} onClick={() => inspect({ kind: 'task', id: task.id })}>{task.id} · {task.finding}</button>)}<h3>03 / 当前候选与解释</h3><p>{state.champion ? `${state.champion.id} 暂时领先，指标 ${state.champion.score!.toFixed(4)}；只在当前条件内成立。` : '暂无通过核验的候选。'}</p><h3>04 / 争议与局限</h3><p>{state.posts.length ? '结构与优化可能存在交互。单种子、单数据集不足以推广结论；需进一步复现。' : '尚无讨论记录，不提前生成解释。'}</p><h3>05 / 待办与资源交接</h3><p>{state.reportReady ? '申请 E09 执行资源；补充多种子复现；复核预算匹配。E09 仍未完成，报告不是最终定论。' : '跟随本轮事件补充产物、核验与资源需求。'}</p><p className="wf-disclaimer">全文来自本轮模拟事件，不能作为真实科研报告使用。会话刷新后模拟记录重置。</p></>}
    </aside>}
    <div className={`wf-event-strip ${waiting && !replaying ? 'wf-needs-decision' : ''}`}>
      <span>{replaying ? '历史回放' : waiting ? '等待你的决定' : finished ? '本轮已结束' : selection ? '查看对象 · 模拟派发暂挂' : running ? '模拟事件流' : '已暂停派发'}</span>
      <p>{lastEvent?.title ?? '尚未派发任务；三条研究方向等待启动。'}</p>
      {waiting && !replaying && <button onClick={() => inspect({ kind: 'discussion' })}>查看议题并决定 <ArrowRight size={13} /></button>}
    </div>
    <footer className="reference-transport wf-transport">
      <div className="ref-playback">
        {!replaying ? <><button aria-label={running ? '暂停模拟派发' : '继续模拟派发'} disabled={finished || waiting} onClick={() => setRunning(value => !value)}>{running ? <Pause size={15} /> : <Play size={15} />}</button><button aria-label="推进一个模拟事件" onClick={step} disabled={finished || waiting}><ArrowRight size={15} /></button><button aria-label="重置本轮模拟" onClick={reset}><RotateCcw size={14} /></button></> : <button onClick={() => { setCursor(null); setSelection(null); }}>返回当前状态</button>}
        <span>{visibleEvents.length} / {replaying ? events.length : workflowScript.length}</span>
      </div>
      {replaying ? <label className="ref-seek"><span className="research-sr-only">历史事件位置</span><input type="range" min="0" max={events.length} step="1" value={cursor} onChange={event => { setCursor(Number(event.target.value)); setSelection(null); }} /></label> : <div className="wf-mode" role="group" aria-label="决策模式"><button aria-pressed={mode === 'manual'} onClick={() => setMode('manual')}>人工确认</button><button aria-pressed={mode === 'auto'} title="R1：维持预算与数据条件，不新增外部访问" onClick={() => setMode('auto')}>自动 · R1</button></div>}
      {!replaying && <button className="wf-history" disabled={!events.length} onClick={() => { setRunning(false); setCursor(events.length); setSelection(null); }}><History size={13} />历史回放</button>}
      <span className="ref-demo-disclaimer">{replaying ? `当前会话仍有 ${events.length} 条模拟事件，不受回放影响` : liveState.approved ? '决定已记录 · 事件模拟，刷新重置' : '本地事件模拟 · 不执行检索或训练 · 刷新重置'}</span>
    </footer>
  </div>;
}
