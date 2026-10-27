import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { now } from '../../Chat';
import type { BenchProps } from '../../WorkbenchStudio';
import './bench-engineering.css';

/* ── Sample workspaces: an archive is a folder, each file in it a conversation ── */
type ConvState = 'active' | 'review' | 'done' | 'paused';
interface Conv { id: string; title: string; state: ConvState; updated: string; summary: string; changed: number; turns: number }
interface Conn { name: string; kind: string; detail: string; state: 'ok' | 'idle' | 'fail' }
interface Workspace { name: string; path: string; stack: string[]; branch: string; preview: string; conns: Conn[]; convs: Conv[] }
const PROGRESS: Record<ConvState, number> = { active: 4, review: 5, done: 6, paused: 2 };
const STATE: Record<ConvState, string> = { active: '进行中', review: '待审阅', done: '已完成', paused: '暂停' };
const WORKSPACES: Workspace[] = [
  { name: 'ReinLab · 交互原型', path: '~/Documents/DeepSeekPlugin/ReinLab', stack: ['React 19', 'TypeScript', 'Vite', 'CSS 3D'], branch: 'main', preview: 'http://127.0.0.1:5173', conns: [{ name: 'reinlab_dev', kind: 'PostgreSQL', detail: 'localhost:5432 · 6 张表', state: 'ok' }, { name: 'course-cache', kind: 'SQLite', detail: '.cache/courses.db', state: 'ok' }, { name: 'OpenMAIC', kind: 'HTTP', detail: 'localhost:4290 · 只读', state: 'idle' }],
    convs: [
      { id: 'C-01', title: '入口与档案场景', state: 'done', updated: '10-06', summary: '档案阵列、开场动画与印章转场。', changed: 14, turns: 38 },
      { id: 'C-02', title: '档案浏览器 · 键盘与窄屏', state: 'active', updated: '刚才', summary: '列表键盘选择、窄屏布局，正在补测试。', changed: 5, turns: 12 },
      { id: 'C-03', title: '工作台外壳重做', state: 'review', updated: '今天', summary: '44px 顶栏、面包屑切换档案。等你审阅。', changed: 7, turns: 21 },
      { id: 'C-04', title: '课程缓存迁移', state: 'paused', updated: '10-02', summary: 'SQLite 缓存表结构调整，等待课程接口确认。', changed: 3, turns: 9 },
    ] },
  { name: '组件与规范', path: '~/Documents/ReinLab-ui', stack: ['React', 'Storybook', 'CSS Variables'], branch: 'tokens', preview: 'http://127.0.0.1:6006', conns: [{ name: 'figma-tokens', kind: 'JSON', detail: 'tokens/rhine.json', state: 'ok' }],
    convs: [{ id: 'C-01', title: '颜色与线宽变量', state: 'done', updated: '10-04', summary: '纸白、灰绿、金三组变量。', changed: 6, turns: 14 }, { id: 'C-02', title: '编号字形组件', state: 'active', updated: '今天', summary: 'ArchiveNumber 组件与等宽数字。', changed: 3, turns: 7 }] },
  { name: '模型工具接入', path: '~/Documents/reinlab-tools', stack: ['Node 22', 'zod', 'MCP'], branch: 'feat/tools', preview: 'http://127.0.0.1:4310', conns: [{ name: 'tools.db', kind: 'SQLite', detail: '调用记录', state: 'ok' }, { name: 'MCP · filesystem', kind: 'MCP', detail: 'stdio · 只读', state: 'ok' }],
    convs: [{ id: 'C-01', title: '工具声明与校验', state: 'review', updated: '昨天', summary: '声明与参数校验分离。', changed: 4, turns: 16 }, { id: 'C-02', title: '错误信息可读化', state: 'active', updated: '刚才', summary: '错误包含工具名与参数路径。', changed: 2, turns: 6 }, { id: 'C-03', title: '本地替身', state: 'done', updated: '10-03', summary: '预览环境不发真实请求。', changed: 3, turns: 8 }] },
  { name: '验证与交付', path: '~/Documents/ReinLab', stack: ['Vitest', 'Playwright'], branch: 'release', preview: 'http://127.0.0.1:4173', conns: [{ name: 'CI', kind: 'GitHub Actions', detail: '未连接', state: 'idle' }],
    convs: [{ id: 'C-01', title: '截图回归', state: 'active', updated: '今天', summary: '桌面 1440 与手机 390 截图比对。', changed: 2, turns: 5 }, { id: 'C-02', title: '交付说明', state: 'paused', updated: '10-05', summary: '构建与已知限制。', changed: 1, turns: 4 }] },
];

