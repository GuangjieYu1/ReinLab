import { useEffect, useMemo, useRef, useState } from 'react';
import Chat, { msgId, now, type Msg } from './Chat';
import type { BenchProps } from './WorkbenchStudio';
import './bench-research.css';

/* ── Sample topics ───────────────────────────────────────────────────── */
type Cat = 'arch' | 'opt' | 'sched' | 'data' | 'reg';
const CAT: Record<Cat, string> = { arch: '结构', opt: '优化器', sched: '调度', data: '数据', reg: '正则' };
type Idea = { title: string; cat: Cat; effect: number; diff: [string, string] };
interface Topic { ask: string; question: string; metric: string; unit: string; baseline: number; scope: string[]; papers: string[]; ideas: Idea[]; running: number }
const IDEAS: Idea[] = [
  { title: 'warmup 600 → 1200 步', cat: 'sched', effect: -.0032, diff: ['warmup_steps = 600', 'warmup_steps = 1200'] },
  { title: 'LayerNorm 换成 RMSNorm', cat: 'arch', effect: -.0018, diff: ['norm = nn.LayerNorm(d)', 'norm = RMSNorm(d)'] },
  { title: '层数 12 → 14，宽度 768 → 704', cat: 'arch', effect: .0012, diff: ['n_layer, d = 12, 768', 'n_layer, d = 14, 704'] },
  { title: 'AdamW β₂ 0.95 → 0.98', cat: 'opt', effect: -.0009, diff: ['betas = (0.9, 0.95)', 'betas = (0.9, 0.98)'] },
  { title: '加入 QK-Norm', cat: 'arch', effect: -.0041, diff: ['q, k = q, k', 'q, k = qk_norm(q), qk_norm(k)'] },
  { title: '余弦调度改为 WSD', cat: 'sched', effect: -.0047, diff: ["schedule = 'cosine'", "schedule = 'wsd'  # decay 20%"] },
  { title: '梯度裁剪 1.0 → 0.5', cat: 'opt', effect: .0004, diff: ['clip_grad = 1.0', 'clip_grad = 0.5'] },
  { title: '去掉 dropout', cat: 'reg', effect: -.0021, diff: ['dropout = 0.1', 'dropout = 0.0'] },
  { title: 'SwiGLU 激活', cat: 'arch', effect: -.0026, diff: ['act = nn.GELU()', 'act = SwiGLU(d, 4 * d)'] },
  { title: '权重衰减 0.1 → 0.05', cat: 'reg', effect: .0006, diff: ['weight_decay = 0.1', 'weight_decay = 0.05'] },
  { title: 'batch 256 → 384', cat: 'data', effect: .0015, diff: ['batch_size = 256', 'batch_size = 384'] },
  { title: 'RoPE base 10k → 50k', cat: 'arch', effect: -.0007, diff: ['rope_base = 10_000', 'rope_base = 50_000'] },
  { title: '学习率 3e-4 → 6e-4', cat: 'opt', effect: -.0013, diff: ['lr = 3e-4', 'lr = 6e-4'] },
  { title: '去重后的数据顺序', cat: 'data', effect: -.0011, diff: ['loader = shuffle(raw)', 'loader = shuffle(dedup(raw))'] },
  { title: '嵌入层与输出层共享权重', cat: 'arch', effect: -.0005, diff: ['lm_head = Linear(d, V)', 'lm_head.weight = wte.weight'] },
  { title: 'Lion 替换 AdamW', cat: 'opt', effect: .0024, diff: ['opt = AdamW(params, lr)', 'opt = Lion(params, lr / 3)'] },
];
const TOPICS: Topic[] = [
  { ask: '我想看看文献里那几个训练技巧，在我们的小模型上还成不成立。', question: '文献中的训练技巧，在 124M 小模型上能否复现收益？', metric: 'val_bpb', unit: '', baseline: 1.0212, scope: ['只改 train.py，不改评测', '模型规模固定 124M', '每个技巧单独验证，再组合'], papers: ['nanoGPT speedrun 记录', 'QK-Norm (Dehghani 2023)', 'WSD 调度 (Hu 2024)'], ideas: IDEAS, running: 0 },
  { ask: '帮我找一个能区分“记住”和“理解”的评估方法。', question: '哪种评估信号最能区分记忆与泛化？', metric: 'gap_score', unit: '', baseline: .412, scope: ['只改评估脚本', '数据集不变', '每种方法 3 个种子'], papers: ['Counterfactual eval (2024)', 'Perturbation tests', 'Held-out canaries'], ideas: IDEAS.slice(4).concat(IDEAS.slice(0, 4)), running: 0 },
  { ask: '固定计算预算下，模型结构的收益是不是依赖优化方法？', question: '固定 1×10¹⁸ FLOPs 预算下，结构改动的收益是否依赖优化方法与调度？', metric: 'val_bpb', unit: '', baseline: .9984, scope: ['只改 train.py 与 model.py', '每次实验 5 分钟墙钟', '评测集与分词器不变'], papers: ['autoresearch (Karpathy 2026)', 'Scaling optimizers (2025)', 'μP transfer notes'], ideas: IDEAS, running: 23 },
  { ask: '把研究笔记里反复出现的问题挑出来，能自动跑的就先跑。', question: '研究笔记中的开放问题，哪些可以转成可自动检验的实验？', metric: 'val_bpb', unit: '', baseline: 1.0045, scope: ['只选可量化的问题', '单次实验 ≤ 5 分钟', '保留人工复核'], papers: ['研究笔记 · 12 条', 'R—014 档案', 'P—013 观察记录'], ideas: IDEAS.slice(8).concat(IDEAS.slice(0, 8)), running: 0 },
];

