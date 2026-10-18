import { useEffect, useRef, useState, type ReactNode } from 'react';
import BenchFrame from '../BenchFrame';
import AgentDock, { type DockDraft, type DockEvent } from '../AgentDock';
import Explorer, { type ExplorerSection, type ExplorerViewDef } from '../engineering/Explorer';
import type { BenchProps } from '../WorkbenchStudio';
import { scrollWithin } from '../scrollWithin';
import { draftRoutine, FILES, INCIDENTS, ROUTINES, STAGES, STATE_LABEL, type Amb, type Routine, type Run, type Step } from './model';
import ComposeFace, { interpret } from './ComposeFace';
import RunsFace from './RunsFace';
import MaintainFace from './MaintainFace';
import GraphFace from './graph/GraphFace';
import Art from './graph/Art';
import { buildFromText, DEF, execOrder, MODELS, MODEL_KIND, WORKFLOWS, type GNode, type ModelKind, type Output, type Workflow } from './graph/graphModel';
import { installed, useGraphRunner } from './graph/useGraphRunner';
import '../engineering/dev.css';
import './automation.css';

// 自动化台 AUTO：参照 Agent 例程（Claude Code routines / ChatGPT Tasks）——一条例程是一段自然语言指令，Agent 每次照着自己执行。
// 01 编排：例程书（指令 / 触发 / 工具权限 / 产出与预算 / 版本）+ AI 的解读与预演；一句话新建例程。
// 02 节点：照 ComfyUI + ComfyUI-Workspace-Manager 的节点图与工作区；节点图可以发布为工具，例程用 @工具名 调用。
// 03 运行：近 14 天运行矩阵 + 逐步记录；写入停在「等你确认」。
// 04 维护：维护 Agent 走完 诊断 → 修复 → 沙盒重放 → 人审上线。全部为前端示例。

type Face = 'compose' | 'graph' | 'runs' | 'maintain';
type IncState = { stage: number; approved: boolean | null };
const clock = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
let seq = 0; const uid = () => `a${++seq}`;
const HOUR = 9.6; // 示例里「现在」是上午 09:36
const hhmm = (h: number) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
const setLast = (h: string, c: string) => h.slice(0, -1) + c;