/* ── One conversation's working state ── */
type TreeNode = { name: string; path: string; dir?: boolean; mark?: 'M' | 'A'; read?: boolean; children?: TreeNode[] };
const TREE: TreeNode[] = [
  { name: 'src', path: 'src', dir: true, children: [
    { name: 'components', path: 'src/components', dir: true, children: [
      { name: 'ArchiveBrowser.tsx', path: 'src/components/ArchiveBrowser.tsx', mark: 'M', read: true },
      { name: 'ArchiveList.tsx', path: 'src/components/ArchiveList.tsx', mark: 'M', read: true },
      { name: 'FileCallout.tsx', path: 'src/components/FileCallout.tsx', read: true },
      { name: 'useKeys.ts', path: 'src/components/useKeys.ts', mark: 'A' },
    ] },
    { name: 'styles', path: 'src/styles', dir: true, children: [{ name: 'browser.css', path: 'src/styles/browser.css', mark: 'M', read: true }, { name: 'tokens.css', path: 'src/styles/tokens.css' }] },
    { name: 'data', path: 'src/data', dir: true, children: [{ name: 'archives.ts', path: 'src/data/archives.ts', read: true }] },
    { name: 'main.tsx', path: 'src/main.tsx' },
  ] },
  { name: 'tests', path: 'tests', dir: true, children: [{ name: 'browser.test.tsx', path: 'tests/browser.test.tsx', mark: 'A' }] },
  { name: 'package.json', path: 'package.json' }, { name: 'vite.config.ts', path: 'vite.config.ts' },
];
const CODE: Record<string, string[]> = {
  'src/components/ArchiveBrowser.tsx': ['export function ArchiveBrowser({ files }: Props) {', '  const [index, setIndex] = useState(0);', '  const sorted = useMemo(() => byNumber(files), [files]);', '  useKeys({ up: () => setIndex(i => i - 1), down: () => setIndex(i => i + 1),', '            enter: () => open(sorted[index]) });', '  const file = sorted[modulo(index, sorted.length)];', '  return <section className="browser">', '    <ArchiveList items={sorted} active={index} onPick={setIndex} />', '    <FileCallout file={file} onOpen={() => open(file)} />', '  </section>;', '}'],
  'src/components/useKeys.ts': ['export function useKeys(map: KeyMap) {', '  useEffect(() => {', '    const on = (e: KeyboardEvent) => {', "      const key = { ArrowUp: 'up', ArrowDown: 'down', Enter: 'enter' }[e.key];", '      if (key && map[key]) { e.preventDefault(); map[key](); }', '    };', "    window.addEventListener('keydown', on);", "    return () => window.removeEventListener('keydown', on);", '  }, [map]);', '}'],
  'src/styles/browser.css': ['.browser { display: grid; grid-template-columns: 320px 1fr; }', '@container (max-width: 700px) {', '  .browser { grid-template-columns: 1fr; }', '  .browser .list { order: 2; }', '}'],
  'tests/browser.test.tsx': ["test('arrow keys move the selection', async () => {", '  render(<ArchiveBrowser files={files} />);', "  await user.keyboard('{ArrowDown}');", "  expect(screen.getByRole('heading')).toHaveTextContent('X—014');", '});'],
};
const DIFFS = [
  { path: 'src/components/useKeys.ts', add: 10, del: 0, hunk: CODE['src/components/useKeys.ts'].slice(0, 6).map(l => '+' + l) },
  { path: 'src/components/ArchiveBrowser.tsx', add: 4, del: 2, hunk: ['  const sorted = useMemo(() => byNumber(files), [files]);', '-  const onKey = (e) => { if (e.key === "ArrowDown") next(); };', '-  window.onkeydown = onKey;', '+  useKeys({ up: () => setIndex(i => i - 1), down: () => setIndex(i => i + 1),', '+            enter: () => open(sorted[index]) });'] },
  { path: 'src/components/ArchiveList.tsx', add: 3, del: 1, hunk: ['-  <li onClick={() => onPick(i)}>', '+  <li role="option" aria-selected={i === active}', '+      onClick={() => onPick(i)}>'] },
  { path: 'src/styles/browser.css', add: 4, del: 0, hunk: ['+@container (max-width: 700px) {', '+  .browser { grid-template-columns: 1fr; }', '+  .browser .list { order: 2; }', '+}'] },
  { path: 'tests/browser.test.tsx', add: 5, del: 0, hunk: CODE['tests/browser.test.tsx'].map(l => '+' + l) },
];
const TODOS = ['读懂现有浏览器组件', '抽出 useKeys 键盘钩子', '列表加上 option 语义', '窄屏改为上下排布', '补键盘与窄屏测试', '真实页面截图检查'];
const TERMINAL = ['$ npm run dev', '  VITE v6.0.7  ready in 412 ms', '  ➜  Local:   http://127.0.0.1:5173/', '$ npx vitest run tests/browser.test.tsx', ' ✓ arrow keys move the selection (38ms)', ' ✓ enter opens the selected file (21ms)', ' × narrow layout stacks list under callout', "   → expected 'row' to be 'column'", ' Test Files  1 failed (1)', '      Tests  2 passed | 1 failed (3)'];

export default function EngineeringBench({ file, reduced }: BenchProps) {
  const ws = WORKSPACES[file];
  const [conv, setConv] = useState<number | null>(() => { const c = new URLSearchParams(window.location.search).get('conv'); return c !== null && ws.convs[+c] ? +c : null; });
  useEffect(() => { const url = new URL(window.location.href); if (conv === null) url.searchParams.delete('conv'); else url.searchParams.set('conv', String(conv)); window.history.replaceState(null, '', url.pathname + url.search); }, [conv]);
  return conv === null ? <WorkspaceView ws={ws} onOpen={setConv} /> : <Ide ws={ws} conv={ws.convs[conv]} reduced={reduced} onBack={() => setConv(null)} onSwitch={setConv} />;
}

/* ── Workspace: the folder, its conversations as files ── */
function WorkspaceView({ ws, onOpen }: { ws: Workspace; onOpen: (index: number) => void }) {
  const [filter, setFilter] = useState<'all' | ConvState>('all');
  const shown = ws.convs.map((c, i) => [c, i] as const).filter(([c]) => filter === 'all' || c.state === filter);
  return <div className="en-ws">
    <aside className="p en-ws-info">
      <header className="p-h"><b>工作区</b><span>WORKSPACE</span></header>
      <div className="p-body en-ws-body">
        <div className="en-folder"><i /><div><b>{ws.name}</b><small className="mono" title={ws.path}>{ws.path.replace('~/Documents/', '…/')}</small></div></div>
        <dl className="kv"><dt>分支</dt><dd className="mono">⎇ {ws.branch}</dd><dt>预览</dt><dd className="mono">{ws.preview}</dd><dt>技术栈</dt><dd>{ws.stack.map(s => <span key={s} className="chip">{s}</span>)}</dd></dl>
        <h4>连接</h4>
        <ul className="en-conns">{ws.conns.map(c => <li key={c.name}><span className={`dot ${c.state === 'ok' ? 'ok' : c.state === 'fail' ? 'fail' : 'idle'}`} /><div><b>{c.name}</b><small>{c.kind} · {c.detail}</small></div></li>)}</ul>
        <h4>环境</h4>
        <ul className="en-env mono"><li>NODE_ENV<span>development</span></li><li>DATABASE_URL<span>••••••••</span></li><li>OPENMAIC_URL<span>http://localhost:4290</span></li></ul>
      </div>
    </aside>
    <section className="en-ws-main">
      <header className="en-ws-head"><div><span className="chip ink">FOLDER</span><h2>{ws.name}</h2><p>每一份文件是这个工作区里的一次对话。点开即进入工作台，代码、预览与进度都接着上次继续。</p></div>
        <div className="seg">{(['all', 'active', 'review', 'done', 'paused'] as const).map(f => <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f === 'all' ? '全部' : STATE[f]}</button>)}</div></header>
      <div className="en-files">
        {shown.map(([c, i]) => <button key={c.id} className="en-file" data-state={c.state} onClick={() => onOpen(i)}>
          <span className="en-file-tab mono">{c.id}</span>
          <span className="en-file-state"><span className={`dot ${c.state === 'active' ? 'run' : c.state === 'done' ? 'ok' : 'idle'}`} />{STATE[c.state]}</span>
          <b>{c.title}</b><p>{c.summary}</p>
          <span className="en-file-prog" aria-label={`计划 ${PROGRESS[c.state]}/${TODOS.length}`}>{TODOS.map((t, k) => <i key={t} data-on={k < PROGRESS[c.state] || undefined} data-now={(c.state === 'active' && k === PROGRESS[c.state]) || undefined} />)}<small className="mono">{PROGRESS[c.state]}/{TODOS.length}</small></span>
          <span className="en-file-foot mono"><span>{c.turns} 轮</span><span>{c.changed} 个文件改动</span><span>{c.updated}</span></span>
        </button>)}
        <button className="en-file en-file-new" onClick={() => onOpen(0)} disabled title="新对话需要接入模型服务"><span>＋</span><b>新对话</b><p>从一个目标开始，AI 会先读工作区再给出计划。</p><small>预览中未接入模型</small></button>
      </div>
      <section className="en-ws-arch"><header><b>工作区结构 · ARCHIFY</b><span>所有对话共享这一份结构</span></header><Archify /></section>
    </section>
    <aside className="p en-ws-side">
      <header className="p-h"><b>工作区动态</b><span>ACTIVITY</span></header>
      <ol className="p-body en-activity">{[['刚才', 'C-02', '运行测试 · 2 通过 1 失败'], ['12 分钟前', 'C-02', '新增 useKeys.ts'], ['今天 11:20', 'C-03', '提交检查点 #4，等待审阅'], ['今天 10:05', 'C-03', '修改 workbench-shell.css'], ['10-06', 'C-01', '对话完成 · 14 个文件'], ['10-02', 'C-04', '暂停：等待课程接口']].map(([t, id, text], i) => <li key={i}><time>{t}</time><span className="mono">{id}</span>{text}</li>)}</ol>
    </aside>
  </div>;
}

