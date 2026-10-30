import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import BenchFrame from '../../BenchFrame';
import { RichText } from '../../richText';
import { scrollWithin } from '../../scrollWithin';
import AgentDock, { type DockEvent, type Suggestion } from '../../AgentDock';
import Explorer, { Tree, type ExplorerSection, type ExplorerView } from '../../engineering/Explorer';
import { Mobius } from '../../../rhine/RhineMark';
import type { BenchChrome } from '../../WorkbenchStudio';
import { CLAIMS, REPRO_CODE } from './paper';
import { MultiHead, PositionalEncoding, ScaledAttention } from './Anims';
import { mockReadAdapter } from './mockRead';
import { useRead } from './useRead';
import type { ResumePoint } from '../../../dossier/adapter';
import type { FindingCard, Grade, LayerCard, PaperView, QuizCard, ReadAdapter, ReadEvent, RunView } from './readTypes';
import './read.css';

// 研究台 · 精读模式：目标是「搞懂」一篇论文。
// 01 解析（一句话 → 直觉 → 机理 → 证据 → 洞见，每层链接回原文）· 02 动画（可交互的解释）· 03 复现（最小复现 vs 论文结论）· 04 检验（出题、作答、指出偏差）。
// 同一套界面，两种数据源（read/readTypes.ts 的 ReadAdapter）：mock 回放示例，live 接真实后端的事件流。
// 结果为主：讲解、检查题、发现卡长在中间；模型调了什么工具折叠在右边助手里，点开看。发起前先预估费用，你确认才跑。

type Face = 'explain' | 'lab' | 'repro' | 'check';
type Anim = 'scaled' | 'pe' | 'heads';
const ANIMS: { id: Anim; title: string; en: string; ref: string }[] = [
  { id: 'scaled', title: '为什么要除以 √d', en: 'SCALED DOT-PRODUCT', ref: 's321' },
  { id: 'pe', title: '位置编码', en: 'POSITIONAL ENCODING', ref: 's35' },
  { id: 'heads', title: '多头注意力', en: 'MULTI-HEAD', ref: 's322' },
];
const clock = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const END_TEXT: Record<NonNullable<RunView['endReason']>, string> = { completed: '已完成', rejected: '已停止 · 没有下载', cancelled: '已停止', budget: '预算用完，已暂停', abstract_only: '没拿到全文', failed: '出错停止' };
// 讲解层没写满时后端给了照实的话（「讲解只生成了 N 层」），结束标题就用它，不写「已完成」。
const runText = (r: RunView) => (r.endReason && (r.state === 'done' || r.state === 'cancelled' || r.state === 'failed') ? (r.message && r.message.length <= 24 ? r.message : END_TEXT[r.endReason])  /* 后端给了简短的照实说法（如「审批已过期，可以重新开始」「讲解只生成了 N 层」）就用它当标题；长说明留在正文 */ : RUN_TEXT[r.state]);
const RUN_TEXT: Record<RunView['state'], string> = { idle: '未开始', estimating: '正在预估', confirm: '等你确认预算', queued: '排队中', running: '运行中', waiting: '等你批准', done: '已完成', failed: '失败', cancelled: '已停止' };
const active = (r: RunView) => r.state === 'queued' || r.state === 'running' || r.state === 'waiting';
const money = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `¥${v < 0.1 ? v.toFixed(3) : v.toFixed(2)}`);