const VIEWS: ExplorerViewDef[] = [
  { id: 'list', label: '例程', icon: <svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10" /><circle cx="19" cy="18" r="2" /></svg> },
  { id: 'connect', label: '连接器', icon: <svg viewBox="0 0 24 24"><path d="M9 3v5M15 3v5M7 8h10v4a5 5 0 0 1-10 0zM12 17v4" /></svg> },
];
const GVIEWS: ExplorerViewDef[] = [
  { id: 'flows', label: '工作流', icon: <svg viewBox="0 0 24 24"><rect x="3" y="4" width="7" height="6" /><rect x="14" y="14" width="7" height="6" /><path d="M10 7h4v7" /></svg> },
  { id: 'models', label: '模型', icon: <svg viewBox="0 0 24 24"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" /></svg> },
  { id: 'gallery', label: '画廊', icon: <svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" /><path d="M3 16l5-5 4 4 3-3 6 6" /><circle cx="16" cy="9" r="1.5" /></svg> },
];
const CONNECTORS: [string, string, string][] = [['arXiv RSS', '6 个分类', 'on'], ['~/Inbox', '本地文件夹 · 只读', 'on'], ['研究档案', 'R—014 · 读写', 'on'], ['runs 表', 'PostgreSQL · 只读账号', 'on'], ['创作台事件', 'creative.*', 'on'], ['相册', '每次询问', 'ask'], ['邮箱', '未连接', 'off'], ['GitHub', '未连接', 'off']];

export default function AutomationStudio({ file, reduced, chrome }: BenchProps) {
  const [face, setFace] = useState<Face>('compose');
  const [routines, setRoutines] = useState<Routine[]>(() => JSON.parse(JSON.stringify(ROUTINES)));
  const [sel, setSel] = useState(() => ROUTINES.find(r => r.file === file)!.id);
  const [runSel, setRunSel] = useState<string | null>(null);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [typing, setTyping] = useState<number | null>(null);
  const [preview, setPreview] = useState<{ id: string; at: number; done: boolean } | null>(null);
  const [live, setLive] = useState<string | null>(null);
  const [inc, setInc] = useState<Record<string, IncState>>(() => Object.fromEntries(INCIDENTS.map(i => [i.id, { stage: i.stage, approved: null }])));
  const [incSel, setIncSel] = useState(() => (INCIDENTS.find(i => ROUTINES.find(r => r.id === i.routine)!.file === file) ?? INCIDENTS[0]).id);
  const [working, setWorking] = useState<number | null>(null);
  const [replayN, setReplayN] = useState(0), [regressN, setRegressN] = useState(0);
  const [busy, setBusy] = useState(false);
  const [xpOpen, setXpOpen] = useState(true), [xpView, setXpView] = useState('list');
  const [newMode, setNewMode] = useState(false);
  const firstWf = file === 2 ? 'WFG-03' : 'WFG-01';
  const [workflows, setWorkflows] = useState<Workflow[]>(() => JSON.parse(JSON.stringify(WORKFLOWS)));
  const [tabs, setTabs] = useState<string[]>(() => [firstWf]);
  const [gsel, setGsel] = useState(firstWf);
  const [gView, setGView] = useState('flows');
  const [dockOpen, setDockOpen] = useState(false);
  const [gNew, setGNew] = useState(false);
  const [fitKey, setFitKey] = useState(0);
  const [lightbox, setLightbox] = useState<Output | null>(null);
  const [installing, setInstalling] = useState<Record<string, number>>({});
  const [ev, setEv] = useState<Record<Face, DockEvent[]>>(() => ({
    compose: [{ id: uid(), kind: 'agent', at: clock(), text: <p>我是例程助手。每条例程就是一段话：写清楚做什么、什么时候做、哪些事要先问你。我会把指令拆成步骤给你看，说不清的地方用橙色虚线标出来。想新建一条，直接用一句话告诉我。</p> }],
    graph: [{ id: uid(), kind: 'agent', at: clock(), text: <p>我是节点助手。这里照 ComfyUI 搭节点图：双击空白处搜索加节点，从输出插槽拖线到同色的输入。搭好的图可以「发布为工具」，例程里写 @工具名 就能调用。也可以直接说「搭一张……」。</p> }],
    runs: [{ id: uid(), kind: 'agent', at: clock(), text: <p>这里是每次运行的完整记录：Agent 每一步想了什么、调了哪个工具、输入输出是什么。要写入的步骤会停下来等你确认。</p> }],
    maintain: [{ id: uid(), kind: 'agent', at: clock(), text: <p>我是维护 Agent。有 {INCIDENTS.length} 个故障待处理。我会按「诊断 → 修复 → 沙盒重放 → 人审上线」走，最后一步只有你能批准。</p> }],
  }));
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = (ms: number, fn: () => void) => { timers.current.push(window.setTimeout(fn, reduced ? 30 : ms)); };
  const faceRef = useRef(face); faceRef.current = face;
  const push = (e: DockDraft, f: Face = faceRef.current) => { const id = e.id ?? uid(); setEv(m => ({ ...m, [f]: [...m[f], { ...e, id } as DockEvent] })); return id; };
  const patch = (id: string, p: Partial<DockEvent>) => setEv(m => Object.fromEntries(Object.entries(m).map(([k, l]) => [k, l.map(e => e.id === id ? { ...e, ...p } as DockEvent : e)])) as Record<Face, DockEvent[]>);
  const say = (text: ReactNode, f?: Face) => push({ kind: 'agent', text, at: clock() }, f);

  const r = routines.find(x => x.id === sel) ?? routines[0];
  const upd = (id: string, f: (r: Routine) => Routine) => setRoutines(l => l.map(x => x.id === id ? f(x) : x));
  const run = r.runs.find(x => x.id === runSel) ?? r.runs[0];
  const pick = (id: string) => { setSel(id); setRunSel(null); setPreview(null); };
  const curInc = INCIDENTS.find(i => i.id === incSel)!, incSt = inc[curInc.id], incR = routines.find(x => x.id === curInc.routine)!;
  const openIncs = INCIDENTS.filter(i => inc[i.id].approved === null);
  const pending = routines.flatMap(x => x.runs.filter(y => y.state === 'waiting').map(y => ({ r: x, run: y })));

  /* ———— 节点图 ———— */
  const askWrite = (w: { id: string; name: string }, node: GNode) => new Promise<boolean>(res => {
    setDockOpen(true); const id = uid();
    const done = (ok: boolean) => { setEv(m => ({ ...m, graph: m.graph.map(e => e.id === id && e.kind === 'approval' ? { ...e, state: ok ? 'approved' : 'rejected' } : e) })); res(ok); };
    push({ id, kind: 'approval', action: `graph.write ${w.id}`, title: `${w.name} · 写入 ${node.v.target}`, effects: [`方式：${node.v.mode}`, '图像来自这次运行', '写入后可以在档案里撤销'], risk: 'write', state: 'pending', onApprove: () => done(true), onReject: () => done(false) }, 'graph');
  });
  const runner = useGraphRunner({ setWorkflows, reduced, ask: askWrite, log: t => say(<p>{t}</p>, 'graph') });
  const g = workflows.find(w => w.id === gsel) ?? workflows[0];
  const updW = (id: string, f: (w: Workflow) => Workflow) => setWorkflows(l => l.map(w => w.id === id ? f(w) : w));
  const openGraph = (id: string) => { setTabs(t => t.includes(id) ? t : [...t, id]); setGsel(id); setFace('graph'); };
  const closeTab = (id: string) => { const n = tabs.filter(x => x !== id); setTabs(n); if (gsel === id) setGsel(n[n.length - 1]); };
  const missingOf = (w: Workflow) => [...new Set(w.nodes.flatMap(n => DEF[n.type].widgets.filter(x => x.model && !installed(String(n.v[x.name]))).map(x => String(n.v[x.name]))))];
  const missingAll = MODELS.filter(m => !m.installed && workflows.some(w => w.nodes.some(n => Object.values(n.v).includes(m.name))));
  const install = (name: string) => {
    const m = MODELS.find(x => x.name === name); if (!m || m.installed || installing[name] !== undefined) return;
    const t = push({ kind: 'tool', action: 'models.install', label: `下载 ${name} · ${m.size} · ${m.source}`, state: 'running' }, 'graph'); const t0 = performance.now();
    setInstalling(s => ({ ...s, [name]: 0 }));
    for (let k = 1; k <= 10; k++) later(k * 220, () => setInstalling(s => ({ ...s, [name]: k * 10 })));
    later(2400, () => {
      m.installed = true; setInstalling(s => { const n = { ...s }; delete n[name]; return n; }); workflows.forEach(w => runner.clearErrors(w.id));
      patch(t, { state: 'done', ms: performance.now() - t0, detail: `已装到 models/${m.kind}/` } as Partial<DockEvent>);
      say(<p><b>{name}</b> 装好了，可以重新排队。</p>, 'graph');
    });
  };
  const checkModels = () => {
    setDockOpen(true); const miss = missingOf(g);
    if (!miss.length) return say(<p>{g.name} 用到的模型都装好了。</p>, 'graph');
    push({ kind: 'card', body: <div className="gm-card"><b>{g.name} 缺 {miss.length} 个模型</b>{miss.map(n => <div key={n}><code>{n}</code><small>{MODELS.find(m => m.name === n)?.size} · {MODELS.find(m => m.name === n)?.source}</small><button className="rh-btn is-solid" onClick={() => install(n)}>安装</button></div>)}</div> }, 'graph');
  };
  const explain = () => {
    const order = execOrder(g.nodes, g.links).map(id => g.nodes.find(n => n.id === id)!);
    say(<p><b>{g.name}</b> 有 {g.nodes.length} 个节点，排队时按这个顺序执行：{order.map(n => n.title ?? DEF[n.type].title).join(' → ')}。{g.tool?.published ? <>它已经发布为 <b>@{g.tool.id}</b>，被 {g.tool.usedBy.join('、') || '还没有例程'} 调用。</> : '还没有发布为工具。'}</p>, 'graph');
  };
  const queueRun = (count: number) => {
    const errs = runner.enqueue(g, count);
    if (!errs) return;
    setDockOpen(true);
    say(<p>排队前校验没通过（{Object.keys(errs).length} 个节点），画布上标红了：{Object.entries(errs).map(([id, e]) => `「${g.nodes.find(n => n.id === id)?.title ?? DEF[g.nodes.find(n => n.id === id)!.type].title}」${e}`).join('；')}。</p>, 'graph');
    if (missingOf(g).length) checkModels();
  };
  const buildGraph = (text: string) => {
    const d = buildFromText(text, 5 + workflows.length - WORKFLOWS.length); setGNew(false); setDockOpen(true); setBusy(true);
    setWorkflows(l => [...l, { ...d, nodes: [], links: [], saved: false }]); setTabs(t => [...t, d.id]); setGsel(d.id); setFitKey(k => k + 1);
    const t = push({ kind: 'tool', action: 'graph.build', label: '按一句话搭节点图 · 文生图模板', state: 'running' }, 'graph'); const t0 = performance.now();
    d.nodes.forEach((n, i) => later(300 + i * 220, () => updW(d.id, w => ({ ...w, nodes: [...w.nodes, n] }))));
    const base = 300 + d.nodes.length * 220;
    d.links.forEach((lk, i) => later(base + i * 110, () => updW(d.id, w => ({ ...w, links: [...w.links, lk] }))));
    later(base + d.links.length * 110 + 100, () => {
      setBusy(false); setFitKey(k => k + 1);
      const lat = d.nodes.find(n => n.type === 'EmptyLatentImage')!;
      patch(t, { state: 'done', ms: performance.now() - t0, detail: `${d.nodes.length} 个节点 · ${d.links.length} 条连线` } as Partial<DockEvent>);
      say(<p>搭好了 <b>{d.id}</b>：提示词按原话写进了「正向提示词」，尺寸 {lat.v.width}×{lat.v.height}，批次 {lat.v.batch_size}。按 <kbd>⌘ ↵</kbd> 或「排队运行」出图。</p>, 'graph');
    });
  };
  const blank = () => {
    const id = `WFG-${String(5 + workflows.length - WORKFLOWS.length).padStart(2, '0')}`;
    setWorkflows(l => [...l, { id, name: '未命名工作流', folder: '草稿', tags: [], nodes: [], links: [], groups: [], versions: [{ v: 'v1', at: '刚才', note: '空白', nodes: [], links: [] }], saved: false, updated: '刚才', outputs: [] }]);
    setTabs(t => [...t, id]); setGsel(id);
    say(<p>新建了空白工作流 {id}。双击画布空白处搜索节点。</p>, 'graph');
  };

  /* ———— 编排 ———— */
  const markDirty = (id: string) => setDirty(s => new Set(s).add(id));
  const resolve = (a: Amb, o: string) => {
    upd(r.id, x => ({ ...x, instruction: x.instruction.replace(a.phrase, o), ambs: x.ambs.filter(b => b.id !== a.id) })); markDirty(r.id);
    say(<p>改成了「{o}」。指令里还有 {r.ambs.length - 1} 处没说清。</p>, 'compose');
  };
  const save = () => {
    const v = `v${(parseFloat(r.version.slice(1)) + .1).toFixed(1)}`;
    upd(r.id, x => ({ ...x, version: v, versions: [[v, '刚才', '在编排面修改指令与权限'], ...x.versions] }));
    setDirty(s => { const n = new Set(s); n.delete(r.id); return n; });
    say(<p>已保存为 <b>{v}</b>，下一次触发开始生效。</p>, 'compose');
  };
  const doPreview = () => {
    const steps = interpret(r); setPreview({ id: r.id, at: 0, done: false }); setBusy(true);
    const t = push({ kind: 'tool', action: 'routine.dry_run', label: `预演 ${r.id} · ${steps.length} 步 · 不调用工具`, state: 'running' }); const t0 = performance.now();
    steps.forEach((_, i) => later(420 * (i + 1), () => setPreview({ id: r.id, at: i + 1, done: false })));
    later(420 * (steps.length + 1), () => {
      setPreview({ id: r.id, at: steps.length, done: true }); setBusy(false);
      const stops = steps.filter(s => s.waits || s.tools.some(x => x.perm === 'ask')).length;
      patch(t, { state: 'done', ms: performance.now() - t0, detail: `${steps.length} 步 · ${stops} 处停下等你 · 0 次写入` } as Partial<DockEvent>);
      say(<p>预演走完了。正式运行大约 <b>{Math.max(1, Math.round(r.budget.minutes * .3))} 分钟</b>，会在 <b>{stops}</b> 处停下来问你。{r.ambs.length ? <>还有 <b>{r.ambs.length}</b> 处没说清，我会按最保守的理解执行。</> : '指令没有歧义。'}</p>, 'compose');
    });
  };
  const createDraft = (text: string) => {
    const d = draftRoutine(text, 9 + routines.length - ROUTINES.length); d.file = file;
    setBusy(true); setNewMode(false);
    const t = push({ kind: 'tool', action: 'routine.draft', label: '根据一句话起草例程', state: 'running' }); const t0 = performance.now();
    later(900, () => {
      setRoutines(l => [...l, d]); setSel(d.id); setRunSel(null); setPreview(null); setTyping(0);
      const n = d.instruction.length;
      for (let i = 1; i <= n; i++) later(900 + i * 28, () => setTyping(i));
      later(900 + n * 28 + 200, () => {
        setTyping(null); setBusy(false);
        patch(t, { state: 'done', ms: performance.now() - t0, detail: `${d.triggers[0].human} · ${d.tools.length} 个工具 · ${d.ambs.length} 处待说清` } as Partial<DockEvent>);
        say(<p>草稿 <b>{d.id} {d.name}</b> 写好了，还没启用。触发我理解成 <b>{d.triggers[0].human}</b>；写入和发出都设成了「先问你」。有 1 处需要你说清楚，见指令里的橙色虚线。</p>, 'compose');
      });
    });
  };

  /* ———— 运行 ———— */
  const runNow = () => {
    if (live) return;
    const tpl = r.runs.find(x => x.state !== 'fail' && x.steps.length > 3);
    const steps: Step[] = tpl ? tpl.steps.map(s => s.kind === 'approval' ? { ...s, state: 'pending' } : s) : [
      { t: 0, kind: 'think', text: `按指令执行，共 ${interpret(r).length} 步。` },
      ...interpret(r).map((s, i): Step => { const w = s.tools.find(x => x.perm === 'ask'); return w ? { t: 4 + i * 6, kind: 'approval', tool: w.id, text: s.text.replace(/[@#]/g, ''), state: 'pending' } : { t: 4 + i * 6, kind: 'tool', tool: s.tools[0]?.id, text: s.text.replace(/[@#]/g, ''), output: '完成（模拟）' }; }),
    ];
    const cut = steps.findIndex(s => s.kind === 'approval'); const shown = cut >= 0 ? steps.slice(0, cut + 1) : steps;
    const id = `R-${String(900 + Math.floor(Math.random() * 99))}`, rid = r.id;
    const fresh: Run = { id, at: `今天 ${clock()}`, trigger: '手动 · 立即运行', state: 'running', took: '—', calls: 0, cost: 0, version: r.version, note: '运行中…', steps: [] };
    upd(rid, x => ({ ...x, runs: [fresh, ...x.runs], history: setLast(x.history, 'R') })); setRunSel(id); setLive(id); setFace('runs');
    const stream = (f: (run: Run) => Run) => upd(rid, x => ({ ...x, runs: x.runs.map(y => y.id === id ? f(y) : y) }));
    shown.forEach((s, i) => later(500 + i * 560, () => stream(y => ({ ...y, steps: [...y.steps, s], calls: y.calls + (s.kind === 'tool' ? 3 + i : 0) }))));
    later(500 + shown.length * 560, () => {
      const wait = cut >= 0;
      stream(y => ({ ...y, state: wait ? 'waiting' : 'ok', took: `0m ${String(Math.round(shown.at(-1)!.t / 4 + 6)).padStart(2, '0')}s`, cost: +(y.calls * .013).toFixed(2), note: wait ? '停在写入前，等你确认' : '完成', steps: wait ? y.steps : [...y.steps, { t: shown.at(-1)!.t + 2, kind: 'done', text: '完成' }] }));
      upd(rid, x => ({ ...x, history: setLast(x.history, wait ? 'W' : 'o') })); setLive(null);
      say(wait ? <p>{id} 停在第 {shown.length} 步：要写入，等你在记录里批准。</p> : <p>{id} 跑完了，没有需要你确认的写入。</p>, 'runs');
    });
  };
  const decide = (rid: string, runId: string, i: number, ok: boolean) => {
    upd(rid, x => ({ ...x, history: x.runs[0]?.id === runId ? setLast(x.history, ok ? 'o' : 'w') : x.history, runs: x.runs.map(y => y.id !== runId ? y : { ...y, state: ok ? 'ok' : 'warn', note: ok ? `${y.note.replace(/ · .*等你确认|，等你确认|停在写入前/, '')} · 已写入` : '你驳回了写入 · 没有写入任何内容',
      steps: [...y.steps.map((s, k) => k === i ? { ...s, state: ok ? 'approved' : 'rejected' } as Step : s), ...(ok ? [{ t: y.steps[i].t + 3, kind: 'tool', tool: y.steps[i].tool, text: '写入完成', output: '已追加，可在档案里撤销' } as Step] : []), { t: y.steps[i].t + 4, kind: 'done', text: ok ? '完成' : '已驳回，未写入' } as Step] }) }));
    say(ok ? <p>已批准，写入完成。</p> : <p>已驳回，这次运行不写入任何内容。要我把原因记进指令吗？</p>, 'runs');
  };

  /* ———— 维护 ———— */
  const setIncSt = (id: string, p: Partial<IncState>) => setInc(m => ({ ...m, [id]: { ...m[id], ...p } }));
  const approveFix = (i = curInc) => {
    const ir = routines.find(x => x.id === i.routine)!, v = `v${(parseFloat(ir.version.slice(1)) + .1).toFixed(1)}`;
    upd(i.routine, x => ({ ...x, instruction: i.fix.instruction ?? x.instruction, ambs: x.ambs.filter(a => (i.fix.instruction ?? x.instruction).includes(a.phrase)), version: v, versions: [[v, '刚才', `维护：${i.title}`], ...x.versions] }));
    setIncSt(i.id, { stage: 4, approved: true });
    setEv(m => ({ ...m, maintain: m.maintain.map(e => e.kind === 'approval' && e.action === `routine.deploy ${i.id}` ? { ...e, state: 'approved' } : e) }));
    say(<p><b>{i.routine}</b> 已上线 <b>{v}</b>。改动写进了指令，编排面能看到；下一次触发开始生效。</p>, 'maintain');
  };
  const rejectFix = (i = curInc) => {
    setIncSt(i.id, { approved: false });
    setEv(m => ({ ...m, maintain: m.maintain.map(e => e.kind === 'approval' && e.action === `routine.deploy ${i.id}` ? { ...e, state: 'rejected' } : e) }));
    say(<p>已驳回，例程保持原版本。可以告诉我哪里不对，我重新改。</p>, 'maintain');
  };
  const nextStage = () => {
    const i = curInc, st = inc[i.id].stage; if (working !== null) return;
    if (st === 3) { scrollWithin(document.querySelector('.au-review'), 'center'); return; }
    setWorking(st); setBusy(true);
    const label = [`诊断 ${i.run} · 对比最近 30 次运行`, `改写 ${i.routine} 的${i.fix.where}`, `沙盒重放 ${i.run} + 回归 ${i.regress.length} 次`][st];
    const t = push({ kind: 'tool', action: ['maint.diagnose', 'maint.patch', 'maint.sandbox_replay'][st], label, state: 'running' }); const t0 = performance.now();
    const finish = (detail: string, msg: ReactNode) => {
      setWorking(null); setBusy(false); setIncSt(i.id, { stage: st + 1 });
      patch(t, { state: 'done', ms: performance.now() - t0, detail } as Partial<DockEvent>); say(msg, 'maintain');
    };
    if (st === 0) later(1500, () => finish(`失败在第 ${i.failStep + 1} 步 · 置信度 ${Math.round(i.confidence * 100)}%`, <p>原因找到了：{i.cause.split('；')[0]}。下一步我来改。</p>));
    if (st === 1) later(1300, () => finish(`${i.fix.diff.filter(d => d.op !== ' ').length} 行改动`, <p>修复写好了：{i.fix.why} 先别上线，我在沙盒里用失败那次的输入重跑一遍。</p>));
    if (st === 2) {
      setReplayN(0); setRegressN(0);
      i.replay.forEach((_, k) => later(450 * (k + 1), () => setReplayN(k + 1)));
      const base = 450 * (i.replay.length + 1);
      i.regress.forEach((_, k) => later(base + 320 * (k + 1), () => setRegressN(k + 1)));
      later(base + 320 * (i.regress.length + 1), () => {
        finish(`重放通过 · 回归 ${i.regress.length}/${i.regress.length} · 0 次真实写入`, <p>沙盒里通过了，回归也没改坏。上线需要你批准。</p>);
        const ir = routines.find(x => x.id === i.routine)!;
        push({ kind: 'approval', action: `routine.deploy ${i.id}`, title: `上线 ${i.routine} ${ir.name} · v${(parseFloat(ir.version.slice(1)) + .1).toFixed(1)}`, effects: [`${i.fix.where}：${i.fix.why}`, `沙盒重放 ${i.run} 通过`, '下一次触发开始生效，可回滚'], risk: 'write', state: 'pending', onApprove: () => approveFix(i), onReject: () => rejectFix(i) }, 'maintain');
      });
    }
  };
  useEffect(() => { setWorking(null); setReplayN(0); setRegressN(0); }, [incSel]);

  /* ———— 助手对话 ———— */
  const send = (text: string) => {
    const f = faceRef.current; push({ kind: 'user', text, at: clock() }, f);
    if (f === 'compose') {
      if (newMode || /^(每天|每周|每当|每月|当|帮我|以后)/.test(text)) return createDraft(text);
      if (/^(加一句|补充|另外|再加)/.test(text)) { const s = text.replace(/^(加一句|补充|另外|再加)[:：，,]?/, '').replace(/[。.]?$/, '。'); upd(r.id, x => ({ ...x, instruction: x.instruction + s })); markDirty(r.id); return say(<p>加到指令末尾了，右边的解读多了一步。记得保存。</p>); }
      const rd = interpret(r);
      return later(500, () => say(<p>按现在的写法，我会分 <b>{rd.length}</b> 步执行；用到 {r.tools.filter(t => t.perm !== 'deny').length} 个工具，其中「{r.tools.filter(t => t.perm === 'ask').map(t => t.name).join('」「') || '无'}」每次先问你。想改指令可以直接说「加一句：……」，想新建就说「每天……」。</p>));
    }
    if (f === 'graph') {
      if (gNew || /^(帮我)?(搭|做|生成|画)/.test(text)) return buildGraph(text);
      if (/模型|缺/.test(text)) return checkModels();
      return later(300, explain);
    }
    if (f === 'runs') {
      const key = run?.steps.find(s => s.kind === 'error') ?? run?.steps.find(s => s.kind === 'approval') ?? run?.steps.at(-1);
      return later(500, () => say(run ? <p>{run.id}：{run.note}。关键在 <b>{key ? `+${key.t}s` : ''}</b> 那一步——{key?.text}{key?.output ? `（${key.output}）` : ''}。</p> : <p>这条例程还没有运行记录。</p>));
    }
    if (/自动|直接上线|为什么.*(批准|审)/.test(text)) return later(400, () => say(<p>例程的改动会改变它以后每一次的行为，所以上线只能你批准；维护 Agent 自己最多走到沙盒重放，沙盒里所有写入都被拦截。</p>));
    later(400, () => say(<p>{curInc.id} 现在在「{STAGES[Math.min(incSt.stage, 3)]}」。{curInc.cause}</p>));
  };

  /* ———— 资源管理器 ———— */
  const groupSections = (render: (x: Routine) => ReactNode): ExplorerSection[] => [file, ...FILES.map((_, i) => i).filter(i => i !== file)].map(g => ({
    id: `g${g}`, title: FILES[g], count: routines.filter(x => x.file === g).length, folded: g !== file, grow: g === file,
    body: <div className="au-list">{routines.filter(x => x.file === g).map(render)}</div>,
  }));
  const item = (x: Routine, meta: ReactNode) => <button key={x.id} className="au-item" aria-current={x.id === r.id || undefined} data-off={!x.enabled || undefined} onClick={() => pick(x.id)}>
    <i data-s={({ o: 'ok', w: 'warn', x: 'fail', W: 'waiting', R: 'running', '-': 'none' } as Record<string, string>)[x.history.at(-1)!]} />
    <span><b>{x.name}</b><small>{x.id} · {meta}</small></span>{dirty.has(x.id) && <em>M</em>}
  </button>;
  const today = routines.filter(x => x.enabled).flatMap(x => x.triggers.filter(t => t.hours && (t.days ?? []).includes(0)).flatMap(t => t.hours!.map(h => ({ x, h })))).sort((a, b) => a.h - b.h);
  const nextUp = today.find(e => e.h > HOUR);
  const sections: ExplorerSection[] = xpView === 'connect'
    ? [{ id: 'conn', title: '连接器', count: CONNECTORS.length, grow: true, body: <ul className="au-conn">{CONNECTORS.map(([n, d, s]) => <li key={n} data-s={s}><i /><b>{n}</b><small>{d}</small></li>)}</ul> }]
    : face === 'compose' ? [
      { id: 'new', title: '新建', body: <button className="au-new" onClick={() => { setNewMode(true); say(<p>用一句话告诉我想自动化什么，比如「每周五下午 5 点把本周实验整理成周报」。</p>); document.querySelector<HTMLTextAreaElement>('.ad-input textarea')?.focus(); }}>＋ 用一句话新建例程</button> },
      ...groupSections(x => item(x, x.triggers[0].human)),
    ] : face === 'runs' ? [
      { id: 'today', title: '今天 · 时间表', count: today.length, body: <ol className="au-today">{today.map((e, i) => <li key={i} data-past={e.h < HOUR || undefined} data-next={e === nextUp || undefined}><time>{hhmm(e.h)}</time><button onClick={() => pick(e.x.id)}>{e.x.name}</button></li>)}</ol> },
      { id: 'inbox', title: '等你确认', count: pending.length, body: pending.length ? <div className="au-list">{pending.map(p => <button key={p.run.id} className="au-item is-wait" onClick={() => { pick(p.r.id); setRunSel(p.run.id); }}><i data-s="waiting" /><span><b>{p.r.name}</b><small>{p.run.id} · {p.run.note}</small></span></button>)}</div> : <p className="au-none">没有等你确认的写入</p> },
      ...groupSections(x => item(x, x.runs.length ? `${x.runs.length} 次 · ${STATE_LABEL[x.runs[0].state]}` : '还没运行过')),
    ] : [
      { id: 'open', title: `故障 · 未处理 ${openIncs.length}`, count: INCIDENTS.length, grow: true, body: <div className="au-list">{INCIDENTS.map(i => <button key={i.id} className="au-item" aria-current={i.id === incSel || undefined} data-off={inc[i.id].approved !== null || undefined} onClick={() => setIncSel(i.id)}>
        <i data-s={inc[i.id].approved ? 'ok' : inc[i.id].approved === false ? 'warn' : 'fail'} /><span><b>{i.title}</b><small>{i.id} · {i.routine} · {inc[i.id].approved ? '已上线' : STAGES[Math.min(inc[i.id].stage, 3)]}</small></span>
        <em className="au-pips">{STAGES.map((_, k) => <u key={k} data-on={k < inc[i.id].stage || undefined} />)}</em></button>)}</div> },
      { id: 'ver', title: `${incR.id} · 版本`, count: incR.versions.length, body: <ol className="au-versions is-mini">{incR.versions.map(([v, d, n], k) => <li key={v + k} data-now={k === 0 || undefined}><b>{v}</b><time>{d}</time><span>{n}</span></li>)}</ol> },
    ];

  const folders = [...new Set(workflows.map(w => w.folder))];
  const gsections: ExplorerSection[] = gView === 'flows' ? [
    { id: 'gnew', title: '新建', body: <div className="gm-new"><button onClick={blank}>＋ 空白工作流</button><button onClick={() => { setGNew(true); setDockOpen(true); say(<p>用一句话说要搭什么，例如「搭一张竖版赏枫海报，4 张」。</p>, 'graph'); }}>＋ 一句话搭图</button></div> },
    ...folders.map(f => ({ id: f, title: f, count: workflows.filter(w => w.folder === f).length, grow: f === g.folder, body: <div className="au-list">{workflows.filter(w => w.folder === f).map(w => <button key={w.id} className="au-item" aria-current={w.id === gsel || undefined} onClick={() => openGraph(w.id)}>
      <i data-s={w.tool?.published ? 'ok' : 'none'} /><span><b>{w.name}</b><small>{w.id} · {w.versions[0].v} · {w.updated}{w.tool?.published ? ` · @${w.tool.id}` : ''}</small></span>{!w.saved && <em>M</em>}</button>)}</div> })),
  ] : gView === 'models' ? (Object.keys(MODEL_KIND) as ModelKind[]).map(k => ({ id: k, title: MODEL_KIND[k], count: MODELS.filter(m => m.kind === k).length, body: <ul className="gm-models">{MODELS.filter(m => m.kind === k).map(m => {
      const used = workflows.filter(w => w.nodes.some(n => Object.values(n.v).includes(m.name))).map(w => w.id);
      return <li key={m.name} data-s={m.installed ? 'on' : installing[m.name] !== undefined ? 'busy' : 'off'} data-miss={!m.installed && used.length > 0 || undefined}>
        <b title={m.name}>{m.name}</b><small>{m.size} · {m.source}{m.note ? ` · ${m.note}` : ''}</small>{used.length > 0 && <small className="gm-used">{m.installed ? '用于' : '缺失 · 被'} {used.join(' / ')}{m.installed ? '' : ' 引用'}</small>}
        {m.installed ? <em>已安装</em> : installing[m.name] !== undefined ? <span className="gm-bar"><i style={{ width: `${installing[m.name]}%` }} /></span> : <button onClick={() => install(m.name)}>安装</button>}
      </li>; })}</ul> }))
    : [{ id: 'gal', title: `${g.name} · 输出`, count: g.outputs.length, grow: true, body: g.outputs.length ? <div className="gm-gallery">{g.outputs.map(o => <button key={o.id} onClick={() => setLightbox(o)}><Art seed={o.seed} w={o.w} h={o.h} theme={o.theme} stamp={false} /><small>{o.seed}</small></button>)}</div> : <p className="au-none">还没有输出，排队运行一次</p> }];

  const plan = face === 'graph' ? { stages: ['搭图', '检查模型', '排队运行', '发布为工具'], current: missingOf(g).length ? 1 : !g.outputs.length ? 2 : 3 }
    : face === 'compose'
    ? { stages: ['写指令', '说清歧义', '设权限', '预演', '启用'], current: typing !== null ? 0 : r.ambs.length ? 1 : !(preview?.done && preview.id === r.id) ? 3 : r.enabled ? 4 : 4 }
    : face === 'runs' ? { stages: ['触发', '执行', '等你确认', '完成'], current: !run ? 0 : run.state === 'running' ? 1 : run.state === 'waiting' ? 2 : 3 }
      : { stages: STAGES, current: Math.min(incSt.stage, 3) };
  const qRunning = runner.queue.some(q => q.status === 'running');
  const loop = face === 'graph' && qRunning ? { stages: ['校验', '执行节点', '采样', '保存'], current: runner.live?.prog ? 2 : 1 } : face === 'maintain' && working !== null ? { stages: STAGES, current: working } : face === 'runs' && live ? { stages: ['读指令', '调工具', '检查', '产出'], current: 1 } : null;
  const suggestions = face === 'graph' ? [
    { id: 'b', label: '一句话搭图', onClick: () => send('搭一张竖版赏枫海报，4 张') }, { id: 'm', label: '检查缺失模型', onClick: checkModels }, { id: 'e', label: '解释这张图', onClick: explain },
  ] : face === 'compose' ? [
    { id: 'p', label: '预演一遍', onClick: doPreview }, { id: 'n', label: '一句话新建', onClick: () => send('每周五下午 5 点把本周实验整理成周报') },
  ] : face === 'runs' ? [
    { id: 'r', label: '立即运行', onClick: runNow }, { id: 'w', label: '这次为什么停下', onClick: () => send('这次为什么停下') },
  ] : [
    ...(incSt.stage < 3 && incSt.approved === null ? [{ id: 'n', label: ['开始诊断', '生成修复', '沙盒重放'][incSt.stage], onClick: nextStage }] : []), { id: 'q', label: '为什么不能自动上线', onClick: () => send('为什么不能自动上线') },
  ];

  return <BenchFrame code="AUTO" section="005" file={file} reduced={reduced} chrome={chrome} face={face} onFace={id => setFace(id as Face)}
    faces={[
      { id: 'compose', label: '编排', en: 'COMPOSE', badge: routines.reduce((n, x) => n + x.ambs.length, 0) || undefined },
      { id: 'graph', label: '节点', en: 'GRAPH', badge: missingAll.length || undefined },
      { id: 'runs', label: '运行', en: 'RUNS', badge: pending.length || undefined },
      { id: 'maintain', label: '维护', en: 'MAINTAIN', badge: openIncs.length || undefined },
    ]}
    strip={<>{FILES[file]} <i>·</i> 例程 {routines.filter(x => x.file === file).length} <i>·</i> 下一次 {nextUp ? `${hhmm(nextUp.h)} ${nextUp.x.name}` : '明天'}</>}
    shutterLines={f => [`> mount ${f.en.toLowerCase()} · ${routines.length} routines`, f.id === 'graph' ? `> load ${tabs.length} workflow · ${missingAll.length} model missing` : f.id === 'maintain' ? `> ${openIncs.length} incidents open` : f.id === 'runs' ? `> ${pending.length} awaiting approval` : '> parse instructions', '> ready']}
    status={<><span><i className="en-sq" />{FILES[file]}</span><span>启用 {routines.filter(x => x.enabled).length} / {routines.length}</span><span data-alert={pending.length > 0 || undefined}>等你确认 {pending.length}</span><span data-alert={openIncs.length > 0 || undefined}>故障 {openIncs.length}</span><span>示例数据 · 不连接模型</span></>}>
    <div className="au" data-face={face}>
      {face === 'graph'
        ? <Explorer code="AUTO" open={xpOpen} view={gView} onView={setGView} onToggle={() => setXpOpen(v => !v)} views={GVIEWS} key={`graph${gView}`} title="workspace/" sections={gsections} badges={{ models: missingAll.length || undefined, gallery: g.outputs.length || undefined }} />
        : <Explorer code="AUTO" open={xpOpen} view={xpView} onView={setXpView} onToggle={() => setXpOpen(v => !v)} views={VIEWS} key={face + xpView}
          title={face === 'maintain' ? 'incidents/' : 'routines/'} sections={sections} badges={{ list: face === 'maintain' ? openIncs.length || undefined : pending.length || undefined }} />}
      {face === 'compose' && <ComposeFace r={r} typing={typing} dirty={dirty.has(r.id)} preview={preview?.id === r.id ? preview : null}
        onEdit={t => { upd(r.id, x => ({ ...x, instruction: t })); markDirty(r.id); }} onResolve={resolve}
        onPerm={(tool, p) => { upd(r.id, x => ({ ...x, tools: x.tools.map(t => t.id === tool ? { ...t, perm: p } : t) })); markDirty(r.id); }}
        onBudget={(k, v) => { upd(r.id, x => ({ ...x, budget: { ...x.budget, [k]: v } })); markDirty(r.id); }}
        onToggle={() => { upd(r.id, x => ({ ...x, enabled: !x.enabled })); say(<p>{r.id} {r.enabled ? '已停用，不会再被触发' : `已启用，下一次：${r.triggers[0].human}`}。</p>); }}
        onPreview={doPreview} onRunNow={runNow} onSave={save}
        graphTools={Object.fromEntries(workflows.filter(w => w.tool?.published).map(w => [w.tool!.id, { id: w.id, name: w.name }]))} onOpenGraph={openGraph} />}
      {face === 'graph' && <GraphFace workflows={workflows} open={tabs} cur={g.id} onTab={setGsel} onCloseTab={closeTab} fitKey={fitKey}
        onChange={(id, p) => updW(id, w => ({ ...w, ...p, saved: false }))} live={runner.live} errors={runner.errors[g.id] ?? {}} latest={runner.latest[g.id]} queue={runner.queue} installed={installed}
        onQueue={queueRun} onClearQueue={runner.clearDone}
        onSave={() => { if (!g.saved) { updW(g.id, w => ({ ...w, saved: true, updated: '刚才' })); say(<p>{g.name} 已保存。</p>, 'graph'); } }}
        onSaveVersion={() => { const v = `v${parseInt(g.versions[0].v.slice(1)) + 1}`; updW(g.id, w => ({ ...w, saved: true, updated: '刚才', versions: [{ v, at: '刚才', note: '手动存档', nodes: w.nodes, links: w.links }, ...w.versions] })); say(<p>{g.name} 存为 <b>{v}</b>。</p>, 'graph'); }}
        onRestore={v => { const ver = g.versions.find(x => x.v === v)!; updW(g.id, w => ({ ...w, nodes: ver.nodes, links: ver.links, saved: false })); say(<p>画布恢复到 {v}（还没保存）。</p>, 'graph'); }}
        onPublish={(toolId, params) => { updW(g.id, w => ({ ...w, tool: { id: toolId, params, published: true, usedBy: w.tool?.usedBy ?? [] } })); setDockOpen(true); say(<p>已发布为 <b>@{toolId}</b>，暴露 {params.length} 个参数。在例程指令里写 @{toolId} 就能调用{g.nodes.some(n => DEF[n.type].write) ? '；图里有写入节点，例程里默认设成「询问」' : ''}。</p>, 'graph'); }}
        onOpenRoutine={id => { pick(id); setFace('compose'); }}
        dockOpen={dockOpen} onDock={() => setDockOpen(v => !v)} lightbox={lightbox} onLightbox={setLightbox}
        onUseSeed={o => { updW(g.id, w => ({ ...w, saved: false, nodes: w.nodes.map(n => n.type === 'KSampler' ? { ...n, v: { ...n.v, seed: o.seed, control_after_generate: 'fixed' } } : n) })); say(<p>载入了 seed {o.seed}，control_after_generate 改成 fixed。</p>, 'graph'); }} />}
      {face === 'runs' && <RunsFace routines={routines} r={r} run={run} live={!!live} onPick={pick} onRun={setRunSel} onRunNow={runNow}
        onApprove={i => run && decide(r.id, run.id, i, true)} onReject={i => run && decide(r.id, run.id, i, false)} />}
      {face === 'maintain' && <MaintainFace inc={curInc} r={incR} run={incR.runs.find(x => x.id === curInc.run)} stage={incSt.stage} working={working}
        replayN={incSt.stage >= 3 ? curInc.replay.length : replayN} regressN={incSt.stage >= 3 ? curInc.regress.length : regressN} approved={incSt.approved}
        onNext={nextStage} onApprove={() => approveFix()} onReject={() => rejectFix()} />}
      {(face !== 'graph' || dockOpen) && <AgentDock name={face === 'graph' ? '节点助手' : face === 'maintain' ? '维护 Agent' : face === 'runs' ? '运行助手' : '例程助手'}
        target={face === 'graph' ? `${g.id} · ${g.name}` : face === 'maintain' ? `${curInc.id} · ${curInc.routine} ${incR.name}` : `${r.id} · ${r.name} · ${r.version}`}
        plan={plan} suggestions={suggestions} events={ev[face]} busy={busy} loop={loop} onSend={send}
        placeholder={face === 'graph' ? (gNew ? '一句话描述要搭的图，例如：竖版赏枫海报，4 张' : '「搭一张……」或问这张图') : face === 'compose' ? (newMode ? '用一句话描述新例程，例如：每天早上 9 点…' : '「加一句：……」改指令，或「每天……」新建') : face === 'runs' ? '问这次运行，例如：为什么停下' : '问维护 Agent'}
        footnote={face === 'compose' ? '写入 / 发出默认先问你 · 危险动作只能你点' : face === 'graph' ? '写入档案的节点运行时会停下来问你' : undefined} />}
    </div>
  </BenchFrame>;
}