/* ── IDE: one conversation, in four numbered panels ──────────────────────
 * 01 the front end under construction at any width (or the explorer), 02 the
 * agent's execution trace grouped by plan step, 03 the module graph with
 * diff, terminal and checks, 04 the development assistant with its plan and
 * approval gate. Trace events and modules are linked both ways. */
type EvKind = 'user' | 'agent' | 'read' | 'edit' | 'run' | 'check' | 'checkpoint' | 'gate';
interface Ev { id: string; seq: number; step: number; kind: EvKind; title: string; text?: string; detail?: string[]; module?: string; at: string }
const EV_LABEL: Record<EvKind, string> = { user: '开发者', agent: 'ReinLab Agent', read: 'Read', edit: 'Edit', run: 'Run', check: 'Check', checkpoint: '检查点', gate: '审批' };
const EV_MARK: Record<EvKind, string> = { user: '人', agent: 'AI', read: 'R', edit: 'E', run: '▸', check: '✓', checkpoint: '#', gate: '◆' };
interface Mod { id: string; layer: string; files: string[]; deps: string[]; hot: boolean; note: string }
const MODULES: Mod[] = [
  { id: 'ArchiveBrowser', layer: '界面', files: ['src/components/ArchiveBrowser.tsx'], deps: ['useKeys', 'ArchiveList', 'FileCallout', 'archives.ts'], hot: true, note: '档案浏览器的容器：排序、选中与进入。' },
  { id: 'useKeys', layer: '状态', files: ['src/components/useKeys.ts'], deps: [], hot: true, note: '新增的键盘钩子，替代 window.onkeydown。' },
  { id: 'ArchiveList', layer: '界面', files: ['src/components/ArchiveList.tsx'], deps: ['browser.css'], hot: true, note: '编号列表，加上了 listbox / option 语义。' },
  { id: 'FileCallout', layer: '界面', files: ['src/components/FileCallout.tsx'], deps: ['browser.css'], hot: false, note: '大号编号与目的，只读。' },
  { id: 'browser.css', layer: '样式', files: ['src/styles/browser.css'], deps: [], hot: true, note: '容器查询：700px 以下上下排布。' },
  { id: 'archives.ts', layer: '数据', files: ['src/data/archives.ts'], deps: [], hot: false, note: '档案数据，未改动。' },
];
const GRAPH: Record<string, [number, number]> = { ArchiveBrowser: [66, 108], useKeys: [200, 24], ArchiveList: [200, 80], FileCallout: [200, 136], 'archives.ts': [200, 192], 'browser.css': [334, 108] };
const MOD_MARK: Record<string, 'M' | 'A'> = { ArchiveBrowser: 'M', ArchiveList: 'M', useKeys: 'A', 'browser.css': 'M' };
const FIX = { path: 'src/styles/browser.css', add: 3, del: 1, hunk: ['-.browser .list { flex-direction: row; }', '+@container (min-width: 701px) {', '+  .browser .list { flex-direction: row; }', '+}'] };
const FIXED_AT = 5; // TODO index after which the narrow layout is fixed
let evSeq = 0;
/** A clock time some minutes before now, so the seeded history sits just behind live events. */
const ago = (minutes: number) => { const d = new Date(Date.now() - minutes * 60000); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const ev = (kind: EvKind, title: string, extra: Partial<Ev> = {}): Ev => ({ id: `ev${++evSeq}`, seq: evSeq, step: 0, kind, title, at: extra.at ?? now(), ...extra });
const pad2 = (n: number) => String(n).padStart(2, '0');
function initialTrace(conv: Conv): Ev[] {
  evSeq = 0;
  return [
    ev('user', `${conv.title}：列表要能用上下键选择、回车进入；700px 以下改成上下排布。`, { at: ago(9) }),
    ev('read', 'src/components/ArchiveBrowser.tsx', { module: 'ArchiveBrowser', at: ago(9), detail: CODE['src/components/ArchiveBrowser.tsx'].slice(0, 5) }),
    ev('read', 'src/styles/browser.css', { module: 'browser.css', at: ago(9) }),
    ev('agent', '计划 · 6 项 TODO', { text: '键盘事件直接挂在 window.onkeydown 上，会和别的页面冲突。先抽 useKeys，再补列表语义，最后处理窄屏。', at: ago(8) }),
    ev('edit', 'src/components/useKeys.ts', { step: 1, module: 'useKeys', at: ago(6), detail: DIFFS[0].hunk }),
    ev('edit', 'src/components/ArchiveBrowser.tsx', { step: 1, module: 'ArchiveBrowser', at: ago(5), detail: DIFFS[1].hunk }),
    ev('edit', 'src/components/ArchiveList.tsx', { step: 2, module: 'ArchiveList', at: ago(4), detail: DIFFS[2].hunk }),
    ev('edit', 'src/styles/browser.css', { step: 3, module: 'browser.css', at: ago(4), detail: DIFFS[3].hunk }),
    ev('run', 'npx vitest run tests/browser.test.tsx', { step: 4, at: ago(3), detail: TERMINAL.slice(3) }),
    ev('agent', '窄屏测试未通过', { step: 4, text: '容器查询已生效，但列表仍是横向。正在查是哪条样式覆盖了它。', module: 'browser.css', at: ago(3) }),
  ];
}
type Lower = 'archify' | 'diff' | 'terminal' | 'checks';
function PanelHead({ n, title, sub, children }: { n: string; title: string; sub: string; children?: ReactNode }) {
  return <header className="eg-head"><span className="eg-num">{n}</span><div><b>{title}</b><small>{sub}</small></div><div className="eg-head-tools">{children}</div></header>;
}
type Talk = { who: 'me' | 'ai'; text: string; at: string };

function Ide({ ws, conv, reduced, onBack, onSwitch }: { ws: Workspace; conv: Conv; reduced: boolean; onBack: () => void; onSwitch: (i: number) => void }) {
  const [done, setDone] = useState(conv.state === 'done' ? TODOS.length : conv.state === 'review' ? FIXED_AT : 4);
  const [left, setLeft] = useState<'preview' | 'explorer'>('preview');
  const [wide, setWide] = useState(false);
  const [vw, setVw] = useState<number | 'fit'>('fit');
  const [overlay, setOverlay] = useState(false);
  const [flash, setFlash] = useState(0);
  const [lower, setLower] = useState<Lower>('archify');
  const [mod, setMod] = useState('browser.css');
  const [modTab, setModTab] = useState<'overview' | 'files' | 'diff' | 'events'>('overview');
  const [pick, setPick] = useState(false);
  const [refs, setRefs] = useState<string[]>([]);
  const [trace, setTrace] = useState<Ev[]>(() => initialTrace(conv));
  const [filter, setFilter] = useState<'all' | 'tool' | 'edit' | 'check'>('all');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [mode, setMode] = useState<'plan' | 'act'>('act');
  const [approve, setApprove] = useState(true);
  const [pending, setPending] = useState<typeof FIX | null>(null);
  const [planOpen, setPlanOpen] = useState(true);
  const [diff, setDiff] = useState(3);
  const [checkpoints, setCheckpoints] = useState(['#1 读完组件', '#2 抽出 useKeys', '#3 列表语义']);
  const [checks, setChecks] = useState<{ name: string; state: 'ok' | 'fail' | 'run' }[]>(() => [{ name: 'vitest · browser.test.tsx', state: conv.state === 'active' || conv.state === 'paused' ? 'fail' : 'ok' }, { name: 'tsc --noEmit', state: 'ok' }, { name: 'eslint src', state: 'ok' }, { name: 'playwright · 390px 截图', state: 'ok' }]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [talk, setTalk] = useState<Talk[]>([{ who: 'ai', at: ago(3), text: `接着「${conv.title}」。键盘与列表语义已完成，窄屏测试还差一项：把 01 拉到 700px 以下就能看到列表仍横向排开。可以直接让我修，也可以在预览里点选元素再说明。` }]);
  const fixed = done >= FIXED_AT;
  const nowTodo = Math.min(done, TODOS.length - 1);
  const module = MODULES.find(m => m.id === mod)!;
  const shown = trace.filter(e => (filter === 'all' || (filter === 'tool' ? ['read', 'edit', 'run'].includes(e.kind) : filter === 'edit' ? e.kind === 'edit' : ['run', 'check', 'checkpoint', 'gate'].includes(e.kind))) && (e.title + (e.text ?? '')).toLowerCase().includes(query.toLowerCase()));
  const failing = checks.some(c => c.state === 'fail');
  const live = busy ? [...trace].reverse().find(e => e.module)?.module : undefined;
  const stream = useRef<HTMLDivElement>(null);
  useEffect(() => { stream.current?.scrollTo({ top: stream.current.scrollHeight, behavior: reduced ? 'auto' : 'smooth' }); }, [trace.length, reduced]);
  const talkRef = useRef<HTMLDivElement>(null);
  useEffect(() => { talkRef.current?.scrollTo({ top: talkRef.current.scrollHeight, behavior: reduced ? 'auto' : 'smooth' }); }, [talk.length, pending, reduced]);
  const mk = (kind: EvKind, title: string, extra: Partial<Ev> = {}) => ev(kind, title, { step: nowTodo, ...extra });
  const say = (text: string) => setTalk(t => [...t, { who: 'ai', at: now(), text }]);

  function send(text = draft) {
    if (!text.trim() || busy || pending) return;
    const withRefs = refs.length ? `${text}（引用 ${refs.join('、')}）` : text;
    setTalk(t => [...t, { who: 'me', text: withRefs, at: now() }]); setTrace(t => [...t, mk('user', withRefs)]);
    setDraft(''); setRefs([]); setBusy(true);
    let steps: Ev[]; let reply: string; let after: (() => void) | undefined;
    if (/解释|为什么|说明|讲讲/.test(text)) {
      steps = [mk('read', 'src/components/useKeys.ts', { module: 'useKeys', detail: CODE['src/components/useKeys.ts'] }), mk('agent', '解释 useKeys', { module: 'useKeys', text: '原来的键盘处理直接赋值给 window.onkeydown，后挂上的页面会把前一个覆盖掉。useKeys 随组件挂载注册、卸载移除，只响应上下键和回车，并阻止页面滚动。' })];
      reply = '解释写在 02 里了：useKeys 把全局的 onkeydown 换成了随组件挂载、卸载的监听。没有改动文件。';
    } else if (mode === 'plan') {
      steps = [mk('read', 'src/styles/browser.css', { module: 'browser.css' }), mk('agent', '计划', { module: 'browser.css', text: fixed ? '下一步：在 390 与 1280 两个宽度截图，与基线比对。' : '把 .browser .list 的横向规则移进 min-width: 701px 的容器查询，再补一项截图检查。切到“执行”后我再动文件。' })];
      reply = '计划已写在 02 里，切到“执行”后我再改文件。';
    } else if (!fixed) {
      steps = [mk('read', 'src/styles/browser.css', { module: 'browser.css' }),
        mk('agent', '找到原因', { module: 'browser.css', text: '.browser .list 的横向规则写在容器查询外面，窄屏时仍然生效。把它移进 min-width: 701px 的容器查询。' }),
        mk('run', '沙盒 · npx vitest run tests/browser.test.tsx', { detail: [' ✓ arrow keys move the selection (36ms)', ' ✓ enter opens the selected file (19ms)', ' ✓ narrow layout stacks list under callout (24ms)', '      Tests  3 passed (3)'] }),
        ...(approve ? [mk('gate', '等待审批 · 写入 src/styles/browser.css', { module: 'browser.css', text: '改动已在沙盒中通过测试，写入工作区前需要你在 04 确认。' })] : [])];
      reply = approve ? '找到了：横向规则写在容器查询外面。改动在沙盒里通过了三项测试，等你在下方批准后写入。' : '找到了：横向规则写在容器查询外面。人工审批已关闭，直接写入并刷新了预览。';
      after = approve ? () => setPending(FIX) : () => apply(false);
    } else if (done < TODOS.length) {
      steps = [mk('run', 'npx playwright test shots --project=390,1280', { detail: [' ✓ 390px  与基线一致', ' ✓ 1280px 与基线一致', '   2 passed (4.1s)'] }), mk('check', '真实页面截图检查通过')];
      reply = '390 与 1280 两张截图都和基线一致，TODO 全部完成。可以让我整理本次改动。';
      after = () => setDone(TODOS.length);
    } else {
      steps = [mk('agent', '整理本次对话', { text: '改动 5 个文件：新增 useKeys 与测试，列表加 option 语义，容器查询修正窄屏。检查 4/4 通过。' })];
      reply = '整理好了，写在 02 的最后一条。预览中不会把它写成文件。';
    }
    const gap = reduced ? 0 : 420;
    steps.forEach((step, i) => window.setTimeout(() => setTrace(t => [...t, step]), gap * (i + 1)));
    window.setTimeout(() => { setBusy(false); after?.(); say(reply); }, gap * (steps.length + 1));
  }
  function apply(approved: boolean) {
    setPending(null);
    setTrace(t => [...t, mk('edit', 'src/styles/browser.css', { module: 'browser.css', text: approved ? '已批准 · 写入工作区（预演）' : '自动写入（预演）', detail: FIX.hunk })]);
    setDone(d => Math.max(d, FIXED_AT));
    setChecks(c => c.map(k => k.name.startsWith('vitest') ? { ...k, state: 'ok' } : k));
    setCheckpoints(c => [...c, `#${c.length + 1} ${TODOS[4]}`]);
    setFlash(f => f + 1);
    if (approved) say('已写入。01 的预览刚刚热更新，窄屏下列表已经竖排。下一项：真实页面截图检查。');
  }
  function reject() {
    setPending(null);
    setTrace(t => [...t, mk('agent', '已驳回', { module: 'browser.css', text: '沙盒里的改动已丢弃，工作区保持原样。' })]);
    say('好的，改动已丢弃。可以告诉我换个思路，或者在 01 里点选要改的元素。');
  }
  function narrow() {
    setLeft('preview'); setVw(390);
    setTrace(t => [...t, mk('agent', '预览调到 390px', { module: 'browser.css', text: fixed ? '列表已在说明下方竖排。' : '列表仍然横向排开，就是失败的那项测试。' })]);
    say(fixed ? '01 已调到 390px：列表在说明下方竖排，和测试一致。' : '01 已调到 390px：列表仍横向排开，这就是失败的那项测试。要我修吗？');
  }
  function rerun() { setChecks(c => c.map(k => ({ ...k, state: 'run' }))); setTrace(t => [...t, mk('check', '重新运行检查（预演）')]); window.setTimeout(() => setChecks(c => c.map(k => ({ ...k, state: k.name.startsWith('vitest') && !fixed ? 'fail' : 'ok' }))), reduced ? 0 : 1200); }
  function checkpoint() { const name = `#${checkpoints.length + 1} 手动检查点`; setCheckpoints(c => [...c, name]); setTrace(t => [...t, mk('checkpoint', name)]); }
  function jump(e: Ev) { setFilter('all'); setQuery(''); setOpen(e.detail ? e.id : null); if (e.module) setMod(e.module); requestAnimationFrame(() => document.getElementById(`eg-${e.id}`)?.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' })); }
  const quick: [string, () => void][] = !fixed ? [['修复窄屏测试', () => send('修复窄屏测试')], ['把预览拉到 390 看看', narrow], ['解释 useKeys 的改动', () => send('解释 useKeys 的改动')]]
    : done < TODOS.length ? [['做真实页面截图检查', () => send('做真实页面截图检查')], ['把预览拉到 390 看看', narrow]] : [['整理本次改动', () => send('整理本次改动')]];

  return <div className="eg" data-wide={wide || undefined}>
    <div className="eg-bar">
      <button className="eg-back" onClick={onBack}>← {ws.name}</button>
      <span className="eg-conv"><em className="mono">{conv.id}</em><b>{conv.title}</b></span>
      <button className="eg-todo" onClick={() => setPlanOpen(true)} title={TODOS.map((t, i) => `${i < done ? '✓' : '·'} ${t}`).join('\n')}>
        {TODOS.map((t, i) => <i key={t} data-state={i < done ? 'done' : i === nowTodo && done < TODOS.length ? 'now' : 'todo'} />)}
        <span className="num">{done}/{TODOS.length}</span><small>{done < TODOS.length ? TODOS[nowTodo] : '全部完成'}</small>
      </button>
      <span className="eg-bar-gap" />
      {pending && <span className="chip gold eg-pending">◆ 1 项待审批</span>}
      <span className="eg-model mono">reinlab-agent</span>
      <span className="seg" aria-label="模式">{([['plan', '计划'], ['act', '执行']] as const).map(([m, n]) => <button key={m} aria-pressed={mode === m} onClick={() => setMode(m)}>{n}</button>)}</span>
      <button className="b" aria-pressed={approve} onClick={() => setApprove(v => !v)} title="写入文件前需要你确认">{approve ? '◆ 人工审批' : '◇ 自动写入'}</button>
      <button className="b" onClick={checkpoint}>存检查点</button>
      <button className="b solid" onClick={rerun}>▶ 运行检查</button>
    </div>

    <section className="eg-panel eg-p1">
      <PanelHead n="01" title={left === 'preview' ? '前端预览' : '资源管理器'} sub={left === 'preview' ? 'FRONTEND · PREVIEW' : 'FILES · CONNECTIONS'}>
        <span className="seg">{([['preview', '预览'], ['explorer', '资源']] as const).map(([k, n]) => <button key={k} aria-pressed={left === k} onClick={() => setLeft(k)}>{n}</button>)}</span>
        <button className="b eg-icon" aria-pressed={wide} onClick={() => setWide(v => !v)} title={wide ? '还原四栏' : '放大到 01 + 02 的位置'} aria-label={wide ? '还原四栏' : '放大预览'}>{wide ? '⤡' : '⤢'}</button>
      </PanelHead>
      {left === 'preview' ? <Preview host={ws.preview.replace('http://', '')} vw={vw} setVw={setVw} pick={pick} setPick={setPick} overlay={overlay} setOverlay={setOverlay} bug={!fixed} flash={flash} refs={refs.length}
        onPick={el => { setRefs(r => r.includes(el) ? r : [...r, el]); setPick(false); }} />
        : <div className="eg-explorer scroll-thin">
        <Section title="文件" note={`${DIFFS.length} 改动`}><ul className="en-tree">{TREE.map(n => <Tree key={n.path} node={n} depth={0} active={module.files[0]} onOpen={path => { const m = MODULES.find(x => x.files.includes(path)); if (m) { setMod(m.id); setModTab('files'); setLower('archify'); } }} />)}</ul></Section>
        <Section title="连接" note={String(ws.conns.length)}><ul className="en-conns compact">{ws.conns.map(c => <li key={c.name}><span className={`dot ${c.state === 'ok' ? 'ok' : 'idle'}`} /><div><b>{c.name}</b><small>{c.kind} · {c.detail}</small></div></li>)}</ul></Section>
        <Section title="同工作区对话" note={String(ws.convs.length)}><ul className="en-siblings">{ws.convs.map((c, i) => <li key={c.id}><button aria-current={c === conv || undefined} onClick={() => onSwitch(i)}><span className="mono">{c.id}</span>{c.title}<span className={`dot ${c.state === 'active' ? 'run' : c.state === 'done' ? 'ok' : 'idle'}`} /></button></li>)}</ul></Section>
        <p className="en-legend"><span><b className="en-m">M</b>改动</span><span><b className="en-a">A</b>新增</span><span><i className="en-read" />AI 已读</span></p>
      </div>}
    </section>

    <section className="eg-panel eg-p2">
      <PanelHead n="02" title="ReinLab Agent" sub="AGENT · EXECUTION"><span className={`chip ${busy ? 'gold' : ''}`}><span className={`dot ${busy ? 'run' : 'ok'}`} />{busy ? '运行中' : pending ? '等待审批' : '已就绪'}</span></PanelHead>
      <div className="eg-filter">
        {([['all', '全部'], ['tool', '工具'], ['edit', '变更'], ['check', '检查']] as const).map(([k, n]) => <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>{n}</button>)}
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索记录" aria-label="搜索执行记录" />
      </div>
      <div className="eg-stream scroll-thin" ref={stream}>
        {shown.map((e, i) => <Fragment key={e.id}>
          {(i === 0 || shown[i - 1].step !== e.step) && <div className="eg-phase" data-state={e.step < done ? 'done' : e.step === nowTodo ? 'now' : 'todo'}><span className="mono">STEP {pad2(e.step + 1)}</span><b>{TODOS[e.step]}</b><em>{e.step < done ? '完成' : e.step === nowTodo ? '进行中' : ''}</em></div>}
          <article id={`eg-${e.id}`} className="eg-ev" data-kind={e.kind} data-linked={e.module === mod || undefined}>
            <i className="eg-ev-mark">{EV_MARK[e.kind]}</i>
            <div className="eg-ev-body">
              <div className="eg-ev-meta"><b>{EV_LABEL[e.kind]}</b><span className="mono">#{pad2(e.seq)}</span><time className="mono">{e.at}</time></div>
              <button className="eg-ev-card" onClick={() => { if (e.module) { setMod(e.module); setLower('archify'); } setOpen(o => o === e.id ? null : e.id); }}>
                <span className={['read', 'edit', 'run'].includes(e.kind) ? 'mono' : ''}>{e.title}</span>
                {e.text && <p>{e.text}</p>}
                {e.module && <small>↳ {e.module}</small>}
                {e.detail && <em>{open === e.id ? '▾ 收起' : '▸ 详情'}</em>}
              </button>
              {open === e.id && e.detail && <pre className="mono eg-ev-detail">{e.detail.map((l, k) => <span key={k} className={l.startsWith('+') || l.includes('✓') ? 'add' : l.startsWith('-') || l.includes('×') ? 'del' : ''}>{l}</span>)}</pre>}
            </div>
          </article>
        </Fragment>)}
        {busy && <div className="eg-ev eg-ev-wait"><i className="eg-ev-mark">…</i><div className="eg-ev-body"><div className="chat-typing"><i /><i /><i /></div></div></div>}
      </div>
      <footer className="eg-foot eg-trace-foot">
        <div className="eg-ticks" aria-label="事件时间线">{trace.map(e => <button key={e.id} data-kind={e.kind} data-linked={e.module === mod || undefined} title={`#${pad2(e.seq)} ${EV_LABEL[e.kind]} · ${e.title}`} aria-label={`跳到 #${e.seq}`} onClick={() => jump(e)} />)}</div>
        <span className="mono">{trace.length} events · {conv.id}</span>
      </footer>
    </section>

    <section className="eg-panel eg-p3">
      <PanelHead n="03" title="结构与变更" sub="ARCHIFY · INSPECTOR">
        <span className="seg">{([['archify', 'Archify'], ['diff', `变更 ${DIFFS.length}`], ['terminal', '终端'], ['checks', failing ? '检查 !' : '检查']] as [Lower, string][]).map(([k, n]) => <button key={k} aria-pressed={lower === k} onClick={() => setLower(k)}>{n}</button>)}</span>
      </PanelHead>
      {lower === 'archify' && <div className="eg-inspect">
        <div className="eg-graph">
          <span className="eg-label">MODULE GRAPH · 导入方向 →</span>
          <ModGraph sel={mod} live={live} onSel={id => { setMod(id); setModTab('overview'); }} />
          <p className="eg-graph-key"><span><i className="k-hot" />本次涉及</span><span><i className="k-sel" />选中</span><span><b className="en-m">M</b>/<b className="en-a">A</b> 改动/新增</span></p>
        </div>
        <div className="eg-node-detail">
          <span className="eg-label">SELECTED MODULE · {module.layer}</span>
          <h3 className="mono">{module.id}{module.hot && <span className="chip gold">已改动</span>}</h3>
          <div className="eg-mini-tabs">{([['overview', '概览'], ['files', '文件'], ['diff', '变更'], ['events', `事件 ${trace.filter(e => e.module === mod).length}`]] as const).map(([k, n]) => <button key={k} aria-selected={modTab === k} onClick={() => setModTab(k)}>{n}</button>)}</div>
          {modTab === 'overview' && <dl className="kv"><dt>说明</dt><dd>{module.note}</dd><dt>导入</dt><dd className="mono">{module.deps.join('、') || '—'}</dd><dt>被导入</dt><dd className="mono">{MODULES.filter(m => m.deps.includes(module.id)).map(m => m.id).join('、') || '—'}</dd><dt>文件</dt><dd className="mono">{module.files[0]}</dd></dl>}
          {modTab === 'files' && <pre className="mono eg-code">{(CODE[module.files[0]] ?? ['// 预览中只收录了本次对话相关的文件']).map((l, i) => <span key={i}><i>{i + 1}</i>{l || ' '}</span>)}</pre>}
          {modTab === 'diff' && <pre className="mono eg-code">{(DIFFS.find(d => d.path === module.files[0])?.hunk ?? ['（无改动）']).map((l, i) => <span key={i} className={l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : ''}>{l}</span>)}</pre>}
          {modTab === 'events' && <ul className="eg-linked">{trace.filter(e => e.module === mod).map(e => <li key={e.id}><button onClick={() => jump(e)}><span className="mono">#{pad2(e.seq)}</span>{EV_LABEL[e.kind]} · {e.title}</button></li>)}</ul>}
        </div>
      </div>}
      {lower === 'diff' && <div className="en-diff">
        <ul className="en-diff-files">{DIFFS.map((d, i) => <li key={d.path}><button aria-pressed={i === diff} onClick={() => setDiff(i)}><span className="mono">{d.path.split('/').pop()}</span><em className="add">+{d.add}</em><em className="del">−{d.del}</em></button></li>)}
          <li className="en-cp-head">检查点</li>{checkpoints.slice().reverse().map((c, i) => <li key={c} className="en-cp"><span>{c}</span>{i > 0 && <button className="b ghost" onClick={() => setTrace(t => [...t, mk('checkpoint', `回滚到 ${c}（预演，未改动文件）`)])}>回滚</button>}</li>)}</ul>
        <pre className="mono">{DIFFS[diff].hunk.map((l, i) => <span key={i} className={l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : ''}>{l}</span>)}</pre>
      </div>}
      {lower === 'terminal' && <pre className="en-term mono">{TERMINAL.map((l, i) => <span key={i} className={l.startsWith('$') ? 'cmd' : l.includes('×') || l.includes('failed') ? 'err' : l.includes('✓') ? 'ok' : ''}>{l}</span>)}</pre>}
      {lower === 'checks' && <div className="en-checks"><ul>{checks.map(c => <li key={c.name}><span className={`dot ${c.state === 'ok' ? 'ok' : c.state === 'run' ? 'run' : 'fail'}`} /><span className="mono">{c.name}</span><em>{c.state === 'ok' ? '通过' : c.state === 'run' ? '运行中' : '失败'}</em></li>)}</ul><button className="b" onClick={rerun}>重新运行（预演）</button></div>}
    </section>

    <section className="eg-panel eg-p4">
      <PanelHead n="04" title="开发助手" sub="REINLAB AGENT · DEVELOP"><span className={`chip ${pending ? 'gold' : ''}`}>{pending ? '待你审批' : mode === 'plan' ? '只出计划' : approve ? '写入需审批' : '自动写入'}</span></PanelHead>
      <div className="eg-scope"><span><i className="dot ok" />{ws.name}</span><span className="mono">⎇ {ws.branch} · {conv.id}</span></div>
      <section className="eg-plan">
        <button className="eg-plan-h" aria-expanded={planOpen} onClick={() => setPlanOpen(v => !v)}><span className="mono">PLAN</span><b className="num">{done}/{TODOS.length}</b><em>{done < TODOS.length ? TODOS[nowTodo] : '全部完成'}</em><i>{planOpen ? '▾' : '▸'}</i></button>
        {planOpen && <ol className="eg-todo-list">{TODOS.map((t, i) => <li key={t} data-state={i < done ? 'done' : i === nowTodo && done < TODOS.length ? 'now' : 'todo'}><i /><span className="mono">{pad2(i + 1)}</span>{t}</li>)}</ol>}
      </section>
      <div className="eg-talk scroll-thin" ref={talkRef}>
        {talk.map((m, i) => <div key={i} className="eg-msg" data-who={m.who}><time className="mono">{m.who === 'ai' ? 'AGENT' : 'YOU'} · {m.at}</time><p>{m.text}</p></div>)}
        {busy && <div className="eg-msg" data-who="ai"><div className="chat-typing"><i /><i /><i /></div></div>}
        {pending && <div className="eg-gate" role="group" aria-label="待审批的写入">
          <header><span>◆</span><b>待审批 · 写入 1 个文件</b><small className="mono">沙盒测试 3/3</small></header>
          <div className="eg-gate-file mono">{pending.path}<em className="add">+{pending.add}</em><em className="del">−{pending.del}</em></div>
          <pre className="mono">{pending.hunk.map((l, i) => <span key={i} className={l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : ''}>{l}</span>)}</pre>
          <div className="eg-gate-act"><button className="b solid" onClick={() => apply(true)}>批准写入</button><button className="b" onClick={reject}>驳回</button><small>预演：只更新本页示例状态</small></div>
        </div>}
      </div>
      <div className="eg-quick">{quick.map(([label, act]) => <button key={label} onClick={act} disabled={busy || !!pending}>{label}</button>)}</div>
      <form className="eg-composer" onSubmit={e => { e.preventDefault(); send(); }}>
        {refs.length > 0 && <div className="en-chipline">{refs.map(r => <span key={r} className="chip gold">⌖ {r}<button type="button" aria-label={`移除 ${r}`} onClick={() => setRefs(x => x.filter(y => y !== r))}>×</button></span>)}</div>}
        <textarea rows={2} value={draft} onChange={e => setDraft(e.target.value)} placeholder={pending ? '先处理上方的审批' : '描述要做的修改，或在 01 里点选元素'} aria-label="给开发助手发消息" onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
        <div><small>↵ 发送 · Shift ↵ 换行 · 本地预演</small><button type="submit" disabled={!draft.trim() || busy || !!pending} aria-label="发送">↑</button></div>
      </form>
    </section>

    <footer className="eg-status mono"><span><i className="dot ok" />dev · {ws.preview.replace('http://', '')}</span><span>⎇ {ws.branch}</span><span>{DIFFS.length} 处改动</span><span className={failing ? 'eg-bad' : ''}>检查 {checks.filter(c => c.state === 'ok').length}/{checks.length}</span><span className="eg-bar-gap" /><span>示例数据 · 不连接模型 · 不改动真实文件</span></footer>
  </div>;
}

/** Module graph laid out by import direction; hot modules tinted, the agent's current module ringed. */
function ModGraph({ sel, live, onSel }: { sel: string; live?: string; onSel: (id: string) => void }) {
  const edges = MODULES.flatMap(m => m.deps.map(d => [m.id, d] as const));
  return <svg className="eg-mg" viewBox="0 0 400 216" role="group" aria-label="模块依赖图">
    <defs><marker id="eg-arrow" viewBox="0 0 6 6" refX="6" refY="3" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L6 3L0 6z" /></marker></defs>
    {edges.map(([a, b]) => { const into = edges.filter(e => e[1] === b), k = into.findIndex(e => e[0] === a); const [x1, y1] = GRAPH[a], [x2, cy] = GRAPH[b]; const y2 = cy + (k - (into.length - 1) / 2) * 9; const sx = x1 + 56, ex = x2 - 58, mx = (sx + ex) / 2; return <path key={a + b} className="eg-mg-edge" d={`M${sx} ${y1} C${mx} ${y1} ${mx} ${y2} ${ex} ${y2}`} data-on={a === sel || b === sel || undefined} markerEnd="url(#eg-arrow)" />; })}
    {MODULES.map(m => { const [x, y] = GRAPH[m.id]; return <g key={m.id} className="eg-mg-node" data-hot={m.hot || undefined} data-sel={m.id === sel || undefined} data-live={m.id === live || undefined} transform={`translate(${x - 56} ${y - 13})`}
      role="button" tabIndex={0} aria-pressed={m.id === sel} aria-label={m.id} onClick={() => onSel(m.id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSel(m.id); } }}>
      {m.id === live && <rect className="eg-mg-live" x="-4" y="-4" width="120" height="34" />}
      <rect width="112" height="26" /><text x="8" y="17">{m.id}</text>{MOD_MARK[m.id] && <text className="eg-mg-badge" x="105" y="17" textAnchor="end">{MOD_MARK[m.id]}</text>}
    </g>; })}
  </svg>;
}

/** The page under construction at a chosen viewport width, scaled to fit the panel. */
const PRESETS: [number | 'fit', string][] = [['fit', '适应'], [1280, '1280'], [768, '768'], [390, '390']];
const VW_MIN = 320, VW_MAX = 1440, BREAK = 700;
function Preview({ host, vw, setVw, pick, setPick, overlay, setOverlay, bug, flash, refs, onPick }: { host: string; vw: number | 'fit'; setVw: (v: number | 'fit') => void; pick: boolean; setPick: (f: (v: boolean) => boolean) => void; overlay: boolean; setOverlay: (f: (v: boolean) => boolean) => void; bug: boolean; flash: number; refs: number; onPick: (el: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 320, h: 420 });
  useEffect(() => {
    const el = box.current; if (!el) return;
    const ro = new ResizeObserver(([entry]) => setSize({ w: Math.max(200, Math.floor(entry.contentRect.width)), h: Math.max(200, Math.floor(entry.contentRect.height)) }));
    ro.observe(el); return () => ro.disconnect();
  }, []);
  const width = vw === 'fit' ? size.w : vw;
  const scale = Math.min(1, size.w / width);
  const pos = (x: number) => `${Math.min(100, Math.max(0, (x - VW_MIN) / (VW_MAX - VW_MIN) * 100))}%`;
  return <>
    <div className="eg-browser"><span className="mono">{host}/archive</span>
      <span className="eg-vw mono" data-narrow={width < BREAK || undefined}>{width}px{scale < 1 ? ` · ${Math.round(scale * 100)}%` : ''}</span>
      <button className="b eg-icon" aria-pressed={overlay} onClick={() => setOverlay(v => !v)} title="标出本次对话改动过的区域" aria-label="标出改动区域">◫</button>
      <button className="b eg-icon" aria-pressed={pick} onClick={() => setPick(v => !v)} title="点选页面元素，作为引用发给 04" aria-label="点选元素">⌖</button></div>
    <div className="eg-ruler">
      <span className="seg">{PRESETS.map(([v, n]) => <button key={n} aria-pressed={vw === v} onClick={() => setVw(v)}>{n}</button>)}</span>
      <div className="eg-scale">
        <i className="eg-bp" style={{ left: pos(BREAK) }}><span className="mono">{BREAK} · @container</span></i>
        <i className="eg-cur" style={{ left: pos(width) }} />
        <input type="range" min={VW_MIN} max={VW_MAX} step={10} value={Math.min(VW_MAX, Math.max(VW_MIN, width))} onChange={e => setVw(+e.target.value)} aria-label="预览宽度" />
      </div>
    </div>
    <div className="eg-stage" ref={box}>
      <div className="eg-frame" data-phone={width <= 430 || undefined} style={{ width: Math.round(width * scale), height: size.h }}>
        <div className="eg-viewport" style={{ width, height: size.h / scale, transform: `scale(${scale})` }}><MiniApp pick={pick} overlay={overlay} bug={bug} onPick={onPick} /></div>
        {flash > 0 && <span key={flash} className="eg-hmr"><b className="mono">HMR · browser.css 已更新</b></span>}
      </div>
    </div>
    <footer className="eg-foot"><span className="dot ok" />预览已连接 · HMR<span>{refs ? `已选 ${refs} 个元素` : bug ? '窄于 700px 时列表仍横排' : '⌖ 可点选元素'}</span></footer>
  </>;
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return <div className="en-sec"><button className="en-sec-h" aria-expanded={open} onClick={() => setOpen(v => !v)}><b>{open ? '▾' : '▸'}</b>{title}<span>{note}</span></button>{open && children}</div>;
}
function Tree({ node, depth, active, onOpen }: { node: TreeNode; depth: number; active: string; onOpen: (path: string) => void }) {
  const [open, setOpen] = useState(depth < 2);
  return <li>
    <button className="en-node" style={{ paddingLeft: 10 + depth * 13 }} aria-current={active === node.path || undefined} onClick={() => node.dir ? setOpen(v => !v) : onOpen(node.path)} title={node.path}>
      <span className="en-node-ico">{node.dir ? (open ? '▾' : '▸') : '·'}</span><span className="en-node-name">{node.name}</span>{node.read && <i className="en-read" title="AI 已读" />}{node.mark && <b className={node.mark === 'M' ? 'en-m' : 'en-a'}>{node.mark}</b>}
    </button>
    {node.dir && open && <ul>{node.children!.map(c => <Tree key={c.path} node={c} depth={depth + 1} active={active} onOpen={onOpen} />)}</ul>}
  </li>;
}

/** The front end under construction. Elements carry names the AI can be pointed at;
 *  `bug` keeps the list horizontal below 700px until the fix is written. */
function MiniApp({ pick, overlay, bug, onPick }: { pick: boolean; overlay: boolean; bug: boolean; onPick: (el: string) => void }) {
  const [sel, setSel] = useState(0);
  const files = ['CURR 学科课程工作室', 'RSCH 实验研究工作台', 'ENGR 工程开发工作台', 'CRTV 创作工作台', 'AUTO 自动化工作台', 'EXPL 规划探索工作台', 'DATA 数据工程实验台'];
  const tag = (name: string) => pick ? { 'data-el': name, onClickCapture: (e: { preventDefault: () => void; stopPropagation: () => void }) => { e.preventDefault(); e.stopPropagation(); onPick(name); } } : {};
  return <div className="mini" data-pick={pick || undefined} data-overlay={overlay || undefined} data-bug={bug || undefined}>
    <header {...tag('header.bar')}><b>RHINE LAB</b><span>ARCHIVE BROWSER</span></header>
    <div className="mini-body" data-chg="M  ArchiveBrowser · browser.css">
      <ol className="mini-list" role="listbox" data-chg="M  ArchiveList · option" {...tag('ArchiveList')}>{files.map((f, i) => <li key={f} role="option" aria-selected={i === sel} onClick={() => setSel(i)}><em>{f.slice(0, 4)}</em>{f.slice(5)}</li>)}</ol>
      <section className="mini-callout" {...tag('FileCallout')}><small>FILE</small><h1 {...tag('h1.file-no')}>X—{String(sel + 13).padStart(3, '0')}</h1><h2>{files[sel].slice(5)}</h2><button {...tag('button.access')}>ACCESS →</button></section>
    </div>
  </div>;
}

function Archify() {
  const [mode, setMode] = useState<'layers' | 'deps'>('layers');
  const layers = useMemo(() => [
    { name: '界面', items: [['ArchiveBrowser', true], ['ArchiveList', true], ['FileCallout', false], ['WorkbenchShell', false]] },
    { name: '状态', items: [['useKeys', true], ['useArchive', false], ['session', false]] },
    { name: '服务', items: [['courseApi', false], ['modelTools', false], ['openMaicPortal', false]] },
    { name: '数据', items: [['reinlab_dev', false], ['course-cache', false], ['archives.ts', false]] },
  ] as { name: string; items: [string, boolean][] }[], []);
  return <div className="en-archify">
    <div className="en-archify-tools"><span className="seg">{([['layers', '分层'], ['deps', '依赖']] as const).map(([m, n]) => <button key={m} aria-pressed={mode === m} onClick={() => setMode(m)}>{n}</button>)}</span><span><i className="en-touch" />本次对话涉及</span><small>按导入关系生成 · 示意</small></div>
    {mode === 'layers' ? <div className="en-layers">{layers.map((l, li) => <div key={l.name} className="en-layer"><span className="mono">L{li + 1} · {l.name}</span><div>{l.items.map(([n, hot]) => <b key={n} data-hot={hot || undefined}>{n}</b>)}</div></div>)}</div>
      : <svg className="en-deps" viewBox="0 0 640 170" role="img" aria-label="模块依赖示意">
        {[[90, 40, 250, 40], [90, 40, 250, 120], [250, 40, 420, 40], [250, 120, 420, 120], [420, 40, 580, 80], [420, 120, 580, 80]].map(([a, b, c, d], i) => <path key={i} d={`M${a + 50} ${b} C ${(a + c) / 2 + 25} ${b}, ${(a + c) / 2 + 25} ${d}, ${c - 50} ${d}`} />)}
        {[['ArchiveBrowser', 90, 40, true], ['useKeys', 250, 40, true], ['ArchiveList', 250, 120, true], ['useArchive', 420, 40, false], ['archives.ts', 420, 120, false], ['reinlab_dev', 580, 80, false]].map(([n, x, y, hot]) => <g key={n as string} data-hot={hot || undefined}><rect x={(x as number) - 50} y={(y as number) - 14} width="100" height="28" /><text x={x as number} y={(y as number) + 4} textAnchor="middle">{n as string}</text></g>)}
      </svg>}
  </div>;
}
