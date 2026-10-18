import { useEffect, useRef, useState, type ReactNode } from 'react';
import BenchFrame from '../../BenchFrame';
import { scrollWithin } from '../../scrollWithin';
import AgentDock, { type DockDraft, type DockEvent, type Suggestion } from '../../AgentDock';
import Explorer, { Tree, type ExplorerSection, type ExplorerView } from '../../engineering/Explorer';
import { Mobius } from '../../../rhine/RhineMark';
import type { BenchChrome } from '../../WorkbenchStudio';
import { CLAIMS, LAYERS, PAPER, QA, QUIZ, REPRO_CODE } from './paper';
import { MultiHead, PositionalEncoding, ScaledAttention } from './Anims';
import './read.css';

// 研究台 · 精读模式：目标是「搞懂」一篇论文。
// 01 解析（一句话 → 直觉 → 机理 → 证据 → 洞见，每层链接回原文）· 02 动画（可交互的解释）· 03 复现（最小复现 vs 论文结论）· 04 检验（出题、作答、指出偏差）。
// 任何洞见或疑问都可以一键「派给群研」，复现不了的结论可以「交给自研」。全部为前端示例与本地计算。

type Face = 'explain' | 'lab' | 'repro' | 'check';
type Anim = 'scaled' | 'pe' | 'heads';
const ANIMS: { id: Anim; title: string; en: string; ref: string }[] = [
  { id: 'scaled', title: '为什么要除以 √d', en: 'SCALED DOT-PRODUCT', ref: 's321' },
  { id: 'pe', title: '位置编码', en: 'POSITIONAL ENCODING', ref: 's35' },
  { id: 'heads', title: '多头注意力', en: 'MULTI-HEAD', ref: 's322' },
];
const clock = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
let seq = 0; const uid = () => `p${++seq}`;