/* ── Simulated auto-research loop ────────────────────────────────────── */
type Phase = 'propose' | 'edit' | 'train' | 'eval' | 'decide';
const PHASES: [Phase, string][] = [['propose', '提出'], ['edit', '改代码'], ['train', '训练'], ['eval', '评估'], ['decide', '取舍']];
type Exp = { n: number; idea: Idea; value: number; kept: boolean; delta: number };
type Event = { id: number; t: string; kind: 'propose' | 'edit' | 'run' | 'eval' | 'keep' | 'drop' | 'note'; text: string };
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(Math.floor(minutes % 60)).padStart(2, '0')}:00`;
const fmt = (v: number) => v.toFixed(4);

function nextExperiment(topic: Topic, done: Exp[], rand: () => number): Exp {
  const n = done.length + 1;
  const idea = topic.ideas[(n * 7 + Math.floor(rand() * 3)) % topic.ideas.length];
  const best = done.reduce((b, e) => e.kept ? Math.min(b, e.value) : b, topic.baseline);
  const tried = done.filter(e => e.idea === idea && e.kept).length;
  const value = best + idea.effect * (tried ? .25 : 1) * (.6 + rand() * .8) + (rand() - .5) * .0018;
  const kept = value < best - .0004;
  return { n, idea, value, kept, delta: value - best };
}

const BUDGET_DEFAULT = { gpu: 8, cap: 96, minutes: 5 };

export default function ResearchBench({ file, reduced }: BenchProps) {
  const topic = TOPICS[file];
  const rand = useRef(rng(97 + file * 13));
  const [stage, setStage] = useState<'brief' | 'budget' | 'running' | 'paused' | 'done'>(topic.running ? 'running' : 'brief');
  const [budget, setBudget] = useState(BUDGET_DEFAULT);
  const [speed, setSpeed] = useState(2);
  const [exps, setExps] = useState<Exp[]>(() => { const out: Exp[] = []; for (let i = 0; i < topic.running; i++) out.push(nextExperiment(topic, out, rand.current)); return out; });
  const [current, setCurrent] = useState<{ exp: Exp; phase: number; progress: number } | null>(null);
  const [events, setEvents] = useState<Event[]>(() => exps.slice(-6).reverse().map((e, i) => ({ id: -i - 1, t: clock(e.n * BUDGET_DEFAULT.minutes), kind: e.kept ? 'keep' : 'drop', text: `EXP-${String(e.n).padStart(3, '0')} ${e.kept ? '保留' : '丢弃'} · ${e.idea.title} · ${topic.metric} ${fmt(e.value)}` })));
  const [messages, setMessages] = useState<Msg[]>(() => opening(topic, topic.running > 0));
  const [busy, setBusy] = useState(false);
  const evId = useRef(1);
  const live = stage === 'running';

  const best = exps.reduce((b, e) => e.kept ? Math.min(b, e.value) : b, topic.baseline);
  const usedMinutes = exps.length * budget.minutes + (current ? current.progress * budget.minutes : 0);
  const gpuUsed = usedMinutes / 60;

  function push(kind: Event['kind'], text: string, n = exps.length + 1) { setEvents(list => [{ id: evId.current++, t: clock(n * budget.minutes), kind, text }, ...list].slice(0, 80)); }
  function say(text: Msg['text'], extra: Partial<Msg> = {}) { setMessages(m => [...m, { id: msgId(), who: 'ai', text, at: now(), ...extra }]); }

  // One experiment moves through its phases on a timer; speed scales the pace.
  // Side effects stay outside state updaters so a re-run never doubles them.
  const curRef = useRef(current);
  curRef.current = current;
  useEffect(() => {
    if (!live) return;
    if (exps.length >= budget.cap || gpuUsed >= budget.gpu) {
      setStage('done'); setCurrent(null);
      push('note', `预算用尽：共 ${exps.length} 次实验，最佳 ${topic.metric} ${fmt(best)}`);
      say(<p>预算已经用完。共跑了 <b>{exps.length}</b> 次实验，保留 <b>{exps.filter(e => e.kept).length}</b> 项改动，{topic.metric} 从 {fmt(topic.baseline)} 降到 <b>{fmt(best)}</b>。要不要我把保留的改动整理成一份结论草稿？</p>);
      return;
    }
    const id = window.setInterval(() => {
      const cur = curRef.current;
      if (!cur) {
        const exp = nextExperiment(topic, exps, rand.current);
        push('propose', `EXP-${String(exp.n).padStart(3, '0')} 提出：${exp.idea.title}（${CAT[exp.idea.cat]}）`, exp.n);
        const next = { exp, phase: 0, progress: 0 }; curRef.current = next; setCurrent(next); return;
      }
      const progress = Math.min(1, cur.progress + [.34, .3, .07, .3, .4][cur.phase] * speed);
      if (progress < 1) { const next = { ...cur, progress }; curRef.current = next; setCurrent(next); return; }
      const n = cur.exp.n, tag = `EXP-${String(n).padStart(3, '0')}`;
      if (cur.phase === 0) push('edit', `${tag} 修改 train.py：${cur.exp.idea.diff[1]}`, n);
      if (cur.phase === 1) push('run', `${tag} 开始训练 · ${budget.minutes} 分钟预算`, n);
      if (cur.phase === 2) push('eval', `${tag} 评估 ${topic.metric} = ${fmt(cur.exp.value)}`, n);
      if (cur.phase === 3) {
        push(cur.exp.kept ? 'keep' : 'drop', `${tag} ${cur.exp.kept ? '保留' : '丢弃'} · Δ ${cur.exp.delta >= 0 ? '+' : ''}${cur.exp.delta.toFixed(4)}`, n);
        if (cur.exp.kept) say(<p><b>{tag} 保留</b>：{cur.exp.idea.title}，{topic.metric} 降到 <b>{fmt(cur.exp.value)}</b>（{cur.exp.delta.toFixed(4)}）。</p>, { tools: [{ kind: 'run', label: 'python train.py --budget 5m', detail: `${topic.metric} ${fmt(cur.exp.value)}` }] });
      }
      if (cur.phase === 4) { curRef.current = null; setCurrent(null); setExps(list => [...list, cur.exp]); return; }
      const next = { ...cur, phase: cur.phase + 1, progress: 0 }; curRef.current = next; setCurrent(next);
    }, reduced ? 400 : 120);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, exps, speed, budget, reduced]);

  function onSend(text: string) {
    setMessages(m => [...m, { id: msgId(), who: 'me', text }]);
    setBusy(true);
    window.setTimeout(() => {
      setBusy(false);
      if (stage === 'brief') say(<p>我把这条补充写进研究简报的约束里：“{text}”。确认方向后就进入预算设定。</p>);
      else if (stage === 'budget') say(<p>收到。预算卡片里的数值可以直接拖动，确认后我再启动。</p>);
      else say(<p>已记下这条指示，下一轮提出改动时会参考：“{text}”。<br /><span className="rs-muted">（本地预演：不会真正改变实验走向。）</span></p>);
    }, reduced ? 0 : 700);
  }
  function confirmBrief() {
    setStage('budget');
    setMessages(m => [...m, { id: msgId(), who: 'me', text: '方向确认。' }, { id: msgId(), who: 'ai', at: now(), text: <p>好。最后设定预算：GPU 时数决定能跑多久，实验上限防止无效重复。单次时长固定，保证每次结果可比。</p>, kind: 'budget' }]);
  }
  function start() {
    setStage('running');
    setMessages(m => [...m, { id: msgId(), who: 'sys', text: `AUTO RESEARCH 启动 · ${budget.gpu} GPU 时 · 上限 ${budget.cap} 次 · 模拟运行` }]);
    push('note', `开始自动研究：基线 ${topic.metric} ${fmt(topic.baseline)}`, 0);
  }
  const kept = exps.filter(e => e.kept);
  const findings = useMemo(() => {
    const out: string[] = [];
    (Object.keys(CAT) as Cat[]).forEach(c => { const tried = exps.filter(e => e.idea.cat === c); if (tried.length >= 2) out.push(`${CAT[c]}类改动：保留 ${tried.filter(e => e.kept).length} / ${tried.length}`); });
    if (kept.length) { const top = [...kept].sort((a, b) => a.delta - b.delta)[0]; out.unshift(`单项收益最大：${top.idea.title}（${top.delta.toFixed(4)}）`); }
    return out;
  }, [exps, kept]);

  return <div className="rs">
    <Chat className="rs-chat" title="研究对话" agent="RESEARCH LEAD" messages={messages.map(m => m.kind === 'budget' ? { ...m, card: <BudgetEditor budget={budget} setBudget={setBudget} editable={stage === 'budget'} onStart={start} /> } : m.kind === 'brief' ? { ...m, card: <BriefCard topic={topic} confirmed={stage !== 'brief'} onConfirm={confirmBrief} /> } : m)} onSend={onSend} busy={busy}
      suggestions={stage === 'brief' ? ['把评测集也锁定', '优先尝试调度类改动'] : live ? ['先别动优化器', '多试几个结构改动'] : []} placeholder={stage === 'brief' ? '补充方向、约束或你的猜想' : '给研究负责人一条指示'} />

    <section className="rs-main">
      {stage === 'brief' || stage === 'budget' ? <Plan topic={topic} stage={stage} budget={budget} /> : <>
        <div className="rs-status">
          <span className="rs-state" data-state={stage}><i />{stage === 'running' ? 'AUTO RESEARCH · 运行中' : stage === 'paused' ? '已暂停' : '已完成'}</span>
          <span><small>模拟时间</small><b className="mono">{clock(usedMinutes)}</b></span>
          <span><small>实验</small><b className="num">{exps.length}</b></span>
          <span><small>最佳 {topic.metric}</small><b className="num">{fmt(best)}</b></span>
          <span><small>相对基线</small><b className="num rs-gain">{(best - topic.baseline).toFixed(4)}</b></span>
          <span className="rs-status-tools">
            <span className="seg" aria-label="速度">{[1, 2, 4].map(v => <button key={v} aria-pressed={speed === v} onClick={() => setSpeed(v)}>{v}×</button>)}</span>
            {stage !== 'done' && <button className="b" onClick={() => setStage(s => s === 'running' ? 'paused' : 'running')}>{stage === 'running' ? '暂停' : '继续'}</button>}
            <span className="chip sim">模拟</span>
          </span>
        </div>
        <MetricChart exps={exps} current={current?.exp ?? null} baseline={topic.baseline} metric={topic.metric} />
        <div className="rs-lower">
          <Current topic={topic} current={current} minutes={budget.minutes} />
          <section className="p rs-stream">
            <header className="p-h"><b>行为流</b><span>AGENT ACTIVITY</span></header>
            <ol className="p-body scroll-thin">{events.map(e => <li key={e.id} data-kind={e.kind}><time className="mono">{e.t}</time><i /><span>{e.text}</span></li>)}</ol>
          </section>
        </div>
      </>}
    </section>

    <aside className="rs-side">
      <section className="p rs-budget">
        <header className="p-h"><b>预算</b><span>BUDGET</span></header>
        <div className="rs-budget-body">
          <div><span>GPU 时</span><b className="num">{gpuUsed.toFixed(1)}<small> / {budget.gpu}h</small></b><div className="bar-meter"><i className="gold" style={{ width: `${Math.min(100, gpuUsed / budget.gpu * 100)}%` }} /></div></div>
          <div><span>实验次数</span><b className="num">{exps.length}<small> / {budget.cap}</small></b><div className="bar-meter"><i style={{ width: `${Math.min(100, exps.length / budget.cap * 100)}%` }} /></div></div>
          <dl className="kv"><dt>单次</dt><dd>{budget.minutes} 分钟 · 固定</dd><dt>剩余</dt><dd>约 {Math.max(0, Math.min(budget.cap - exps.length, Math.floor((budget.gpu * 60 - usedMinutes) / budget.minutes)))} 次</dd></dl>
        </div>
      </section>
      <section className="p rs-kept">
        <header className="p-h"><b>保留的改动</b><span>{String(kept.length).padStart(2, '0')}</span></header>
        <ol className="p-body scroll-thin">{kept.length ? [...kept].sort((a, b) => a.delta - b.delta).map((e, i) => <li key={e.n}><em className="num">{String(i + 1).padStart(2, '0')}</em><div><b>{e.idea.title}</b><small className="mono">EXP-{String(e.n).padStart(3, '0')} · {CAT[e.idea.cat]}</small></div><span className="num">{e.delta.toFixed(4)}</span></li>) : <li className="rs-empty">启动后，被保留的改动会按收益排在这里。</li>}</ol>
      </section>
      <section className="p rs-find">
        <header className="p-h"><b>阶段发现</b><span>按记录统计</span></header>
        <ul>{findings.length ? findings.map(f => <li key={f}>{f}</li>) : <li className="rs-empty">实验积累后自动汇总。</li>}</ul>
        <div className="rs-papers"><span>参考</span>{topic.papers.map(p => <i key={p}>{p}</i>)}</div>
      </section>
    </aside>
  </div>;
}

function opening(topic: Topic, running: boolean): Msg[] {
  const base: Msg[] = [
    { id: msgId(), who: 'me', text: topic.ask },
    { id: msgId(), who: 'ai', at: '09:12', tools: [{ kind: 'search', label: '文献检索 · 3 篇相关', detail: '0.8s' }, { kind: 'read', label: 'notes/研究笔记.md' }, { kind: 'read', label: 'train.py · model.py' }],
      text: <p>我把方向收成一个可以自动迭代的问题。下面是研究简报，请确认，或者直接告诉我要改哪里。</p>, kind: 'brief' },
  ];
  if (!running) return base;
  return [...base, { id: msgId(), who: 'me', text: '方向确认。' }, { id: msgId(), who: 'ai', at: '09:14', text: <p>预算：8 GPU 时，上限 96 次，每次 5 分钟。</p> }, { id: msgId(), who: 'sys', text: 'AUTO RESEARCH 启动 · 模拟运行' }];
}

function BudgetEditor({ budget, setBudget, editable, onStart }: { budget: typeof BUDGET_DEFAULT; setBudget: (fn: (b: typeof BUDGET_DEFAULT) => typeof BUDGET_DEFAULT) => void; editable: boolean; onStart: () => void }) {
  const est = Math.min(budget.cap, Math.floor(budget.gpu * 60 / budget.minutes));
  return <div className="chat-card rs-budget-card">
    <div className="chat-card-h"><b>预算</b><span>BUDGET</span></div>
    <label><span>GPU 时</span><input type="range" min={2} max={24} value={budget.gpu} disabled={!editable} onChange={e => setBudget(b => ({ ...b, gpu: +e.target.value }))} /><b className="num">{budget.gpu}h</b></label>
    <label><span>实验上限</span><input type="range" min={20} max={200} step={4} value={budget.cap} disabled={!editable} onChange={e => setBudget(b => ({ ...b, cap: +e.target.value }))} /><b className="num">{budget.cap}</b></label>
    <div className="rs-budget-row"><span>单次时长</span><span className="seg">{[2, 5, 10].map(v => <button key={v} type="button" disabled={!editable} aria-pressed={budget.minutes === v} onClick={() => setBudget(b => ({ ...b, minutes: v }))}>{v} 分</button>)}</span></div>
    <p>约可完成 <b>{est}</b> 次实验，墙钟约 <b>{(est * budget.minutes / 60).toFixed(1)}</b> 小时。</p>
    <button className="b solid" disabled={!editable} onClick={onStart}>{editable ? '按此预算启动' : '已启动'}</button>
  </div>;
}

function BriefCard({ topic, confirmed, onConfirm }: { topic: Topic; confirmed: boolean; onConfirm: () => void }) {
  return <div className="chat-card rs-brief-card">
    <div className="chat-card-h"><b>研究简报</b><span>BRIEF</span></div>
    <p className="rs-q">{topic.question}</p>
    <dl className="kv"><dt>指标</dt><dd className="mono">{topic.metric} · 越低越好</dd><dt>基线</dt><dd className="mono">{topic.baseline.toFixed(4)}</dd><dt>约束</dt><dd>{topic.scope.join('；')}</dd></dl>
    <button className="b solid" disabled={confirmed} onClick={onConfirm}>{confirmed ? '已确认' : '确认方向'}</button>
  </div>;
}

function Plan({ topic, stage, budget }: { topic: Topic; stage: string; budget: typeof BUDGET_DEFAULT }) {
  return <div className="rs-plan">
    <div className="rs-plan-head"><span className="chip ink">PLAN</span><span>{stage === 'brief' ? '等待确认方向' : '等待确认预算'}</span></div>
    <h2>{topic.question}</h2>
    <div className="rs-loop" aria-label="自动研究循环">
      {PHASES.map(([, name], i) => <div key={name} className="rs-loop-step"><em className="num">{String(i + 1).padStart(2, '0')}</em><b>{name}</b><small>{['从文献与历史结果提出一个改动', '只改允许的文件，留下 diff', `固定 ${budget.minutes} 分钟训练`, `计算 ${topic.metric}`, '优于当前最佳则保留，否则回滚'][i]}</small></div>)}
      <div className="rs-loop-back">↺ 循环直到预算用尽</div>
    </div>
    <div className="rs-plan-grid">
      <div><span>范围</span><ul>{topic.scope.map(s => <li key={s}>{s}</li>)}</ul></div>
      <div><span>候选方向</span><ul>{topic.ideas.slice(0, 5).map(i => <li key={i.title}>{i.title}<small>{CAT[i.cat]}</small></li>)}</ul></div>
      <div><span>参考</span><ul>{topic.papers.map(p => <li key={p}>{p}</li>)}</ul></div>
    </div>
    <p className="rs-plan-note">确认方向和预算都在左侧对话里完成。启动后，这里会切换为实时的实验轨迹。</p>
  </div>;
}

function MetricChart({ exps, current, baseline, metric }: { exps: Exp[]; current: Exp | null; baseline: number; metric: string }) {
  const W = 760, H = 210, pad = { l: 46, r: 16, t: 14, b: 24 };
  const n = Math.max(30, exps.length + 6);
  const values = exps.map(e => e.value).concat(baseline);
  const lo = Math.min(...values) - .002, hi = Math.max(...values) + .001;
  const x = (i: number) => pad.l + (i / n) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + ((hi - v) / (hi - lo)) * (H - pad.t - pad.b);
  let best = baseline; const steps: string[] = [`M ${x(0)} ${y(baseline)}`];
  exps.forEach(e => { if (e.kept) { steps.push(`H ${x(e.n)} V ${y(e.value)}`); best = e.value; } });
  steps.push(`H ${x(exps.length + (current ? 1 : 0))}`);
  const ticks = [lo + .001, (lo + hi) / 2, hi - .0005];
  return <section className="p rs-chart">
    <header className="p-h"><b>指标轨迹</b><span>{metric} · 越低越好</span><span className="rs-legend"><i className="k" />保留<i className="d" />丢弃<i className="l" />当前最佳</span></header>
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${metric} 随实验变化，当前最佳 ${best.toFixed(4)}`}>
      {ticks.map(t => <g key={t}><line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="grid" /><text x={pad.l - 6} y={y(t) + 3} textAnchor="end">{t.toFixed(3)}</text></g>)}
      <line x1={pad.l} x2={W - pad.r} y1={y(baseline)} y2={y(baseline)} className="base" /><text x={W - pad.r} y={y(baseline) - 4} textAnchor="end" className="base-t">基线</text>
      <path d={steps.join(' ')} className="best" />
      {exps.map(e => <circle key={e.n} cx={x(e.n)} cy={y(e.value)} r={e.kept ? 3.6 : 2.4} className={e.kept ? 'kept' : 'drop'} />)}
      {current && <g className="now"><line x1={x(current.n)} x2={x(current.n)} y1={pad.t} y2={H - pad.b} /><text x={x(current.n) + 4} y={pad.t + 8}>EXP-{String(current.n).padStart(3, '0')}</text></g>}
      {[0, 10, 20, 30, 40, 50, 60, 70, 80, 90].filter(v => v <= n).map(v => <text key={v} x={x(v)} y={H - 6} textAnchor="middle">{v}</text>)}
    </svg>
  </section>;
}