export default function ReadMode({ file, reduced, chrome, modeSwitch, onDispatch, adapter: given, resume, onPosition, onNewDossier }: {
  file: number; reduced: boolean; chrome: BenchChrome; modeSwitch: ReactNode; onDispatch: (to: 'swarm' | 'auto', text: string) => void; adapter?: ReadAdapter;
  resume?: ResumePoint | null; onPosition?: (p: ResumePoint) => void; onNewDossier?: (kind: 'reading' | 'topic') => Promise<void>;
}) {
  const adapter = useMemo(() => given ?? mockReadAdapter({ reduced }), [given, reduced]);
  const { state, reload, error: loadError, retry } = useRead(adapter);
  const [face, setFace] = useState<Face>(() => (['explain', 'lab', 'repro', 'check'] as Face[]).includes(resume?.face as Face) ? resume!.face as Face : 'explain');
  // 续上次：记下工作面（防抖），重新打开时回到这里。只记位置，不触发任何任务。
  useEffect(() => { if (!onPosition) return; const t = window.setTimeout(() => onPosition({ face, mode: 'read' }), 2000); return () => window.clearTimeout(t); }, [face, onPosition]);
  const [depth, setDepth] = useState(3);                 // 展开到第几层
  const [focus, setFocus] = useState<string[]>([]);      // 当前高亮的原文段
  const [ping, setPing] = useState(0);
  const [anim, setAnim] = useState<Anim>('scaled');
  const [understood, setUnderstood] = useState<Record<string, Grade>>({});
  const [ran, setRan] = useState<'idle' | 'running' | 'done'>('idle');
  const [asking, setAsking] = useState(false);
  // 「预算余额」卡片：记下点开时对话流的位置，卡片插在那里，内容随运行实时更新
  const [budgetAt, setBudgetAt] = useState<number[]>([]);
  // 澄清被挡住（上限 / 上一段没结束）时不会再有回话，别让「工作中」一直转
  useEffect(() => { if (state?.run.clarifyBlocked) setAsking(false); }, [state?.run.clarifyBlocked]);
  const cite = (refs: string[]) => { setFocus(refs); setPing(Date.now()); };
  const openAnim = (a: Anim) => { setAnim(a); setFace('lab'); };

  // 讲解一层层长出来时，跟着展开（你手动收起过就不再自动展开）
  const seenLayers = useRef<number | null>(null);
  useEffect(() => {
    if (!state) return;
    const n = state.layers.length;
    if (seenLayers.current === null) { seenLayers.current = n; if (n) setDepth(Math.min(3, n)); return; }   // 打开已有档案：从第 3 层看起
    if (n > seenLayers.current) { const prev = seenLayers.current; setDepth(d => (d >= prev ? n : d)); seenLayers.current = n; }
  }, [state?.layers.length]);
  // 追问的回答带了原文 / 动画时，自动定位
  const seenLog = useRef(0);
  useEffect(() => {
    const log = state?.log ?? [];
    for (const e of log.slice(seenLog.current)) if (e.type === 'agent') { if (e.refs?.length) cite(e.refs); if (e.anim && state?.anims.includes(e.anim)) openAnim(e.anim as Anim); setAsking(false); } else if (e.type === 'pick') setAsking(false);
    seenLog.current = log.length;
  }, [state?.log.length]);
  // 第一次拿到数据时，从第一层开始高亮
  const stamps = useRef(new Map<string, string>());
  const at = (id: string) => { if (!stamps.current.has(id)) stamps.current.set(id, clock()); return stamps.current.get(id)!; };

  if (!state) return <BenchFrame code="RSCH" section="002" file={file} reduced={reduced} chrome={chrome} face={face} onFace={id => setFace(id as Face)}
    faces={[{ id: 'explain', label: '解析', en: 'EXPLAIN' }]} strip={<>READ <i>·</i> 读取中</>} tools={modeSwitch} shutterLines={() => ['> open dossier', '> ready']}
    status={<span>{loadError ? '读取失败' : '正在读取档案…'}</span>}><div className="rd rh">{loadError && <div className="rd-start"><div className="rd-start-card rd-load-err" role="alert">
      <span className="rh-micro">ERROR · 读取失败</span><h2>没能读到这份档案</h2>
      <p className="rd-start-lead">原因：{loadError}。没有换成示例数据。</p>
      <div className="rd-end-act"><button className="rd-go" onClick={retry}>重试</button></div>
    </div></div>}</div></BenchFrame>;

  const { paper, layers, quizzes, findings, run } = state;
  const dispatch = (to: 'swarm' | 'auto', text: string) => { onDispatch(to, text); };
  const ask = (text: string) => { setAsking(true); void adapter.ask(text).catch(() => setAsking(false)); };
  // 还没开始读时，对话就是「澄清想读哪篇」
  const talk = (text: string) => { if (paper) return ask(text); setAsking(true); void adapter.clarify(text).catch(() => setAsking(false)); }; // 真实模式下 clarify 只是提交，等助手回话或列出候选才算答完
  const runRepro = () => {
    if (ran === 'running') return;
    setRan('running'); window.setTimeout(() => setRan('done'), reduced ? 60 : 2600);
  };
  // 真实模式：新建精读 = 新建一份 reading 档案并切过去（外壳负责），适配器随档案重建；示例模式沿用适配器自己的新建
  const newReading = onNewDossier ? async () => { await onNewDossier('reading'); } : adapter.newReading ? async () => { await adapter.newReading!(); seenLayers.current = 0; seenLog.current = 0; setUnderstood({}); setFocus([]); setFace('explain'); setDepth(3); await reload(); } : undefined;

  const logEvents: (DockEvent | null)[] = state.log.map((e: ReadEvent): DockEvent | null => {
    if (e.type === 'user') return { id: e.id, kind: 'user', text: e.text, at: at(e.id) };
    if (e.type === 'agent') return { id: e.id, kind: 'agent', at: at(e.id), text: <><p><RichText text={e.text} /></p>{(e.refs?.length || (e.anim && state.anims.includes(e.anim))) && <p>{e.refs?.map(r => <b key={r} className="ad-ref" onClick={() => { setFace('explain'); cite([r]); }}>{paper?.sections.find(s => s.id === r)?.no ?? r}</b>)}{e.anim && state.anims.includes(e.anim) && <> · <b className="ad-ref" onClick={() => openAnim(e.anim as Anim)}>打开动画</b></>}</p>}</> };
    if (e.type === 'note') return { id: e.id, kind: 'note', text: e.text, at: at(e.id) };
    if (e.type === 'tool') return { id: e.id, kind: 'tool', action: e.action, label: e.label, state: e.state, detail: e.detail, ms: e.ms };
    if (e.type === 'pick') return { id: e.id, kind: 'card', body: <PickCard e={e} repick={!run.chosen && !paper && (run.state === 'idle' || run.state === 'confirm')} onPick={c => void adapter.pick(e.id, c)} /> };
    if (e.type === 'approval') return { id: e.id, kind: 'approval', action: e.action, title: e.title, effects: e.effects, risk: e.risk, state: e.state, onApprove: () => void adapter.decide(e.id, true), onReject: () => void adapter.decide(e.id, false) };
    return null;
  });
  const events: DockEvent[] = [];
  logEvents.forEach((e, i) => { if (e) events.push(e); budgetAt.forEach((pos, k) => { if (pos === i + 1) events.push({ id: `budget-${k}`, kind: 'card', body: <BudgetCard run={run} adapter={adapter} reading={!!paper} /> }); }); });
  budgetAt.forEach((pos, k) => { if (pos === 0) events.unshift({ id: `budget-${k}`, kind: 'card', body: <BudgetCard run={run} adapter={adapter} reading={!!paper} /> }); });
  const showBudget = () => setBudgetAt(b => [...b, state.log.length]);
  const pending = state.log.filter((e): e is Extract<ReadEvent, { type: 'approval' }> => e.type === 'approval' && e.state === 'pending');

  const okCount = Object.values(understood).filter(v => v === 'ok').length;
  // 常用指令：预算、推荐、按编号找；读的时候换成对这篇通用的追问。
  const budgetTip: Suggestion = { id: 'budget', label: '预算余额', hint: '看还剩多少钱，可以在卡片里加预算', onClick: showBudget };
  const suggestions: Suggestion[] = !paper ? [
    budgetTip,
    { id: 'rec', label: '给我推荐三篇论文', hint: '助手按常被精读、有开放全文的挑三篇，你来选', onClick: () => talk('给我推荐三篇值得精读、有开放全文的论文') },
    { id: 'id', label: '用 arXiv 编号或链接找', hint: '填编号或链接最准，不用来回澄清', fill: 'arXiv ' },
  ] : [
    budgetTip,
    { id: 'core', label: '一句话讲清核心贡献', onClick: () => ask('用一句话讲清这篇论文的核心贡献，并标出原文位置') },
    { id: 'limit', label: '它的局限在哪？', onClick: () => ask('这篇论文自己承认或明显存在的局限是什么？标出原文位置') },
  ];

  const sections: ExplorerSection[] = [
    { id: 'dossier', title: '档案', body: <div className="rd-xp-dossier"><b>{state.dossier.title}</b><small>{RUN_TEXT[run.state]} · {money(run.spentCny)} / ¥{run.budgetCny}</small>{newReading && <button className="rd-new" onClick={() => void newReading()}>＋ 新建精读</button>}</div> },
    ...(paper ? [
      { id: 'paper', title: paper.title, grow: true, body: <Tree nodes={paper.sections.map(s => ({ name: s.title, path: s.id, ext: '§', meta: <span className="rd-xp-meta">{s.no}</span> }))} active={focus[0]} onOpen={id => { setFace('explain'); cite([id]); }} /> },
      { id: 'meta', title: '信息', body: <div className="dv-xp-list"><div><b>{paper.authors}</b><small>{paper.venue}</small></div>{paper.code && <div><b>代码</b><small>{paper.code} · 有</small></div>}<div><b>全文</b><small>{paper.access === 'full' ? `可读 · ${paper.license ?? '开放获取'}` : '只有摘要 · 结论都待核'}</small></div></div> },
    ] : []),
    ...(findings.length ? [{ id: 'findings', title: '发现', count: findings.length, body: <div className="dv-xp-list">{findings.map(f => <div key={f.id}><b>#{f.n} {f.text.slice(0, 24)}…</b><small>{CONF[f.confidence]} · {STATUS[f.status]}</small></div>)}</div> }] : []),
    ...(state.anims.length ? [{ id: 'figs', title: '动画', count: state.anims.length, body: <Tree nodes={ANIMS.filter(a => state.anims.includes(a.id)).map(a => ({ name: a.title, path: a.id, ext: '▶', meta: <span className="rd-xp-meta">{paper?.sections.find(s => s.id === a.ref)?.no}</span> }))} active={face === 'lab' ? anim : undefined} onOpen={id => openAnim(id as Anim)} /> }] : []),
  ];
  const dock = <AgentDock name="精读助手" target={paper ? `${paper.title} · ${paper.venue}` : state.dossier.title} plan={{ stages: ['解析', '动画', '复现', '检验'], current: ['explain', 'lab', 'repro', 'check'].indexOf(face) }}
    loop={active(run) ? { stages: ['检索', '读原文', '写讲解', '出题'], current: !paper ? 0 : !layers.length ? 1 : !quizzes.length ? 2 : 3 } : null}
    suggestions={suggestions} events={events} busy={asking || run.state === 'estimating'} onSend={talk} placeholder={paper ? '哪里没懂？例如：为什么要除以根号 d' : '想读哪篇？说得模糊也行，例如：讲智能体边推理边行动的那篇'} />;

  return <BenchFrame code="RSCH" section="002" file={file} reduced={reduced} chrome={chrome} face={face} onFace={id => setFace(id as Face)}
    faces={[{ id: 'explain', label: '解析', en: 'EXPLAIN' }, { id: 'lab', label: '动画', en: 'LAB' }, { id: 'repro', label: '复现', en: 'REPRODUCE', badge: ran === 'done' ? 3 : 0 }, { id: 'check', label: '检验', en: 'CHECK', badge: okCount }]}
    strip={<>READ <i>·</i> {paper?.venue ?? '新档案'} <i>·</i> 理解 {okCount}/{quizzes.length}</>} tools={modeSwitch}
    shutterLines={f => [`> open dossier · ${state.dossier.title.toLowerCase()}`, `> face · ${f.en.toLowerCase()}`, '> ready']}
    status={<><span><i className="en-sq" />精读</span><span>{paper?.title ?? state.dossier.title}</span><span>解析 {Math.min(depth, layers.length)}/{layers.length || 5} 层</span><span>理解 {okCount}/{quizzes.length}</span><span>{RUN_TEXT[run.state]} · {money(run.spentCny)}{run.unknownCost ? ' + 未知' : ''}</span>{!paper && <span>澄清 {money(run.clarifySpentCny ?? 0)} / ¥{run.clarifyCapCny ?? 0.5}</span>}<span>{adapter.kind === 'mock' ? '示例数据 · 不连接模型' : '真实数据'}</span></>}>
    <XpHost sections={sections} title={paper?.venue ?? '新档案'}>
      <section className="rd-center" data-wb-panel>
        {(run.state !== 'idle' && paper) && <RunBar run={run} onStop={() => void adapter.cancel()} pending={pending.length} />}
        {!paper ? <Start run={run} adapter={adapter} pending={pending} onNew={newReading} />
          : face === 'explain' ? <Explain paper={paper} layers={layers} findings={findings} running={active(run)} note={run.message} onNew={newReading} depth={depth} setDepth={setDepth} focus={focus} ping={ping} cite={cite} openAnim={state.anims.length ? openAnim : undefined} dispatch={dispatch} />
          : face === 'lab' ? (state.anims.length ? <Lab anim={anim} setAnim={setAnim} dispatch={dispatch} /> : <Later title="交互动画" text="真实模式下，解释动画由 OpenMAIC 课堂引擎按这篇论文生成，在研究台第二期接入。现在可以先在「解析」里看文字讲解。" />)
          : face === 'repro' ? (state.hasRepro ? <Repro ran={ran} onRun={runRepro} dispatch={dispatch} /> : <Later title="最小复现" text="真实模式下，复现会先给出计划和费用，你批准后在沙盒里跑（研究台第二期 P2-09）。论文里需要大规模算力的结论，可以交给自研排期。" />)
          : <Check quizzes={quizzes} understood={understood} grade={async (id, a) => { const g = await adapter.grade(id, a); setUnderstood(u => ({ ...u, [id]: g })); }}
            onLayer={l => { setFace('explain'); const L = layers.find(x => x.id === l); if (!L) return; setDepth(Math.max(depth, layers.indexOf(L) + 1)); cite(L.body.flatMap(b => b.refs)); }} />}
      </section>
      {dock}
    </XpHost>
  </BenchFrame>;
}

const CONF: Record<FindingCard['confidence'], string> = { low: '把握低', mid: '把握中', high: '把握高' };
const STATUS: Record<FindingCard['status'], string> = { hypothesis: '假设', supported: '有证据', refuted: '被推翻' };

/** 资源管理器 + 中间 + 助手的三栏外壳（资源管理器的开合状态放这里）。 */
function XpHost({ sections, title, children }: { sections: ExplorerSection[]; title: string; children: ReactNode }) {
  const [open, setOpen] = useState(true), [view, setView] = useState<ExplorerView>('files');
  return <div className="rd rh"><Explorer code="RSCH" open={open} view={view} onView={setView} onToggle={() => setOpen(v => !v)} title={title} sections={sections} />{children}</div>;
}

/* ———— 运行状态条 ———— */
function RunBar({ run, onStop, pending }: { run: RunView; onStop: () => void; pending: number }) {
  return <div className="rd-runbar" data-state={run.state}>
    <span className="rd-run-chip"><i />{runText(run)}</span>
    <span className="rd-run-step">{run.message ?? run.step ?? (run.state === 'done' ? '这次精读已完成' : '')}{pending > 0 && <b> · 右边有 {pending} 个审批等你</b>}</span>
    <span className="rd-run-cost"><small>已花</small><b>{money(run.accounting?.totalCny ?? run.accounting?.knownCny ?? run.spentCny)}</b>{(run.unknownCost || run.accounting?.status === 'unknown') && <em>+ 未知用量</em>}{run.accounting?.status === 'pending' && <em>费用待核对</em>}<small>/ 预算 ¥{run.budgetCny}</small></span>
    {active(run) && <button className="rh-btn" onClick={onStop}>停止</button>}
  </div>;
}

/* ———— 空档案：先在右边对话里说清读哪篇 → 选定 → 按这篇预估 → 你确认 → 开始 ———— */
function Start({ run, adapter, pending, onNew }: { run: RunView; adapter: ReadAdapter; pending: Extract<ReadEvent, { type: 'approval' }>[]; onNew?: () => void }) {
  const [budget, setBudget] = useState(run.budgetCny || 5);
  const [err, setErr] = useState('');
  const est = run.estimate, c = run.chosen;
  async function estimate() {
    if (!c) return;
    if (!(budget > 0 && budget <= 50)) { setErr('预算填 0 到 50 元之间。'); return; }
    setErr(''); try { await adapter.estimate(c.id, budget); } catch { setErr('预估没有成功，稍后再试。'); }
  }
  const before = run.state === 'idle' || run.state === 'estimating' || run.state === 'confirm';
  return <div className="rd-start">
    <div className="rd-start-card">
      <span className="rh-micro">NEW READING · 新的精读</span>
      {!c && before && run.clarifyBlocked && <div className="rd-blocked" role="alert" data-reason={run.clarifyBlocked.reason}>
        <b>{run.clarifyBlocked.reason === 'cap' ? '澄清用到上限了' : '上一段澄清还没结束'}</b>
        <p>{run.clarifyBlocked.text}</p>
        <div>{run.clarifyBlocked.reason === 'cap'
          ? <button className="rd-go" disabled={!adapter.raiseBudget} onClick={() => void adapter.raiseBudget?.('clarify', 0.5)}>澄清上限加 ¥0.5</button>
          : <button className="rd-go" disabled={!adapter.cancelClarify} onClick={() => void adapter.cancelClarify?.()}>结束这段澄清，重新说</button>}
          {!(run.clarifyBlocked.reason === 'cap' ? adapter.raiseBudget : adapter.cancelClarify) && <small>真实模式尚未接入这个按钮</small>}</div>
      </div>}
      {!c && before && <>
        <h2>想读哪篇？</h2>
        <p className="rd-start-lead">在右边告诉精读助手，说得模糊也没关系，比如「讲智能体边推理边行动的那篇」。它会检索，拿不准就问你，再把候选论文列出来让你选。</p>
        <ol className="rd-start-steps"><li data-now><b>01</b>对话说清读哪篇</li><li><b>02</b>按这篇预估费用</li><li><b>03</b>你确认后开始读</li></ol>
        <small className="rd-start-note">澄清对话用便宜档模型，上限 ¥{run.clarifyCapCny ?? 0.5}，不单独确认；已用 {money(run.clarifySpentCny ?? 0)}{run.clarifyUnknownCost ? ' + 未知' : ''}。不够可以在右边「预算余额」里加。</small>
      </>}
      {c && before && <>
        <h2>读这篇</h2>
        <div className="rd-chosen"><span><b>{c.title}</b><small>{shortAuthors(c.authors)} · {c.venue}{c.pages ? ` · ${c.pages} 页` : ''} · {c.access === 'full' ? '有开放全文' : '只有摘要'}</small></span>
          {run.state !== 'estimating' && <button className="rh-btn" onClick={() => void adapter.unchoose()}>换一篇</button>}</div>
        <label className="rd-start-b"><span>预算上限</span><b>¥</b><input type="number" min={0.5} max={50} step={0.5} value={budget} onChange={e => setBudget(Number(e.target.value))} disabled={run.state === 'estimating'} /><small>默认 ¥5，超过就停下问你</small></label>
        {err && <p className="rd-start-err" role="alert">{err}</p>}
        {run.state === 'idle' && <button className="rd-go" onClick={() => void estimate()}>预估费用</button>}
        {run.state === 'estimating' && <p className="rd-start-wait"><i className="rd-pulse" aria-hidden="true" />正在按这篇的长度预估…</p>}
        {run.state === 'confirm' && est && <div className="rd-estimate">
          <dl><div><dt>模型</dt><dd>{est.model}</dd></div><div><dt>最多</dt><dd>{est.steps} 步</dd></div><div><dt>最多约</dt><dd className="is-big">¥{est.maxCny.toFixed(2)}</dd></div><div><dt>预算上限</dt><dd>¥{budget}</dd></div></dl>
          {est.note && <small>{est.note}。实际花费以用量为准，跑完会和账单核对。</small>}
          {est.maxCny > budget && <p className="rd-start-err">预估上限超过了预算。可以调高预算，或者换一篇短一点的。</p>}
          <div className="rd-estimate-act"><button className="rd-go" disabled={est.maxCny > budget} onClick={() => void adapter.start(est.id, budget)}>确认开始</button></div>
        </div>}
      </>}
      {(run.state === 'queued' || run.state === 'running' || run.state === 'waiting') && <div className="rd-start-run">
        <h2>开始读</h2>
        <p><i className="rd-pulse" aria-hidden="true" /><span><b>{run.step ?? RUN_TEXT[run.state]}</b><small>《{c?.title ?? run.query}》· 预算 ¥{run.budgetCny} · 已花 {money(run.spentCny)}</small></span></p>
        {pending.map(a => <div key={a.id} className="rd-start-ap"><b>等你批准：{a.title}</b><ul>{a.effects.map(x => <li key={x}>{x}</li>)}</ul>
          <div><button className="rh-btn" onClick={() => void adapter.decide(a.id, false)}>{a.action === 'papers.fetch' ? '不下载' : '不入档'}</button><button className="rd-go" onClick={() => void adapter.decide(a.id, true)}>批准</button></div></div>)}
        <button className="rh-btn" onClick={() => void adapter.cancel()}>停止</button>
      </div>}
      {(run.state === 'done' || run.state === 'cancelled' || run.state === 'failed') && <div className="rd-start-run">
        <h2>{runText(run)}</h2>
        <p><span><small>{run.message ?? ''} 已花 {money(run.spentCny)}{run.unknownCost ? '，另有未知用量' : ''}。</small></span></p>
        {run.endReason === 'abstract_only' && <p className="rd-start-err">这篇在公开来源里只拿到摘要，没有编造讲解。可以换一篇有全文的；上传 PDF、按摘要讲解会在后续接入。</p>}
        <div className="rd-end-act">
          {run.endReason === 'abstract_only' && c && <button className="rh-btn" onClick={() => void adapter.unchoose()}>换一篇</button>}
          {onNew && <button className="rd-go" onClick={onNew}>重新开始</button>}
        </div>
      </div>}
    </div>
  </div>;
}

/** 「预算余额」卡片：澄清与这次精读各自已花 / 上限，点按钮加预算（点了就算确认）。 */
function BudgetCard({ run, adapter, reading }: { run: RunView; adapter: ReadAdapter; reading: boolean }) {
  const [busy, setBusy] = useState(false);
  const raise = async (scope: 'clarify' | 'read', add: number) => { if (!adapter.raiseBudget || busy) return; setBusy(true); try { await adapter.raiseBudget(scope, add); } finally { setBusy(false); } };
  const cs = run.clarifySpentCny ?? 0, cc = run.clarifyCapCny ?? 0.5;
  const rs = run.spentCny, rb = run.budgetCny;
  const bar = (used: number, cap: number) => <i className="rd-bud-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, cap > 0 ? used / cap * 100 : 0)}%` }} /></i>;
  const started = run.state !== 'idle' && run.state !== 'estimating' && run.state !== 'confirm';
  return <div className="rd-bud">
    <b className="rh-micro">BUDGET · 预算余额</b>
    <div className="rd-bud-row"><span>澄清对话</span><em>{money(cs)}{run.clarifyUnknownCost ? ' + 未知' : ''} / ¥{cc}</em>{bar(cs, cc)}
      <small>剩 ¥{Math.max(0, cc - cs).toFixed(3)}</small>
      <button className="rh-btn" disabled={!adapter.raiseBudget || busy} onClick={() => void raise('clarify', 0.5)}>+ ¥0.5</button></div>
    <div className="rd-bud-row"><span>{reading || started ? '这次精读' : '精读预算'}</span><em>{started ? `${money(rs)}${run.unknownCost ? ' + 未知' : ''} / ¥${rb}` : `¥${rb}`}</em>{started && bar(rs ?? 0, rb)}
      <small>{started ? `剩 ¥${Math.max(0, rb - (rs ?? 0)).toFixed(2)}` : '开始前在中间改'}</small>
      {started && <span className="rd-bud-add"><button className="rh-btn" disabled={!adapter.raiseBudget || busy} onClick={() => void raise('read', 1)}>+ ¥1</button><button className="rh-btn" disabled={!adapter.raiseBudget || busy} onClick={() => void raise('read', 5)}>+ ¥5</button></span>}</div>
    {!adapter.raiseBudget && <small className="rd-bud-note">加预算在真实模式尚未接入。</small>}
    {(run.clarifyUnknownCost || run.unknownCost) && <small className="rd-bud-note">「+ 未知」：有调用的用量还没回来，核对后补上，不按 0 算。</small>}
  </div>;
}

/** 作者太多时只留前 3 位：「A、B、C 等」。 */
const shortAuthors = (a: string) => { const xs = a.split(/[、,，;；]\s*/).filter(Boolean); return xs.length > 3 ? `${xs.slice(0, 3).join('、')} 等` : a; };

/** 对话里的候选论文卡片：你点一篇才算选定，AI 不替你决定。 */
function PickCard({ e, onPick, repick = false }: { e: Extract<ReadEvent, { type: 'pick' }>; onPick: (id: string | null) => void; repick?: boolean }) {
  // 答过的卡默认锁住；「换一篇」之后（repick）可以直接改选，不必再让助手列一次
  const done = e.state !== 'pending' && !repick;
  return <div className="rd-pick" data-done={done || undefined}>
    <b>候选 · 「<RichText text={e.query} />」</b>
    <ul>{e.candidates.map(c => <li key={c.id}><button disabled={done} aria-pressed={e.chosen === c.id} onClick={() => onPick(c.id)}>
      <span><b>{c.title}</b><small>{shortAuthors(c.authors)} · {c.venue}{c.pages ? ` · ${c.pages} 页` : ''} · {c.access === 'full' ? '有开放全文' : '只有摘要'}</small></span>{c.note && <em>{c.note}</em>}</button></li>)}</ul>
    {!done && <button className="rh-btn" onClick={() => onPick(null)}>都不是</button>}
    {done && <small>{e.chosen ? '已选定' : '都不是'}</small>}
    {repick && e.state !== 'pending' && <small>可以直接改选另一篇</small>}
  </div>;
}

function Later({ title, text }: { title: string; text: string }) {
  return <div className="rd-later"><span className="rh-micro">LATER · 第二期</span><h3>{title}</h3><p>{text}</p></div>;
}

/* ———— 01 解析 ———— */
function Explain({ paper, layers, findings, running, note, onNew, depth, setDepth, focus, ping, cite, openAnim, dispatch }: {
  paper: PaperView; layers: LayerCard[]; findings: FindingCard[]; running: boolean; note?: string; onNew?: () => void; depth: number; setDepth: (n: number) => void; focus: string[]; ping: number;
  cite: (r: string[]) => void; openAnim?: (a: Anim) => void; dispatch: (to: 'swarm' | 'auto', t: string) => void;
}) {
  const src = useRef<HTMLDivElement>(null);
  useEffect(() => { if (focus[0]) scrollWithin(src.current?.querySelector(`[data-sec="${focus[0]}"]`), 'center'); }, [focus, ping]);
  const no = (r: string) => paper.sections.find(s => s.id === r)?.no ?? r;
  const shown = layers.slice(0, depth);
  const lastLayer = layers.length ? layers[layers.length - 1] : null;
  return <div className="rd-explain">
    <div className="rd-layers">
      <header className="rd-paper-head"><span className="rh-micro">{paper.venue} · {paper.authors}</span><h1>{paper.title}</h1>
        {paper.access === 'abstract_only' && <p className="rd-abstract-only">■ 只拿到了摘要，没有开放获取的全文。下面的讲解只基于摘要，每条结论都要再核对。</p>}
        {layers.length > 0 && <div className="rd-depth" role="group" aria-label="解析深度">{layers.map((l, i) => <button key={l.id} aria-pressed={i < depth} data-now={i === depth - 1 || undefined} onClick={() => setDepth(i + 1)}><b>{l.no}</b>{l.title}</button>)}</div>}</header>
      {shown.map((l, i) => <article key={l.id} className="rd-layer" style={{ animationDelay: `${i * 60}ms` }}>
        <header><span className="rd-layer-no">{l.no}</span><span><b>{l.title}</b><small>{l.en}</small></span>{l.anim && openAnim && <button className="rh-btn" onClick={() => openAnim(l.anim as Anim)}>▶ 看动画</button>}</header>
        {l.body.map((b, k) => <div key={k} className="rd-para" onMouseEnter={() => cite(b.refs)}>
          <p>{b.text}</p>
          <span className="rd-refs">{b.refs.map(r => <button key={r} onClick={() => cite([r])}>{no(r)}</button>)}
            {l === lastLayer && k === l.body.length - 1 && !running && <button className="rd-dispatch" onClick={() => dispatch('swarm', `围绕《${paper.title}》的局限，找后续研究与反例`)}>派给群研 →</button>}</span>
        </div>)}
      </article>)}
      {running && <div className="rd-writing"><i /><span>正在写第 {String(layers.length + 1).padStart(2, '0')} 层…</span></div>}
      {!running && layers.length === 0 && <div className="rd-empty"><b>这篇还没有讲解</b><p>{note ?? '运行结束了，但没有生成讲解。'}</p>{onNew && <button className="rd-go" onClick={onNew}>新建精读</button>}</div>}
      {!running && depth < layers.length && <button className="rd-deeper" onClick={() => setDepth(depth + 1)}><span>更深一层</span><b>{layers[depth].no} · {layers[depth].title}</b><i>↓</i></button>}
      {findings.length > 0 && <section className="rd-findings"><header><span className="rh-micro">FINDINGS · 发现</span><small>每条都能回到原文</small></header>
        {findings.map(f => <article key={f.id} className="rd-finding" data-status={f.status}><em>#{f.n}</em><p>{f.text}</p>
          <footer><span>{CONF[f.confidence]}</span><span>{STATUS[f.status]}</span>{f.refs.map(r => <button key={r} onClick={() => cite([r])}>{no(r)}</button>)}</footer></article>)}</section>}
    </div>
    <aside className="rd-source" ref={src}>
      <header><span className="rh-ph-no">原</span><b>原文</b><small>{paper.access === 'full' ? '悬停解析段落，对应原文亮起' : '只有摘要'}</small></header>
      {paper.sections.length === 0 && <p className="rd-source-wait">{running ? '正在逐页读取…' : '还没有读到原文。'}</p>}
      {paper.sections.map(s => <section key={s.id} data-sec={s.id} data-on={focus.includes(s.id) || undefined}>
        {focus[0] === s.id && <i className="en-ring" key={ping} />}
        <h4><em>{s.no}</em>{s.title}</h4>{s.gist.map((g, i) => <p key={i}>{g}</p>)}
      </section>)}
    </aside>
  </div>;
}

/* ———— 02 动画 ———— */
function Lab({ anim, setAnim, dispatch }: { anim: Anim; setAnim: (a: Anim) => void; dispatch: (to: 'swarm' | 'auto', t: string) => void }) {
  const a = ANIMS.find(x => x.id === anim)!;
  return <div className="rd-lab">
    <nav className="rd-lab-tabs">{ANIMS.map((x, i) => <button key={x.id} aria-selected={x.id === anim} onClick={() => setAnim(x.id)}><b>{String(i + 1).padStart(2, '0')}</b><span>{x.title}<small>{x.en}</small></span></button>)}
      <button className="rd-dispatch" onClick={() => dispatch('swarm', `围绕「${a.title}」找后续研究与反例`)}>派给群研 →</button></nav>
    <div className="rd-lab-body" key={anim}>{anim === 'scaled' ? <ScaledAttention /> : anim === 'pe' ? <PositionalEncoding /> : <MultiHead />}</div>
  </div>;
}

/* ———— 03 复现 ———— */
function Repro({ ran, onRun, dispatch }: { ran: 'idle' | 'running' | 'done'; onRun: () => void; dispatch: (to: 'swarm' | 'auto', t: string) => void }) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (ran !== 'running') { if (ran === 'done') setStep(40); return; }
    setStep(0); const id = window.setInterval(() => setStep(s => Math.min(40, s + 1)), 60); return () => clearInterval(id);
  }, [ran]);
  const acc = (k: number) => 1 - .92 * Math.exp(-k / 9) - .02 * Math.sin(k * 1.7) * Math.exp(-k / 14);
  const pts = Array.from({ length: step + 1 }, (_, k) => `${(k / 40) * 100},${100 - acc(k) * 100}`).join(' ');
  return <div className="rd-repro">
    <section className="rd-code">
      <header><span className="xp-ext" data-ext="PY">PY</span><b>repro/attention_min.py</b><small>基于官方实现提炼的最小复现</small><button className="dv-run rd-run" onClick={onRun} disabled={ran === 'running'}>{ran === 'running' ? <Mobius stages={['训练', '评估']} current={0} running width={44} /> : <i />}<span><b>{ran === 'running' ? 'RUNNING' : ran === 'done' ? 'RERUN' : 'RUN'}</b><small>本地示例运行</small></span></button></header>
      <pre>{REPRO_CODE.split('\n').map((l, i) => <div key={i} data-key={/scale|10000/.test(l) || undefined}><i>{i + 1}</i><code>{l || ' '}</code></div>)}</pre>
    </section>
    <section className="rd-result">
      <figure className="rd-acc"><figcaption>反转任务 · 准确率 <b>{step ? `${(acc(step) * 100).toFixed(1)}%` : '—'}</b><small>{step * 50} / 2000 步</small></figcaption>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none"><line x1="0" x2="100" y1="1" y2="1" className="an-now" vectorEffect="non-scaling-stroke" /><polyline points={pts} className="an-on" vectorEffect="non-scaling-stroke" /></svg></figure>
      <table className="rd-claims"><thead><tr><th>论文结论</th><th>本地复现</th></tr></thead>
        <tbody>{CLAIMS.map((c, i) => <tr key={i} data-s={ran === 'done' ? c.status : 'idle'}><td>{c.claim}</td><td>{ran === 'done' ? c.ours : ran === 'running' ? '运行中…' : '未运行'}{ran === 'done' && c.status === 'todo' && <button className="rd-dispatch" onClick={() => dispatch('auto', 'WMT14 英德 BLEU 复现')}>交给自研 →</button>}</td></tr>)}</tbody></table>
      <p className="rd-honest">■ 复现层级：机理层（缩放、位置编码、小模型能学会）已对上；论文的主结果需要完整规模，这里没有复现。</p>
    </section>
  </div>;
}

/* ———— 04 检验 ———— */
function Check({ quizzes, understood, grade, onLayer }: { quizzes: QuizCard[]; understood: Record<string, Grade>; grade: (id: string, answer: string) => Promise<void>; onLayer: (l: string) => void }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [grading, setGrading] = useState<string | null>(null);
  const [gradeErr, setGradeErr] = useState<Record<string, boolean>>({});
  const ok = Object.values(understood).filter(v => v === 'ok').length;
  if (!quizzes.length) return <Later title="检查题" text="讲解写完后，这里会出几道用你自己的话回答的题，帮你确认真的懂了。" />;
  return <div className="rd-check">
    <header className="rd-check-head"><span className="rh-micro">CHECK · 用你自己的话回答</span><h2>你真的懂了吗？</h2>
      <div className="rd-score"><b>{String(ok).padStart(2, '0')}</b><i>/</i><em>{String(quizzes.length).padStart(2, '0')}</em><small>完全答对</small></div></header>
    {quizzes.map((q, i) => { const s = understood[q.id]; return <article key={q.id} className="rd-q" data-s={s}>
      <header><em>Q{i + 1}</em><b>{q.q}</b>{s && <i>{s === 'ok' ? '理解到位' : s === 'part' ? '答到一半' : '还没抓住'}</i>}</header>
      <textarea value={drafts[q.id] ?? ''} onChange={e => setDrafts(d => ({ ...d, [q.id]: e.target.value }))} placeholder="用一两句大白话写下你的理解…" rows={2} />
      <div className="rd-q-act"><button className="rh-btn is-solid" onClick={async () => { setGrading(q.id); setGradeErr(m => ({ ...m, [q.id]: false })); try { await grade(q.id, drafts[q.id] ?? ''); } catch { setGradeErr(m => ({ ...m, [q.id]: true })); } finally { setGrading(null); } }} disabled={!(drafts[q.id] ?? '').trim() || grading === q.id}>{grading === q.id ? '评分中…' : '提交'}</button>
        {s && s !== 'ok' && <span className="rd-hint">■ {q.hint ?? '回到对应的讲解层再看看。'} <button className="ts-link" onClick={() => onLayer(q.layer)}>回到解析</button></span>}
        {s === 'ok' && <span className="rd-good">抓住了要点。</span>}
        {gradeErr[q.id] && <span className="rd-hint">■ 评分暂时不可用，你的回答已经保留，稍后再提交一次。</span>}</div>
    </article>; })}
  </div>;
}