export default function ReadMode({ file, reduced, chrome, modeSwitch, onDispatch }: {
  file: number; reduced: boolean; chrome: BenchChrome; modeSwitch: ReactNode; onDispatch: (to: 'swarm' | 'auto', text: string) => void;
}) {
  const [face, setFace] = useState<Face>('explain');
  const [depth, setDepth] = useState(3);                 // 展开到第几层
  const [focus, setFocus] = useState<string[]>([]);      // 当前高亮的原文段落
  const [ping, setPing] = useState(0);
  const [anim, setAnim] = useState<Anim>('scaled');
  const [understood, setUnderstood] = useState<Record<string, 'ok' | 'part' | 'miss'>>({});
  const [ran, setRan] = useState<'idle' | 'running' | 'done'>('idle');
  const [busy, setBusy] = useState(false);
  const [events, setEvents] = useState<DockEvent[]>(() => [{ id: uid(), kind: 'agent', at: clock(), text: <p>我读完了《{PAPER.title}》。左边是原文目录，中间是五层解析，从一句话开始。有任何地方没懂，直接问我，比如「为什么要除以根号 d」。</p> }]);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = (ms: number, fn: () => void) => { timers.current.push(window.setTimeout(fn, reduced ? 40 : ms)); };
  const push = (e: DockDraft) => { const id = e.id ?? uid(); setEvents(l => [...l, { ...e, id } as DockEvent]); return id; };
  const say = (text: ReactNode) => push({ kind: 'agent', text, at: clock() });
  const cite = (refs: string[]) => { setFocus(refs); setPing(Date.now()); };
  const openAnim = (a: Anim) => { setAnim(a); setFace('lab'); };

  const ask = (text: string) => {
    push({ kind: 'user', text, at: clock() });
    setBusy(true);
    later(700, () => {
      setBusy(false);
      const hit = QA.find(x => x.keys.test(text));
      if (!hit) { say(<p>这个问题论文里没有直接回答。要不要<b className="ad-ref" onClick={() => dispatch('swarm', text)}>派给群研</b>去查后续工作？</p>); return; }
      if (hit.refs) cite(hit.refs);
      say(<><p>{hit.answer}</p><p>{hit.refs?.map(r => <b key={r} className="ad-ref" onClick={() => { setFace('explain'); cite([r]); }}>{PAPER.sections.find(s => s.id === r)?.no}</b>)}{hit.anim && <> · <b className="ad-ref" onClick={() => openAnim(hit.anim as Anim)}>打开动画</b></>}</p></>);
      if (hit.anim) openAnim(hit.anim as Anim);
    });
  };
  const dispatch = (to: 'swarm' | 'auto', text: string) => {
    push({ kind: 'tool', action: to === 'swarm' ? 'dispatch_swarm' : 'dispatch_auto', label: to === 'swarm' ? `派给群研：${text}` : `交给自研：${text}`, state: 'done', ms: 120 });
    later(300, () => onDispatch(to, text));
  };
  const runRepro = () => {
    if (ran === 'running') return;
    setRan('running');
    const t = push({ kind: 'tool', action: 'repro_run', label: '最小复现 · 2 层 4 头 d=64 · 反转任务', state: 'running' });
    later(2600, () => { setRan('done'); setEvents(l => l.map(e => e.id === t ? { ...e, state: 'done', ms: 2600, detail: '3 / 4 条结论已复现' } as DockEvent : e)); say(<p>最小复现跑完：3 条机理层面的结论都对上了；翻译 BLEU 需要完整规模，可以<b className="ad-ref" onClick={() => dispatch('auto', 'WMT14 英德 BLEU 复现')}>交给自研</b>排期。</p>); });
  };

  const okCount = Object.values(understood).filter(v => v === 'ok').length;
  const suggestions: Suggestion[] = face === 'lab' ? [
    { id: 'a', label: '为什么要除以根号 d？', onClick: () => ask('为什么要除以根号 d？') },
    { id: 'b', label: '位置编码怎么表达顺序？', onClick: () => ask('位置编码怎么表达顺序？') },
  ] : [
    { id: 'q', label: 'Q、K、V 分别是什么？', onClick: () => ask('Q、K、V 分别是什么？') },
    { id: 'f', label: '为什么它比循环网络快？', onClick: () => ask('为什么它比循环网络快？') },
    { id: 's', label: '派给群研：后来怎么解决长文本？', onClick: () => dispatch('swarm', '注意力计算量随长度平方增长，后续工作如何解决长文本？') },
  ];

  const sections: ExplorerSection[] = [
    { id: 'paper', title: PAPER.title, grow: true, body: <Tree nodes={PAPER.sections.map(s => ({ name: s.title, path: s.id, ext: '§', meta: <span className="rd-xp-meta">{s.no}</span> }))} active={focus[0]} onOpen={id => { setFace('explain'); cite([id]); }} /> },
    { id: 'meta', title: '信息', body: <div className="dv-xp-list"><div><b>{PAPER.authors}</b><small>{PAPER.venue}</small></div><div><b>代码</b><small>{PAPER.code} · 有</small></div></div> },
    { id: 'figs', title: '动画', count: ANIMS.length, body: <Tree nodes={ANIMS.map(a => ({ name: a.title, path: a.id, ext: '▶', meta: <span className="rd-xp-meta">{PAPER.sections.find(s => s.id === a.ref)?.no}</span> }))} active={face === 'lab' ? anim : undefined} onOpen={id => openAnim(id as Anim)} /> },
  ];
  const [xpOpen, setXpOpen] = useState(true), [xpView, setXpView] = useState<ExplorerView>('files');
  const dock = <AgentDock name="精读助手" target={`${PAPER.title} · ${PAPER.venue}`} plan={{ stages: ['解析', '动画', '复现', '检验'], current: ['explain', 'lab', 'repro', 'check'].indexOf(face) }}
    suggestions={suggestions} events={events} busy={busy} onSend={ask} placeholder="哪里没懂？例如：为什么要除以根号 d" />;

  return <BenchFrame code="RSCH" section="002" file={file} reduced={reduced} chrome={chrome} face={face} onFace={id => setFace(id as Face)}
    faces={[{ id: 'explain', label: '解析', en: 'EXPLAIN' }, { id: 'lab', label: '动画', en: 'LAB' }, { id: 'repro', label: '复现', en: 'REPRODUCE', badge: ran === 'done' ? 3 : 0 }, { id: 'check', label: '检验', en: 'CHECK', badge: okCount }]}
    strip={<>READ <i>·</i> {PAPER.venue} <i>·</i> 理解 {okCount}/{QUIZ.length}</>} tools={modeSwitch}
    shutterLines={f => [`> open paper · ${PAPER.title.toLowerCase()}`, `> face · ${f.en.toLowerCase()}`, '> ready']}
    status={<><span><i className="en-sq" />精读</span><span>{PAPER.title}</span><span>解析 {depth}/5 层</span><span>理解 {okCount}/{QUIZ.length}</span><span>示例数据 · 不连接模型</span></>}>
    <div className="rd rh">
      <Explorer code="RSCH" open={xpOpen} view={xpView} onView={setXpView} onToggle={() => setXpOpen(v => !v)} title={PAPER.venue} sections={sections} />
      <section className="rd-center" data-wb-panel>
        {face === 'explain' ? <Explain depth={depth} setDepth={setDepth} focus={focus} ping={ping} cite={cite} openAnim={openAnim} dispatch={dispatch} />
          : face === 'lab' ? <Lab anim={anim} setAnim={setAnim} dispatch={dispatch} />
          : face === 'repro' ? <Repro ran={ran} onRun={runRepro} dispatch={dispatch} />
          : <Check understood={understood} setUnderstood={setUnderstood} onLayer={l => { setFace('explain'); const L = LAYERS.find(x => x.id === l)!; setDepth(Math.max(depth, LAYERS.indexOf(L) + 1)); cite(L.body.flatMap(b => b.refs)); }} />}
      </section>
      {dock}
    </div>
  </BenchFrame>;
}