function Current({ topic, current, minutes }: { topic: Topic; current: { exp: Exp; phase: number; progress: number } | null; minutes: number }) {
  if (!current) return <section className="p rs-current"><header className="p-h"><b>当前实验</b><span>—</span></header><p className="rs-empty rs-current-idle">等待下一次实验…</p></section>;
  const { exp, phase, progress } = current;
  const loss = Array.from({ length: 40 }, (_, i) => { const t = i / 39; return 1 - Math.log1p(t * 9) / Math.log(10) * .78 + Math.sin(i * 1.7) * .012; });
  const shown = phase > 2 ? 40 : phase === 2 ? Math.max(2, Math.round(progress * 40)) : 0;
  const pts = loss.slice(0, shown).map((v, i) => `${(i / 39) * 240},${8 + v * 56}`).join(' ');
  return <section className="p rs-current">
    <header className="p-h"><b>当前实验</b><span className="mono">EXP-{String(exp.n).padStart(3, '0')} · {CAT[exp.idea.cat]}</span></header>
    <div className="rs-current-body">
      <h3>{exp.idea.title}</h3>
      <ol className="rs-phases">{PHASES.map(([key, name], i) => <li key={key} data-state={i < phase ? 'done' : i === phase ? 'now' : 'next'}><i style={i === phase ? { width: `${progress * 100}%` } : undefined} /><span>{name}</span></li>)}</ol>
      <pre className="rs-diff mono"><span className="del">- {exp.idea.diff[0]}</span><span className="add">+ {exp.idea.diff[1]}</span></pre>
      <div className="rs-train">
        <svg viewBox="0 0 240 72" aria-hidden="true"><polyline points={pts} /></svg>
        <dl className="kv"><dt>训练</dt><dd className="mono">{phase > 2 ? `${minutes}:00` : phase === 2 ? `${Math.floor(progress * minutes)}:${String(Math.floor((progress * minutes * 60) % 60)).padStart(2, '0')}` : '—'} / {minutes}:00</dd>
          <dt>{topic.metric}</dt><dd className="mono">{phase > 2 ? exp.value.toFixed(4) : '…'}</dd>
          <dt>结果</dt><dd>{phase >= 4 ? <b className={exp.kept ? 'rs-k' : 'rs-d'}>{exp.kept ? '保留' : '丢弃并回滚'}</b> : '—'}</dd></dl>
      </div>
    </div>
  </section>;
}
