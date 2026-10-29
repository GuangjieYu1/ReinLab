import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import BenchFrame from '../BenchFrame';
import { scrollWithin } from '../scrollWithin';
import AgentDock, { type DockDraft, type DockEvent, type Suggestion } from '../AgentDock';
import Explorer, { Tree, type ExplorerSection, type ExplorerView } from '../engineering/Explorer';
import { Mobius } from '../../rhine/RhineMark';
import type { BenchProps } from '../WorkbenchStudio';
import { BRIEF_FIELDS, BUDGET, CAT, PHASES, PROGRAM, TOPICS, nextExperiment, rng, scopeRounds, type BriefKey, type Cat, type Exp, type Step, type Topic } from './model';
import '../engineering/dev.css';
import './research.css';

// 研究台 RSCH：交互参照 OpenScience，在它之上补一块 Auto Research 循环的可视化。
// 01 定题：对话居中（对应 /plan），右侧研究简报逐条填满，你签发后才进入运行。
// 02 运行：最优前沿曲线（保留实心、回滚空心、最优值为台阶线）+ 当前实验卡（莫比乌斯）+ program.md；预算到 50% / 80% 停下等你批准。
// 03 报告：由保留下来的改动与发现整理成报告。

type Face = 'plan' | 'run' | 'report';
const clock = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const fmt = (v: number) => v.toFixed(4);
let seq = 0; const uid = () => `r${++seq}`;
type Round = { user: string; steps: Step[]; say: string; ask?: { q: string; chips: string[] }; shown: number; answered?: string };
type Finding = { n: number; text: string; at: string };

function seed(t: Topic, n: number, file: number): Exp[] {
  const r = rng(97 + file * 13), out: Exp[] = [];
  for (let i = 0; i < n; i++) out.push(nextExperiment(t, out, r));
  return out;
}

