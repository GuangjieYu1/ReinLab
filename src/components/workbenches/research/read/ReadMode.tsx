import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import BenchFrame from '../../BenchFrame';
import { scrollWithin } from '../../scrollWithin';
import AgentDock, { type DockEvent, type Suggestion } from '../../AgentDock';
import Explorer, { Tree, type ExplorerSection, type ExplorerView } from '../../engineering/Explorer';
import { Mobius } from '../../../rhine/RhineMark';
import type { BenchChrome } from '../../WorkbenchStudio';
import { CLAIMS, REPRO_CODE } from './paper';
import { MultiHead, PositionalEncoding, ScaledAttention } from './Anims';
import { mockReadAdapter } from './mockRead';
import { useRead } from './useRead';
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
const RUN_TEXT: Record<RunView['state'], string> = { idle: '未开始', estimating: '正在预估', confirm: '等你确认预算', queued: '排队中', running: '运行中', waiting: '等你批准', done: '已完成', failed: '失败', cancelled: '已停止' };
const active = (r: RunView) => r.state === 'queued' || r.state === 'running' || r.state === 'waiting';
const money = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `¥${v < 0.1 ? v.toFixed(3) : v.toFixed(2)}`);

export default function ReadMode({ file, reduced, chrome, modeSwitch, onDispatch, adapter: given }: {
  file: number; reduced: boolean; chrome: BenchChrome; modeSwitch: ReactNode; onDispatch: (to: 'swarm' | 'auto', text: string) => void; adapter?: ReadAdapter;
}) {
  const adapter = useMemo(() => given ?? mockReadAdapter({ reduced }), [given, reduced]);
  const { state, reload } = useRead(adapter);
  const [face, setFace] = useState<Face>('explain');
  const [depth, setDepth] = useState(3);                 // 展开到第几层
  const [focus, setFocus] = useState<string[]>([]);      // 当前高亮的原文段
  const [ping, setPing] = useState(0);
  const [anim, setAnim] = useState<Anim>('scaled');
  const [understood, setUnderstood] = useState<Record<string, Grade>>({});
  const [ran, setRan] = useState<'idle' | 'running' | 'done'>('idle');
  const [asking, setAsking] = useState(false);
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
    for (const e of log.slice(seenLog.current)) if (e.type === 'agent') { if (e.refs?.length) cite(e.refs); if (e.anim && state?.anims.includes(e.anim)) openAnim(e.anim as Anim); setAsking(false); }
    seenLog.current = log.length;
  }, [state?.log.length]);
  // 第一次拿到数据时，从第一层开始高亮
  const stamps = useRef(new Map<string, string>());
  const at = (id: string) => { if (!stamps.current.has(id)) stamps.current.set(id, clock()); return stamps.current.get(id)!; };

  if (!state) return <BenchFrame code="RSCH" section="002" file={file} reduced={reduced} chrome={chrome} face={face} onFace={id => setFace(id as Face)}
    faces={[{ id: 'explain', label: '解析', en: 'EXPLAIN' }]} strip={<>READ <i>·</i> 读取中</>} tools={modeSwitch} shutterLines={() => ['> open dossier', '> ready']}
    status={<span>正在读取档案…</span>}><div className="rd rh" /></BenchFrame>;

  const { paper, layers, quizzes, findings, run } = state;
  const dispatch = (to: 'swarm' | 'auto', text: string) => { onDispatch(to, text); };
  const ask = (text: string) => { setAsking(true); void adapter.ask(text).catch(() => setAsking(false)); };
  // 还没开始读时，对话就是「澄清想读哪篇」
  const talk = (text: string) => { if (paper) return ask(text); setAsking(true); void adapter.clarify(text).finally(() => setAsking(false)); };
  const runRepro = () => {
    if (ran === 'running') return;
    setRan('running'); window.setTimeout(() => setRan('done'), reduced ? 60 : 2600);
  };
  const newReading = adapter.newReading ? async () => { await adapter.newReading!(); seenLayers.current = 0; seenLog.current = 0; setUnderstood({}); setFocus([]); setFace('explain'); setDepth(3); await reload(); } : undefined;

  const events: DockEvent[] = state.log.map((e: ReadEvent): DockEvent | null => {
    if (e.type === 'user') return { id: e.id, kind: 'user', text: e.text, at: at(e.id) };
    if (e.type === 'agent') return { id: e.id, kind: 'agent', at: at(e.id), text: <><p>{e.text}</p>{(e.refs?.length || (e.anim && state.anims.includes(e.anim))) && <p>{e.refs?.map(r => <b key={r} className="ad-ref" onClick={() => { setFace('explain'); cite([r]); }}>{paper?.sections.find(s => s.id === r)?.no ?? r}</b>)}{e.anim && state.anims.includes(e.anim) && <> · <b className="ad-ref" onClick={() => openAnim(e.anim as Anim)}>打开动画</b></>}</p>}</> };
    if (e.type === 'tool') return { id: e.id, kind: 'tool', action: e.action, label: e.label, state: e.state, detail: e.detail, ms: e.ms };
    if (e.type === 'pick') return { id: e.id, kind: 'card', body: <PickCard e={e} onPick={c => void adapter.pick(e.id, c)} /> };
    if (e.type === 'approval') return { id: e.id, kind: 'approval', action: e.action, title: e.title, effects: e.effects, risk: e.risk, state: e.state, onApprove: () => void adapter.decide(e.id, true), onReject: () => void adapter.decide(e.id, false) };
    return null;
  }).filter((x): x is DockEvent => x !== null);
  const pending = state.log.filter((e): e is Extract<ReadEvent, { type: 'approval' }> => e.type === 'approval' && e.state === 'pending');

  const okCount = Object.values(understood).filter(v => v === 'ok').length;
  const suggestions: Suggestion[] = !paper ? (run.chosen || active(run) ? [] : [
    { id: 'e1', label: '讲智能体边推理边行动的那篇', onClick: () => talk('讲智能体边推理边行动的那篇') },
    { id: 'e2', label: 'react', onClick: () => talk('react') },
    { id: 'e3', label: 'Transformer 的原始论文', onClick: () => talk('Transformer 的原始论文 attention') },
  ]) : face === 'lab' ? [
    { id: 'a', label: '为什么要除以根号 d？', onClick: () => ask('为什么要除以根号 d？') },
    { id: 'b', label: '位置编码怎么表达顺序？', onClick: () => ask('位置编码怎么表达顺序？') },
  ] : [
    { id: 'q', label: 'Q、K、V 分别是什么？', onClick: () => ask('Q、K、V 分别是什么？') },
    { id: 'f', label: '为什么它比循环网络快？', onClick: () => ask('为什么它比循环网络快？') },
    { id: 's', label: '派给群研：后来怎么解决长文本？', onClick: () => dispatch('swarm', '注意力计算量随长度平方增长，后续工作如何解决长文本？') },
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
    status={<><span><i className="en-sq" />精读</span><span>{paper?.title ?? state.dossier.title}</span><span>解析 {Math.min(depth, layers.length)}/{layers.length || 5} 层</span><span>理解 {okCount}/{quizzes.length}</span><span>{RUN_TEXT[run.state]} · {money(run.spentCny)}{run.unknownCost ? ' + 未知' : ''}</span>{!paper && <span>澄清 {money(run.clarifySpentCny ?? 0)} / ¥{run.clarifyCapCny ?? 0.05}</span>}<span>{adapter.kind === 'mock' ? '示例数据 · 不连接模型' : '真实数据'}</span></>}>
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
    <span className="rd-run-chip"><i />{RUN_TEXT[run.state]}</span>
    <span className="rd-run-step">{run.message ?? run.step ?? (run.state === 'done' ? '这次精读已完成' : '')}{pending > 0 && <b> · 右边有 {pending} 个审批等你</b>}</span>
    <span className="rd-run-cost"><small>已花</small><b>{money(run.spentCny)}</b>{run.unknownCost && <em>+ 未知用量</em>}<small>/ 预算 ¥{run.budgetCny}</small></span>
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
      {!c && before && <>
        <h2>想读哪篇？</h2>
        <p className="rd-start-lead">在右边告诉精读助手，说得模糊也没关系，比如「讲智能体边推理边行动的那篇」。它会检索，拿不准就问你，再把候选论文列出来让你选。</p>
        <ol className="rd-start-steps"><li data-now><b>01</b>对话说清读哪篇</li><li><b>02</b>按这篇预估费用</li><li><b>03</b>你确认后开始读</li></ol>
        <small className="rd-start-note">澄清对话用便宜档模型，上限 ¥{run.clarifyCapCny ?? 0.05}，不单独确认；已用 {money(run.clarifySpentCny ?? 0)}。</small>
      </>}
      {c && before && <>
        <h2>读这篇</h2>
        <div className="rd-chosen"><span><b>{c.title}</b><small>{c.authors} · {c.venue}{c.pages ? ` · ${c.pages} 页` : ''} · {c.access === 'full' ? '有开放全文' : '只有摘要'}</small></span>
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
          <div><button className="rh-btn" onClick={() => void adapter.decide(a.id, false)}>不下载</button><button className="rd-go" onClick={() => void adapter.decide(a.id, true)}>批准</button></div></div>)}
        <button className="rh-btn" onClick={() => void adapter.cancel()}>停止</button>
      </div>}
      {(run.state === 'done' || run.state === 'cancelled' || run.state === 'failed') && <div className="rd-start-run">
        <h2>{RUN_TEXT[run.state]}</h2>
        <p><span><small>{run.message ?? ''} 已花 {money(run.spentCny)}{run.unknownCost ? '，另有未知用量' : ''}。</small></span></p>
        {onNew && <button className="rd-go" onClick={onNew}>重新开始</button>}
      </div>}
    </div>
  </div>;
}

/** 对话里的候选论文卡片：你点一篇才算选定，AI 不替你决定。 */
function PickCard({ e, onPick }: { e: Extract<ReadEvent, { type: 'pick' }>; onPick: (id: string | null) => void }) {
  const done = e.state !== 'pending';
  return <div className="rd-pick" data-done={done || undefined}>
    <b>候选 · 「{e.query}」</b>
    <ul>{e.candidates.map(c => <li key={c.id}><button disabled={done} aria-pressed={e.chosen === c.id} onClick={() => onPick(c.id)}>
      <span><b>{c.title}</b><small>{c.authors} · {c.venue}{c.pages ? ` · ${c.pages} 页` : ''} · {c.access === 'full' ? '有开放全文' : '只有摘要'}</small></span>{c.note && <em>{c.note}</em>}</button></li>)}</ul>
    {!done && <button className="rh-btn" onClick={() => onPick(null)}>都不是</button>}
    {done && <small>{e.chosen ? '已选定' : '都不是'}</small>}
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