/* ———— 01 解析 ———— */
function Explain({ depth, setDepth, focus, ping, cite, openAnim, dispatch }: { depth: number; setDepth: (n: number) => void; focus: string[]; ping: number; cite: (r: string[]) => void; openAnim: (a: Anim) => void; dispatch: (to: 'swarm' | 'auto', t: string) => void }) {
  const src = useRef<HTMLDivElement>(null);
  useEffect(() => { if (focus[0]) scrollWithin(src.current?.querySelector(`[data-sec="${focus[0]}"]`), 'center'); }, [focus, ping]);
  return <div className="rd-explain">
    <div className="rd-layers">
      <header className="rd-paper-head"><span className="rh-micro">{PAPER.venue} · {PAPER.authors}</span><h1>{PAPER.title}</h1>
        <div className="rd-depth" role="group" aria-label="解析深度">{LAYERS.map((l, i) => <button key={l.id} aria-pressed={i < depth} data-now={i === depth - 1 || undefined} onClick={() => setDepth(i + 1)}><b>{l.no}</b>{l.title}</button>)}</div></header>
      {LAYERS.slice(0, depth).map((l, i) => <article key={l.id} className="rd-layer" style={{ animationDelay: `${i * 60}ms` }}>
        <header><span className="rd-layer-no">{l.no}</span><span><b>{l.title}</b><small>{l.en}</small></span>{l.anim && <button className="rh-btn" onClick={() => openAnim(l.anim as Anim)}>▶ 看动画</button>}</header>
        {l.body.map((b, k) => <div key={k} className="rd-para" onMouseEnter={() => cite(b.refs)}>
          <p>{b.text}</p>
          <span className="rd-refs">{b.refs.map(r => <button key={r} onClick={() => cite([r])}>{PAPER.sections.find(s => s.id === r)?.no}</button>)}
            {l.id === 'l5' && k === 2 && <button className="rd-dispatch" onClick={() => dispatch('swarm', '注意力计算量随长度平方增长，后续工作如何解决长文本？')}>派给群研 →</button>}</span>
        </div>)}
      </article>)}
      {depth < 5 && <button className="rd-deeper" onClick={() => setDepth(depth + 1)}><span>更深一层</span><b>{LAYERS[depth].no} · {LAYERS[depth].title}</b><i>↓</i></button>}
    </div>
    <aside className="rd-source" ref={src}>
      <header><span className="rh-ph-no">原</span><b>原文</b><small>转述 · 悬停解析段落，对应原文亮起</small></header>
      {PAPER.sections.map(s => <section key={s.id} data-sec={s.id} data-on={focus.includes(s.id) || undefined}>
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
function Check({ understood, setUnderstood, onLayer }: { understood: Record<string, 'ok' | 'part' | 'miss'>; setUnderstood: (f: (u: Record<string, 'ok' | 'part' | 'miss'>) => Record<string, 'ok' | 'part' | 'miss'>) => void; onLayer: (l: string) => void }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const grade = (id: string) => {
    const q = QUIZ.find(x => x.id === id)!, a = drafts[id] ?? '';
    const hit = q.keys.filter(group => group.some(k => a.toLowerCase().includes(k.toLowerCase()))).length;
    setUnderstood(u => ({ ...u, [id]: hit === q.keys.length ? 'ok' : hit ? 'part' : 'miss' }));
  };
  const ok = Object.values(understood).filter(v => v === 'ok').length;
  return <div className="rd-check">
    <header className="rd-check-head"><span className="rh-micro">CHECK · 用你自己的话回答</span><h2>你真的懂了吗？</h2>
      <div className="rd-score"><b>{String(ok).padStart(2, '0')}</b><i>/</i><em>{String(QUIZ.length).padStart(2, '0')}</em><small>完全答对</small></div></header>
    {QUIZ.map((q, i) => { const s = understood[q.id]; return <article key={q.id} className="rd-q" data-s={s}>
      <header><em>Q{i + 1}</em><b>{q.q}</b>{s && <i>{s === 'ok' ? '理解到位' : s === 'part' ? '答到一半' : '还没抓住'}</i>}</header>
      <textarea value={drafts[q.id] ?? ''} onChange={e => setDrafts(d => ({ ...d, [q.id]: e.target.value }))} placeholder="用一两句大白话写下你的理解…" rows={2} />
      <div className="rd-q-act"><button className="rh-btn is-solid" onClick={() => grade(q.id)} disabled={!(drafts[q.id] ?? '').trim()}>提交</button>
        {s && s !== 'ok' && <span className="rd-hint">■ {q.hint} <button className="ts-link" onClick={() => onLayer(q.layer)}>回到解析</button></span>}
        {s === 'ok' && <span className="rd-good">抓住了要点。</span>}</div>
    </article>; })}
  </div>;
}