export default function ResearchBench({ file, reduced, chrome, modeSwitch, inbox }: BenchProps & { modeSwitch?: ReactNode; inbox?: string | null }) {
  const topic = TOPICS[file] ?? TOPICS[0];
  const rounds = useMemo(() => scopeRounds(topic), [topic]);
  const signedAtStart = topic.seeded > 0;
  const [face, setFace] = useState<Face>(signedAtStart ? 'run' : 'plan');
  const [brief, setBrief] = useState<Partial<Record<BriefKey, string>>>(() => signedAtStart ? { question: topic.question, hypothesis: topic.hypothesis, metric: `${topic.metric} · 越低越好 · 基线 ${fmt(topic.baseline)}`, scope: '只改 train.py 与 model.py', budget: '8 GPU·h · 最多 96 次 · 每次 5 分钟', compute: '本机 · 1×4090' } : {});
  const [flash, setFlash] = useState<BriefKey | null>(null);
  const [convo, setConvo] = useState<Round[]>([]);
  const [signed, setSigned] = useState(signedAtStart);
  const rand = useRef(rng(97 + file * 13 + 7));
  const [exps, setExps] = useState<Exp[]>(() => seed(topic, topic.seeded, file));
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState(0);
  const [speed, setSpeed] = useState<1 | 4>(1);
  const [only, setOnly] = useState<Cat | null>(null);
  const [gate, setGate] = useState<number[]>([]);         // 已批准的审批线（0.5 / 0.8）
  const [program, setProgram] = useState(PROGRAM);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [events, setEvents] = useState<DockEvent[]>(() => [{ id: uid(), kind: 'agent', at: clock(), text: inbox ? <p>收到从精读派来的目标：<b>{inbox}</b>。先在「定题」里把它写成可自动打分的指标，再签发运行。</p> : signedAtStart ? <p>简报已签发，循环跑到第 <b>{topic.seeded}</b> 次。点 <b>RESUME</b> 继续；你在 program.md 里改的指令下一轮生效。</p> : <p>简报签发后，我会在这里汇报每一次保留的改动。</p> }]);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = (ms: number, fn: () => void) => { timers.current.push(window.setTimeout(fn, reduced ? Math.min(ms, 40) : ms)); };
  const push = (e: DockDraft) => { const id = e.id ?? uid(); setEvents(l => [...l, { ...e, id } as DockEvent]); return id; };
  const patch = (id: string, p: Partial<DockEvent>) => setEvents(l => l.map(e => e.id === id ? { ...e, ...p } as DockEvent : e));
  const say = (text: ReactNode) => push({ kind: 'agent', text, at: clock() });

  /* ———— 定题：一轮一轮播放（步骤逐条出现，再说结论、提问）———— */
  const playRound = (i: number, user: string) => {
    const r = rounds[i]; if (!r) return;
    setConvo(c => [...c, { user, steps: r.steps, say: r.say, ask: r.ask, shown: 0 }]);
    r.steps.forEach((st, k) => later(380 + k * 420, () => {
      setConvo(c => c.map((x, j) => j === c.length - 1 ? { ...x, shown: k + 1 } : x));
      if (st.k === 'write') Object.entries(r.fills).forEach(([key, v], m) => later(m * 260, () => { setBrief(b => ({ ...b, [key]: v || user })); setFlash(key as BriefKey); }));
    }));
    later(380 + r.steps.length * 420 + 200, () => setConvo(c => c.map((x, j) => j === c.length - 1 ? { ...x, shown: 99 } : x)));
  };
  // 首轮在挂载时播放（开发模式下 StrictMode 会挂载两次：卸载时清空对话，重新播放）。
  useEffect(() => { if (signedAtStart) return; playRound(0, topic.ask); return () => setConvo([]); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const answer = (text: string) => {
    const idx = convo.length; if (idx >= rounds.length) return;
    setConvo(c => c.map((x, j) => j === c.length - 1 ? { ...x, answered: text } : x));
    playRound(idx, text);
  };
  const full = BRIEF_FIELDS.every(f => brief[f.key]);
  const sign = () => {
    if (!full || signed) return;
    setSigned(true); setFace('run');
    later(900, () => { setRunning(true); say(<p>简报已签发 · {clock()}。开始循环：每次只改一处，改进小于 0.0004 视为噪声回滚。</p>); });
  };

  /* ———— 运行：改代码 → 训练 → 评估 → 保留或回滚 → 记一行 ———— */
  const used = exps.length / BUDGET.cap;
  useEffect(() => {
    if (!running) return;
    const id = window.setTimeout(() => {
      if (phase < PHASES.length - 1) { setPhase(p => p + 1); return; }
      setPhase(0);
      // 一次实验落定：副作用（日志、发现、审批卡）放在更新函数之外，避免开发模式下重复执行。
      const list = exps, e = nextExperiment(topic, list, rand.current, only), next = [...list, e];
      const prevBest = list.reduce((b, x) => x.kept ? Math.min(b, x.value) : b, topic.baseline);
      setExps(next);
      if (e.kept) {
        push({ kind: 'tool', action: `exp #${String(e.n).padStart(3, '0')}`, label: e.idea.title, detail: `${fmt(e.value)} · Δ ${e.delta.toFixed(4)} · 保留`, state: 'done', ms: BUDGET.minutes * 60000 });
        const firstRepro = e.idea.paper && !list.some(x => x.kept && x.idea === e.idea);
        if (firstRepro || prevBest - e.value > .003) setFindings(fs => [...fs, { n: e.n, at: clock(), text: `${e.idea.title}：${topic.metric} ${fmt(prevBest)} → ${fmt(e.value)}${firstRepro ? `，复现了 ${e.idea.paper} 的收益` : ''}。` }]);
      }
      const line = [.5, .8].find(g => next.length / BUDGET.cap >= g && list.length / BUDGET.cap < g);
      if (line && !gate.includes(line)) {
        setRunning(false);
        const card = push({ kind: 'approval', action: 'budget_continue', title: `预算已用 ${Math.round(line * 100)}%，继续运行？`, effects: [`已跑 ${next.length} / ${BUDGET.cap} 次 · ${(next.length * BUDGET.minutes / 60).toFixed(1)} / ${BUDGET.gpuHours} GPU·h`, `当前最优 ${fmt(e.kept ? e.value : prevBest)}`], risk: 'write', state: 'pending', onApprove: () => {}, onReject: () => {} });
        patch(card, { onApprove: () => { patch(card, { state: 'approved' } as Partial<DockEvent>); setGate(g => [...g, line]); setRunning(true); }, onReject: () => { patch(card, { state: 'rejected' } as Partial<DockEvent>); setGate(g => [...g, line]); say(<p>好，循环停在第 {next.length} 次。可以去「报告」整理结果。</p>); } } as Partial<DockEvent>);
      }
      if (next.length >= BUDGET.cap) { setRunning(false); say(<p>预算用完，共 {next.length} 次。</p>); }
    }, (speed === 4 ? 420 : 1700) / PHASES.length);
    return () => clearTimeout(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, phase, speed]);

  const best = exps.reduce((b, x) => x.kept ? Math.min(b, x.value) : b, topic.baseline);
  const kept = exps.filter(e => e.kept);
  const onSend = (text: string) => {
    push({ kind: 'user', text, at: clock() });
    later(600, () => {
      if (/暂停|停/.test(text)) { setRunning(false); say(<p>已暂停在第 {exps.length} 次。</p>); }
      else if (/继续|开始|跑/.test(text)) { if (signed) { setRunning(true); say(<p>继续。</p>); } }
      else if (/结构/.test(text)) restrict('arch');
      else if (/调度/.test(text)) restrict('sched');
      else if (/报告/.test(text)) { setFace('report'); }
      else say(<p>当前最优 <b>{fmt(best)}</b>（基线 {fmt(topic.baseline)}），保留 {kept.length} / {exps.length}。可以说「只试结构类」「暂停」「写报告」。</p>);
    });
  };
  const restrict = (c: Cat) => { setOnly(c); setProgram(p => p + `- 接下来只试${CAT[c]}类改动\n`); say(<p>已写进 program.md：接下来只试<b>{CAT[c]}</b>类改动，下一轮生效。</p>); };
  const suggestions: Suggestion[] = [
    running ? { id: 'p', label: '暂停', onClick: () => onSend('暂停') } : { id: 'c', label: signed ? '继续运行' : '先签发简报', onClick: () => signed ? onSend('继续') : setFace('plan') },
    { id: 'a', label: '只试结构类', onClick: () => restrict('arch') },
    { id: 's', label: '只试调度类', onClick: () => restrict('sched') },
    { id: 'r', label: '整理成报告', onClick: () => setFace('report') },
  ];

  const faces = [
    { id: 'plan', label: '定题', en: 'PLAN', badge: signed ? 0 : BRIEF_FIELDS.length - BRIEF_FIELDS.filter(f => brief[f.key]).length },
    { id: 'run', label: '运行', en: 'RUN', locked: !signed, badge: kept.length },
    { id: 'report', label: '报告', en: 'REPORT', locked: exps.length < 6 },
  ];
  const goFace = (id: string) => {
    const f = faces.find(x => x.id === id)!;
    if (f.locked) { setFace(id === 'run' ? 'plan' : face); if (id === 'run') setFlash('compute'); return; }
    setFace(id as Face);
  };

  return <BenchFrame code="RSCH" section="002" file={file} reduced={reduced} chrome={chrome} faces={faces} face={face} onFace={goFace} tools={modeSwitch}
    strip={<>{topic.metric.toUpperCase()} <i>·</i> BASE {fmt(topic.baseline)} <i>·</i> BEST {fmt(best)} <i>·</i> FILE X—{String(file + 13).padStart(3, '0')}</>}
    shutterLines={f => [`> mount face · ${f.en.toLowerCase()}`, `> load brief · ${BRIEF_FIELDS.filter(x => brief[x.key]).length}/6 fields`, `> results.tsv · ${exps.length} rows`, '> ready']}
    status={<>
      <span><i className="en-sq" />{signed ? '已签发' : '定题中'}</span>
      <span>实验 {exps.length} / {BUDGET.cap}</span><span>保留 {kept.length}</span>
      <span data-alert={running || undefined}>{running ? '循环运行中' : '循环空闲'}</span>
      <span>GPU·h {(exps.length * BUDGET.minutes / 60).toFixed(1)} / {BUDGET.gpuHours}</span>
      <span>示例数据 · 不连接模型</span>
    </>}>
    {face === 'plan' ? <PlanFace topic={topic} convo={convo} brief={brief} flash={flash} full={full} signed={signed} onAnswer={answer} onSign={sign} />
      : face === 'run' ? <RunFace topic={topic} exps={exps} best={best} running={running} phase={phase} speed={speed} only={only} used={used} gate={gate} program={program} findings={findings}
          onRun={() => setRunning(v => !v)} onSpeed={() => setSpeed(s => s === 1 ? 4 : 1)} onProgram={setProgram} onApplyProgram={() => say(<p>收到新的研究指令，下一轮生效。</p>)}
          dock={<AgentDock name="研究负责人" target={`${topic.metric} · 最优 ${fmt(best)} · ${exps.length} 次`} plan={{ stages: ['定题', '基线', '循环', '整理发现', '报告'], current: exps.length >= 6 ? 3 : 2 }}
            suggestions={suggestions} events={events} busy={false} loop={running ? { stages: PHASES, current: phase } : null} onSend={onSend} placeholder="例如：只试结构类 · 暂停 · 写报告" />} />
      : <ReportFace topic={topic} exps={exps} best={best} findings={findings} />}
  </BenchFrame>;
}

/* ———— 01 定题 ———— */
const STEP_LABEL: Record<Step['k'], string> = { think: '想', search: '搜', read: '读', run: '跑', write: '写' };
function PlanFace({ topic, convo, brief, flash, full, signed, onAnswer, onSign }: {
  topic: Topic; convo: Round[]; brief: Partial<Record<BriefKey, string>>; flash: BriefKey | null; full: boolean; signed: boolean; onAnswer: (t: string) => void; onSign: () => void;
}) {
  const [xpOpen, setXpOpen] = useState(true), [view, setView] = useState<ExplorerView>('files');
  const [draft, setDraft] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight, behavior: 'smooth' }); }, [convo]);
  const last = convo[convo.length - 1];
  const waiting = last && last.shown >= 99 && last.ask && !last.answered;
  const sections: ExplorerSection[] = [
    { id: 'papers', title: '文献', count: topic.papers.length, body: <Tree nodes={topic.papers.map((p, i) => ({ name: p, path: `p${i}`, meta: <span className="rs-xp-meta">{i === 0 ? '已读' : '摘要'}</span> }))} onOpen={() => {}} /> },
    { id: 'files', title: 'nanochat · 研究仓库', grow: true, body: <Tree nodes={[{ name: 'train.py', path: 'train.py', title: '412 行 · 可改' }, { name: 'model.py', path: 'model.py', title: '可改' }, { name: 'prepare.py', path: 'prepare.py', title: '只读 · 评测' }, { name: 'program.md', path: 'program.md', title: '研究指令' }, { name: 'notes', path: 'notes', children: [{ name: '研究笔记.md', path: 'notes/n.md' }] }]} onOpen={() => {}} /> },
    { id: 'gpu', title: '算力', body: <div className="dv-xp-list"><div><b><i data-on />本机 · 1×4090</b><small>24 GB · 空闲</small></div><div><b><i />远程 · 8×H100</b><small>需审批</small></div></div> },
  ];
  return <div className="rs-plan rh">
    <Explorer code="RSCH" open={xpOpen} view={view} onView={setView} onToggle={() => setXpOpen(v => !v)} title={topic.metric} sections={sections} />
    <section className="rs-talk" data-wb-panel>
      <header className="dv-bar"><div className="dv-bar-id"><b>PLAN</b><small>/PLAN<br />定题</small></div>
        <div className="rs-talk-head"><span className="rh-micro">RESEARCH LEAD · 研究负责人</span><strong>先对齐方法，再动算力</strong></div></header>
      <div className="rs-convo" ref={box}>
        <span className="rs-ghost" aria-hidden="true">/PLAN</span>
        {convo.map((r, i) => <div key={i} className="rs-round">
          <div className="rs-user"><i>你</i><p>{r.user}</p></div>
          <div className="rs-agent">
            <i className="rs-who">RL</i>
            <div>
              <ol className="rs-steps">{r.steps.slice(0, r.shown).map((s, k) => <TraceStep key={k} s={s} />)}{r.shown < r.steps.length && <li className="rs-thinking"><Mobius stages={['想', '搜', '读', '跑', '写']} current={Math.min(r.shown, 4)} running width={70} /></li>}</ol>
              {r.shown >= 99 && <div className="rs-say"><p>{r.say}</p>
                {r.ask && <div className="rs-ask"><b>■ {r.ask.q}</b>{r.answered ? <span className="rs-answered">你选了：{r.answered}</span> : <div>{r.ask.chips.map(c => <button key={c} className="rh-btn" onClick={() => onAnswer(c)}>{c}</button>)}</div>}</div>}
              </div>}
            </div>
          </div>
        </div>)}
        {full && !signed && <div className="rs-ready"><b>简报已齐</b><span>签发后进入运行。签发只能你来点。</span><button className="rh-btn is-solid" onClick={onSign}>签发简报 →</button></div>}
      </div>
      <form className="rs-input" onSubmit={e => { e.preventDefault(); if (draft.trim() && waiting) { onAnswer(draft.trim()); setDraft(''); } }}>
        <input value={draft} onChange={e => setDraft(e.target.value)} placeholder={waiting ? `回答：${last.ask!.q}` : full ? '简报已齐 · 在右侧签发' : '研究负责人正在整理…'} disabled={!waiting} />
        <button className="rh-btn is-solid" disabled={!waiting || !draft.trim()}>发送</button>
      </form>
    </section>
    <aside className="rs-brief" data-wb-panel>
      <header><span className="rh-ph-no">B</span><span><b>研究简报</b><small>BRIEF · {BRIEF_FIELDS.filter(f => brief[f.key]).length} / {BRIEF_FIELDS.length}</small></span>
        <i className="rq-ticks">{BRIEF_FIELDS.map(f => <i key={f.key} data-done={brief[f.key] ? true : undefined} />)}</i></header>
      <span className="rs-brief-ghost" aria-hidden="true">BRIEF</span>
      <dl>{BRIEF_FIELDS.map((f, i) => <div key={f.key} data-filled={brief[f.key] ? true : undefined} data-flash={flash === f.key || undefined}>
        <dt><em>{String(i + 1).padStart(2, '0')}</em>{f.label}<small>{f.en}</small></dt>
        <dd key={brief[f.key] ?? 'empty'}>{brief[f.key] ?? '待定'}</dd>
      </div>)}</dl>
      <footer>
        <button className="rs-sign" onClick={onSign} disabled={!full || signed} data-ready={full && !signed || undefined}>
          <i /><span><b>{signed ? 'SIGNED' : 'SIGN'}</b><small>{signed ? '已签发 · 进入运行' : full ? '签发简报 · 只能你点' : `还差 ${BRIEF_FIELDS.length - BRIEF_FIELDS.filter(f => brief[f.key]).length} 项`}</small></span><em>{signed ? '■' : '▸'}</em>
        </button>
      </footer>
    </aside>
  </div>;
}
function TraceStep({ s }: { s: Step }) {
  const [open, setOpen] = useState(false);
  return <li className="rs-step" data-k={s.k}><button onClick={() => setOpen(v => !v)} aria-expanded={open}><em>{STEP_LABEL[s.k]}</em><span>{s.text}</span><i>{s.detail ? (open ? '−' : '+') : ''}</i></button>{open && s.detail && <p>{s.detail}</p>}</li>;
}

/* ———— 02 运行 ———— */
function RunFace({ topic, exps, best, running, phase, speed, only, used, gate, program, findings, onRun, onSpeed, onProgram, onApplyProgram, dock }: {
  topic: Topic; exps: Exp[]; best: number; running: boolean; phase: number; speed: 1 | 4; only: Cat | null; used: number; gate: number[]; program: string; findings: Finding[];
  onRun: () => void; onSpeed: () => void; onProgram: (s: string) => void; onApplyProgram: () => void; dock: ReactNode;
}) {
  const [xpOpen, setXpOpen] = useState(true), [view, setView] = useState<ExplorerView>('files');
  const [sel, setSel] = useState<number | null>(null);
  const last = exps[exps.length - 1];
  const shown = sel ? exps.find(e => e.n === sel) ?? last : last;
  const kept = exps.filter(e => e.kept);
  const gain = ((topic.baseline - best) / topic.baseline) * 100;
  const sections: ExplorerSection[] = [
    { id: 'log', title: 'results.tsv · 实验日志', count: exps.length, grow: true, body: <div className="rs-log">{[...exps].reverse().map(e => <button key={e.n} data-kept={e.kept || undefined} aria-current={shown?.n === e.n || undefined} onClick={() => setSel(e.n)}>
      <em>{String(e.n).padStart(3, '0')}</em><span title={e.idea.title}>{e.idea.title}<small>{CAT[e.idea.cat]}</small></span><b>{fmt(e.value)}</b><i>{e.kept ? '保留' : '回滚'}</i></button>)}</div> },
    { id: 'files', title: '文件', folded: true, body: <Tree nodes={[{ name: 'train.py', path: 'train.py', badge: 'M', ai: true }, { name: 'model.py', path: 'model.py', badge: kept.some(k => k.idea.cat === 'arch') ? 'M' : undefined }, { name: 'prepare.py', path: 'prepare.py', title: '只读' }, { name: 'program.md', path: 'program.md', badge: 'M' }, { name: 'results.tsv', path: 'results.tsv' }]} onOpen={() => {}} /> },
  ];
  return <div className="rs-run rh">
    <Explorer code="RSCH" open={xpOpen} view={view} onView={setView} onToggle={() => setXpOpen(v => !v)} title={`${exps.length} 次实验`} sections={sections} badges={{ files: kept.length || undefined }} />
    <section className="rs-center" data-wb-panel>
      <header className="dv-bar rs-bar" data-busy={running || undefined}>
        <div className="dv-bar-id"><b>RUN</b><small>LOOP<br />运行</small></div>
        <div className="rs-exp"><em>#{String(exps.length).padStart(3, '0')}</em><span><small>EXPERIMENT · 实验</small>{only ? `只试${CAT[only]}类` : '全部类别'}</span></div>
        <div className="rs-best"><small>BEST · {topic.metric}</small><b key={best}>{fmt(best)}</b><span>−{gain.toFixed(2)}% vs 基线 {fmt(topic.baseline)}</span></div>
        <div className="rs-budget"><small>GPU·h {(exps.length * BUDGET.minutes / 60).toFixed(1)} / {BUDGET.gpuHours} · {exps.length}/{BUDGET.cap} 次</small>
          <span className="rs-gauge"><span style={{ transform: `scaleX(${Math.min(1, used)})` }} />{[.5, .8].map(g => <i key={g} style={{ left: `${g * 100}%` }} data-passed={gate.includes(g) || undefined} title={`${g * 100}% 审批线`} />)}</span></div>
        <button className="rs-speed" onClick={onSpeed} title="演示速度">×{speed}</button>
        <button className="dv-run" onClick={onRun}>{running ? <Mobius stages={PHASES} current={phase} running width={54} /> : <i />}<span><b>{running ? 'PAUSE' : exps.length ? 'RESUME' : 'START'}</b><small>{running ? `${PHASES[phase]}中…` : '自动研究循环'}</small></span></button>
      </header>
      <div className="rs-chart-wrap"><Frontier topic={topic} exps={exps} best={best} sel={shown?.n} onPick={setSel} /></div>
      <div className="rs-lower">
        <section className="rs-card">
          <header><span className="rh-ph-no">E</span><b>{shown ? `#${String(shown.n).padStart(3, '0')} · ${shown.idea.title}` : '等待第一次实验'}</b>{shown && <i data-kept={shown.kept || undefined}>{shown.kept ? '保留' : '回滚'}</i>}</header>
          {running && !sel && <div className="rs-phases">{PHASES.map((p, i) => <span key={p} data-s={i < phase ? 'done' : i === phase ? 'now' : undefined}>{p}</span>)}</div>}
          {shown && <><div className="rs-diff"><div data-op="-">− {shown.idea.diff[0]}</div><div data-op="+">+ {shown.idea.diff[1]}</div></div>
            <dl><dt>{topic.metric}</dt><dd>{fmt(shown.value)}</dd><dt>Δ 最优</dt><dd data-good={shown.delta < 0 || undefined}>{shown.delta > 0 ? '+' : ''}{shown.delta.toFixed(4)}</dd><dt>类别</dt><dd>{CAT[shown.idea.cat]}</dd>{shown.idea.paper && <><dt>来源</dt><dd>{shown.idea.paper}</dd></>}</dl></>}
          {sel && <button className="rs-back" onClick={() => setSel(null)}>回到最新 →</button>}
        </section>
        <section className="rs-program">
          <header><span className="rh-ph-no">P</span><b>program.md</b><small>研究指令 · 人在这里写</small><button className="rh-btn" onClick={onApplyProgram}>应用</button></header>
          <textarea value={program} onChange={e => onProgram(e.target.value)} spellCheck={false} />
        </section>
        <section className="rs-findings">
          <header><span className="rh-ph-no">F</span><b>发现</b><small>{findings.length} 条</small></header>
          <ol>{findings.length ? [...findings].reverse().map(f => <li key={f.n}><em>#{String(f.n).padStart(3, '0')}</em>{f.text}</li>) : <li className="rs-none">循环开始后，值得记下的结果会出现在这里。</li>}</ol>
        </section>
      </div>
    </section>
    {dock}
  </div>;
}

/** 最优前沿曲线：每次实验一个点，保留实心、回滚空心，最优值是台阶线；纵轴按数据范围自适应。 */
function Frontier({ topic, exps, best, sel, onPick, mini }: { topic: Topic; exps: Exp[]; best: number; sel?: number; onPick?: (n: number) => void; mini?: boolean }) {
  const n = Math.max(24, exps.length + 4);
  const vals = [topic.baseline, ...exps.map(e => e.value)];
  const lo = Math.min(...vals), hi = Math.max(...vals), pad = (hi - lo) * .12 || .002;
  const y = (v: number) => ((hi + pad - v) / (hi - lo + pad * 2)) * 100, x = (i: number) => (i / n) * 100;
  let b = topic.baseline; const steps = [`M 0 ${y(b)}`];
  exps.forEach(e => { if (e.kept) { steps.push(`H ${x(e.n)}`, `V ${y(e.value)}`); b = e.value; } });
  steps.push(`H ${x(exps.length)}`);
  const ticks = Array.from({ length: 5 }, (_, i) => hi + pad - (i / 4) * (hi - lo + pad * 2));
  return <div className="rs-frontier" data-mini={mini || undefined}>
    {!mini && <div className="rs-fr-head"><span className="rh-micro">FRONTIER · 最优前沿</span><span className="rs-fr-legend"><span><i className="is-kept" />保留</span><span><i />回滚</span><span><i className="is-step" />最优</span><span><i className="is-base" />基线</span></span></div>}
    <div className="rs-plot">
      {ticks.map((t, i) => <span key={i} className="rs-ytick" style={{ top: `${(i / 4) * 100}%` }}><b>{fmt(t)}</b></span>)}
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <line x1="0" x2="100" y1={y(topic.baseline)} y2={y(topic.baseline)} className="rs-baseline" vectorEffect="non-scaling-stroke" />
        <path d={steps.join(' ')} className="rs-step" vectorEffect="non-scaling-stroke" />
      </svg>
      {exps.map((e, i) => <button key={e.n} className="rs-pt" data-kept={e.kept || undefined} data-new={i === exps.length - 1 || undefined} aria-current={sel === e.n || undefined}
        style={{ left: `${x(e.n)}%`, top: `${y(e.value)}%` }} onClick={() => onPick?.(e.n)} title={`#${e.n} ${e.idea.title} · ${fmt(e.value)}`} />)}
      {exps.length > 0 && <span className="rs-bestmark" style={{ top: `${y(best)}%` }}><b>{fmt(best)}</b></span>}
      {!mini && <span className="rs-base-label" style={{ top: `${y(topic.baseline)}%` }}>基线 {fmt(topic.baseline)}</span>}
    </div>
  </div>;
}

/* ———— 03 报告 ———— */
function ReportFace({ topic, exps, best, findings }: { topic: Topic; exps: Exp[]; best: number; findings: Finding[] }) {
  const kept = exps.filter(e => e.kept);
  const notRepro = topic.ideas.filter(i => i.paper && exps.some(e => e.idea === i) && !kept.some(k => k.idea === i));
  const byCat = (Object.keys(CAT) as Cat[]).map(c => ({ c, tried: exps.filter(e => e.idea.cat === c).length, kept: kept.filter(e => e.idea.cat === c).length })).filter(x => x.tried);
  return <div className="rs-report en-report">
    <nav className="en-report-index"><span className="rh-micro">INDEX</span>{['摘要', '最优前沿', '保留的改动', '按类别', '文献复现', '下一步'].map((t, i) => <button key={t} onClick={() => scrollWithin(document.getElementById(`rs-sec-${i}`), 'start')}><em>{String(i + 1).padStart(2, '0')}</em>{t}</button>)}</nav>
    <article className="rh-read en-report-body">
      <span className="rh-micro">RESEARCH REPORT · {topic.metric} · {exps.length} 次实验 · {clock()}</span>
      <h2>{topic.question}</h2>
      <div className="ts-report-nums" id="rs-sec-0">
        <span><b>{fmt(best)}</b><small>最优 {topic.metric}</small></span>
        <span data-s="pass"><b>−{(((topic.baseline - best) / topic.baseline) * 100).toFixed(2)}%</b><small>较基线 {fmt(topic.baseline)}</small></span>
        <span><b>{String(kept.length).padStart(2, '0')}</b><small>保留 / {exps.length} 次</small></span>
        <span><b>{(exps.length * BUDGET.minutes / 60).toFixed(1)}</b><small>GPU·h 已用 / {BUDGET.gpuHours}</small></span>
      </div>
      <h3 id="rs-sec-1">最优前沿</h3>
      <div className="rs-report-fig"><Frontier topic={topic} exps={exps} best={best} mini /></div>
      <h3 id="rs-sec-2">保留的改动</h3>
      <table className="rs-table"><thead><tr><th>#</th><th>改动</th><th>类别</th><th>{topic.metric}</th><th>Δ</th></tr></thead>
        <tbody>{kept.map(e => <tr key={e.n}><td>{String(e.n).padStart(3, '0')}</td><td>{e.idea.title}</td><td>{CAT[e.idea.cat]}</td><td>{fmt(e.value)}</td><td>{e.delta.toFixed(4)}</td></tr>)}</tbody></table>
      <h3 id="rs-sec-3">按类别</h3>
      <ul>{byCat.map(x => <li key={x.c}>{CAT[x.c]}：试了 {x.tried} 次，保留 {x.kept} 次。</li>)}</ul>
      <h3 id="rs-sec-4">文献复现</h3>
      <ul>{findings.filter(f => /复现/.test(f.text)).map(f => <li key={f.n}>{f.text}</li>)}{notRepro.map(i => <li key={i.title}>未复现：{i.title}（{i.paper}），在本设置下改进小于噪声。</li>)}{!findings.some(f => /复现/.test(f.text)) && !notRepro.length && <li>文献里的技巧还没有轮到。</li>}</ul>
      <h3 id="rs-sec-5">下一步</h3>
      <p>把保留的改动组合起来跑 3 个种子确认可叠加性；对回滚但接近阈值的改动（Δ 在 ±0.0006 内）加跑种子，排除噪声。</p>
      <div className="ts-report-act"><button className="rh-btn is-solid">导出 md</button><button className="rh-btn">导出 PDF</button><button className="rh-btn">附 results.tsv</button></div>
    </article>
  </div>;
}
