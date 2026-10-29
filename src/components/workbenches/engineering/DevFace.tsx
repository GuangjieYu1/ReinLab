import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as RMouseEvent, type ReactNode } from 'react';
import AgentDock, { type DockDraft, type DockEvent, type Risk, type Suggestion } from '../AgentDock';
import { Mobius } from '../../rhine/RhineMark';
import Explorer, { Tree, type ExplorerSection, type ExplorerView } from './Explorer';
import { CODE, DATABASES, EDGES, ISSUES, LAYERS, MODULES, PULLED, SERVICES, STATE_LABEL, TERMINAL_BOOT, branchOf, codeTree, diffOf, testRun, type Issue } from './devModel';
import Crosshair from './Crosshair';
import './dev.css';

// 工程台 · 开发面：issue = 分支 = 会话。
// 左：资源管理器（待办 issue · 代码仓库 · 数据库 · 服务）· 中：预览 / 接口 / Diff / 终端 + Archify 结构图 · 右：开发助手（一个 issue 一个会话）。
// 按钮与开发助手共用同一张动作表：你点「运行测试」和对助手说「跑一下测试」，界面反应一样。

type ActionId = 'to_spec' | 'to_tdd' | 'to_impl' | 'run_tests' | 'to_review' | 'mark_testing';
const ACTIONS: Record<ActionId, { label: string; risk: Risk }> = {
  to_spec: { label: 'ToSpec · 生成技术规格', risk: 'write' }, to_tdd: { label: 'ToTDD · 先写失败的测试', risk: 'write' },
  to_impl: { label: 'ToImpl · 实现', risk: 'write' }, run_tests: { label: '运行测试', risk: 'read' },
  to_review: { label: 'ToReview · 自查 diff', risk: 'read' },
  mark_testing: { label: '标记待测试', risk: 'write' },
};
const PLAN = ['ToSpec', 'ToTDD', 'ToImpl', '运行测试', 'ToReview', '标记待测试'];
const clock = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
let seq = 0; const uid = () => `d${++seq}`;
type Tab = 'preview' | 'diff' | 'term' | `code:${string}`;
// 接口测试在测试面：开发面只留实现时要看的预览、Diff、终端。
const TABS: { id: Tab; label: string; en: string }[] = [{ id: 'preview', label: '预览', en: 'PREVIEW' }, { id: 'diff', label: 'Diff', en: 'DIFF' }, { id: 'term', label: '终端', en: 'TERMINAL' }];

export default function DevFace({ reduced, onIssues, onTesting, initialIssue = 'ISS-32' }: { reduced: boolean; onIssues: (n: number) => void; onTesting: (n: number) => void; initialIssue?: string }) {
  const [issues, setIssues] = useState<Issue[]>(ISSUES);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [current, setCurrent] = useState(() => ISSUES.some(i => i.id === initialIssue) ? initialIssue : 'ISS-32');
  const [branches, setBranches] = useState<Set<string>>(new Set(['ISS-32', 'ISS-31', 'ISS-30', 'ISS-29']));
  const [progress, setProgress] = useState<Record<string, number>>({ 'ISS-32': 2, 'ISS-33': 0, 'ISS-31': 6, 'ISS-30': 6, 'ISS-29': 6 });
  const [sessions, setSessions] = useState<Record<string, DockEvent[]>>(() => ({ 'ISS-32': [
    { id: uid(), kind: 'agent', at: '09:52', text: <p>这是 <b>ISS-32</b> 的会话，分支 <code>feat/ISS-32-keyboard-nav</code>。规格和失败的测试已经写好，<b>useKeys</b> 已实现；还剩「选中项朗读档案号」这条测试没过。</p> },
    { id: uid(), kind: 'tool', action: 'run_tests', label: '运行测试', state: 'done', ms: 1400, detail: '3 通过 · 1 失败' },
  ] }));
  const [tab, setTab] = useState<Tab>('preview');
  const [codeTabs, setCodeTabs] = useState<string[]>([]);
  const [xpOpen, setXpOpen] = useState(true);
  const [xpView, setXpView] = useState<ExplorerView>('files');
  const [selectedFile, setSelectedFile] = useState<string | undefined>();
  const [terminal, setTerminal] = useState<Record<string, string[]>>({ 'ISS-32': [...TERMINAL_BOOT, ...testRun(ISSUES[0])] });
  const [busy, setBusy] = useState<ActionId | null>(null);
  const [archOpen, setArchOpen] = useState(true);
  const [ping, setPing] = useState<{ id: string; n: number } | null>(null);
  const [checkpoints, setCheckpoints] = useState<Record<string, { label: string; at: string }[]>>({ 'ISS-32': [{ label: 'ToSpec · 技术规格', at: '09:31' }, { label: 'ToTDD · 4 条测试', at: '09:40' }, { label: 'useKeys 实现', at: '09:51' }] });
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = (ms: number, fn: () => void) => { timers.current.push(window.setTimeout(fn, reduced ? Math.min(ms, 60) : ms)); };

  const issue = issues.find(i => i.id === current)!;
  const branch = branchOf(issue);
  const events = sessions[current] ?? [];
  const passed = issue.tests.filter(t => t.pass).length, failing = issue.tests.filter(t => t.pass === false).length;
  const tree = useMemo(() => codeTree(issue), [issue]);

  const push = useCallback((id: string, e: DockDraft) => { const eid = e.id ?? uid(); setSessions(s => ({ ...s, [id]: [...(s[id] ?? []), { ...e, id: eid } as DockEvent] })); return eid; }, []);
  const patch = (id: string, eid: string, p: Partial<DockEvent>) => setSessions(s => ({ ...s, [id]: (s[id] ?? []).map(e => e.id === eid ? { ...e, ...p } as DockEvent : e) }));
  const say = (id: string, text: ReactNode) => push(id, { kind: 'agent', text, at: clock() });
  const checkpoint = (id: string, label: string) => setCheckpoints(c => ({ ...c, [id]: [...(c[id] ?? []), { label, at: clock() }] }));
  const setTests = (id: string, fn: (t: Issue['tests']) => Issue['tests']) => setIssues(list => list.map(i => i.id === id ? { ...i, tests: fn(i.tests) } : i));
  const aim = (id: string) => setPing({ id, n: Date.now() });

  /** 切 issue：整个开发面切过去；第一次打开时自动建分支、开新会话。 */
  const openIssue = (id: string) => {
    setCurrent(id); setTab('preview'); setCodeTabs([]);
    const it = issues.find(i => i.id === id)!;
    if (!branches.has(id)) {
      setBranches(b => new Set(b).add(id));
      setProgress(p => ({ ...p, [id]: p[id] ?? 0 }));
      push(id, { kind: 'tool', action: 'git', label: `git checkout -b ${branchOf(it)}`, detail: '基于 develop @ a1f3c9', state: 'done', ms: 180 });
      push(id, { kind: 'agent', at: clock(), text: <p>新会话：<b>{id} {it.title}</b>，来源 <b>{it.from}</b>。我已经读了工作区说明和对应的需求。建议先 <b>ToSpec</b> 生成技术规格，再 <b>ToTDD</b> 写失败的测试。</p> });
      setTerminal(t => ({ ...t, [id]: [...TERMINAL_BOOT, `$ git checkout -b ${branchOf(it)}`, `Switched to a new branch '${branchOf(it)}'`] }));
    }
  };

  // 从测试面「带到开发面」时直接落在那个 issue 上；第一次打开就建分支、开会话（只做一次）。
  const arrived = useRef(false);
  useEffect(() => { if (arrived.current) return; arrived.current = true; if (!branches.has(current)) openIssue(current); });

  /** 执行一个动作：read 直接执行；write 先出审批卡（按钮与助手同一条路径）。 */
  const run = (a: ActionId) => {
    const id = current, it = issue, act = ACTIONS[a];
    const exec = () => {
      setBusy(a);
      const tool = push(id, { kind: 'tool', action: a, label: act.label, state: 'running' }); const t0 = performance.now();
      const done = (detail: string) => { patch(id, tool, { state: 'done', ms: performance.now() - t0, detail } as Partial<DockEvent>); setBusy(null); };
      if (a === 'run_tests') {
        setTab('term');
        later(1300, () => {
          setTerminal(t => ({ ...t, [id]: [...(t[id] ?? []), ...testRun(issues.find(i => i.id === id)!)] }));
          const cur = issues.find(i => i.id === id)!, f = cur.tests.filter(x => x.pass === false).length;
          done(`${cur.tests.filter(x => x.pass).length} 通过 · ${f} 失败`);
          setProgress(p => ({ ...p, [id]: Math.max(p[id] ?? 0, 3) }));
          say(id, f ? <p>还有 {f} 条测试失败：<b>{cur.tests.find(x => x.pass === false)?.name}</b>。要我 ToImpl 补上吗？</p> : <p>全部通过。可以 <b>ToReview</b> 自查一遍 diff，再标记待测试。</p>);
        });
      } else if (a === 'to_spec') {
        later(1100, () => {
          done('docs/spec/' + id + '.md'); setProgress(p => ({ ...p, [id]: Math.max(p[id] ?? 0, 1) })); checkpoint(id, 'ToSpec · 技术规格');
          push(id, { kind: 'card', body: <div className="dv-spec"><span className="rh-micro">SPEC · {id} 技术规格</span><b>{it.title}</b><dl><dt>来源</dt><dd>{it.from}</dd><dt>改动</dt><dd>{it.files.map(f => <code key={f}>{f.split('/').pop()}</code>)}</dd><dt>测试</dt><dd>{it.tests.map(t => <span key={t.name}>□ {t.name}</span>)}</dd></dl></div> });
        });
      } else if (a === 'to_tdd') {
        later(1200, () => {
          setTests(id, ts => ts.map(t => t.pass === null ? { ...t, pass: false } : t)); setTab('term');
          setTerminal(t => ({ ...t, [id]: [...(t[id] ?? []), ...testRun({ ...it, tests: it.tests.map(x => x.pass === null ? { ...x, pass: false } : x) })] }));
          done('红：测试先失败'); setProgress(p => ({ ...p, [id]: Math.max(p[id] ?? 0, 2) })); checkpoint(id, `ToTDD · ${it.tests.length} 条测试`);
          say(id, <p>测试已写好并确认先失败（红）。下一步 <b>ToImpl</b>。</p>);
        });
      } else if (a === 'to_impl') {
        setTab('diff');
        later(1700, () => {
          setTests(id, ts => ts.map(t => ({ ...t, pass: true })));
          setTerminal(t => ({ ...t, [id]: [...(t[id] ?? []), ...testRun({ ...it, tests: it.tests.map(x => ({ ...x, pass: true })) })] }));
          done(`绿：${it.tests.length}/${it.tests.length} 通过`); setProgress(p => ({ ...p, [id]: Math.max(p[id] ?? 0, 4) })); checkpoint(id, 'ToImpl · 全部通过');
          say(id, <p>实现完成，{it.tests.length} 条测试全部通过（绿）。改动在 Diff 里，带橙点的文件是我改的。</p>);
        });
      } else if (a === 'to_review') {
        later(1000, () => {
          done('2 条意见'); setProgress(p => ({ ...p, [id]: Math.max(p[id] ?? 0, 5) }));
          say(id, <><p>自查了 diff，两点：</p><p>① <b className="ad-ref" onClick={() => { setTab('diff'); aim('diff-useKeys'); }}>useKeys.ts</b> 的依赖是 <code>map</code> 对象，每次渲染都会重绑键盘事件，建议用 ref。</p><p>② <b className="ad-ref" onClick={() => { setTab('preview'); aim('pv-list'); }}>ArchiveList</b> 在窄屏下选中项可能滚出视口，需要 <code>scrollIntoView</code>。</p></>);
        });
      } else if (a === 'mark_testing') {
        later(700, () => {
          setIssues(list => list.map(i => i.id === id ? { ...i, state: 'testing' } : i)); setProgress(p => ({ ...p, [id]: 6 })); onTesting(1);
          done('已进入测试面队列'); checkpoint(id, '标记待测试'); say(id, <p>{id} 已标记待测试，测试面会按验收标准生成用例。</p>);
        });
      }
    };
    if (act.risk === 'write') {
      const effects: Record<string, string[]> = {
        to_spec: [`新建 docs/spec/${id}.md`, `来源 ${it.from}`], to_tdd: [`在 tests/ 中新增 ${it.tests.filter(t => t.pass === null).length || it.tests.length} 条测试`, '运行一次，确认先失败'],
        to_impl: [`修改 ${it.files.length} 个文件：${it.files.map(f => f.split('/').pop()).join('、')}`, '实现后自动运行测试'], mark_testing: [`${id} 状态改为「待测试」`, '交给测试面生成用例'],
      };
      const card = push(id, { kind: 'approval', action: a, title: act.label, effects: effects[a] ?? [], risk: 'write', state: 'pending', onApprove: () => {}, onReject: () => {} });
      patch(id, card, { onApprove: () => { patch(id, card, { state: 'approved' } as Partial<DockEvent>); exec(); }, onReject: () => { patch(id, card, { state: 'rejected' } as Partial<DockEvent>); say(id, <p>好的，没有执行。</p>); } } as Partial<DockEvent>);
      return;
    }
    exec();
  };

  const onSend = (text: string) => {
    push(current, { kind: 'user', text, at: clock() });
    const t = text.toLowerCase();
    const a: ActionId | null = /测试|test/.test(t) && !/写|tdd/.test(t) ? 'run_tests' : /tdd|先写/.test(t) ? 'to_tdd' : /spec|规格/.test(t) ? 'to_spec' : /实现|impl|修/.test(t) ? 'to_impl' : /review|自查|检查/.test(t) ? 'to_review' : /待测/.test(t) ? 'mark_testing' : null;
    if (a) run(a); else later(500, () => say(current, <p>我在维护 <b>{current}</b>。可以：ToSpec、ToTDD、ToImpl、运行测试、ToReview、标记待测试。也可以在预览里点选元素，把它引用到这里。</p>));
  };
  const onPickElement = (ref: string) => { push(current, { kind: 'user', text: `@${ref} 这里在窄屏下会不会被挤掉？`, at: clock() }); later(700, () => say(current, <p>看了 <b>@{ref}</b>：宽度 &lt; 700 时它排在说明下方，不会被挤掉；但选中项可能滚出视口，ToReview 时我会一起处理。</p>)); };
  const onComment = (path: string, line: number, text: string) => { push(current, { kind: 'user', text: `评论 ${path.split('/').pop()}:${line} — ${text}`, at: clock() }); later(800, () => say(current, <p>收到，关于 <code>{path.split('/').pop()}:{line}</code>：我会在下一次 ToImpl 时按你的意见改，并把这条评论附在提交说明里。</p>)); };
  const refreshIssues = () => {
    const add = PULLED.filter(p => !issues.some(i => i.id === p.id));
    if (!add.length) { say(current, <p>需求面暂时没有新的 issue。</p>); return; }
    setIssues(list => [...add, ...list]); setFresh(new Set(add.map(a => a.id))); onIssues(add.length);
    say(current, <p>从需求面拉取了 {add.length} 个新 issue：{add.map(a => a.id).join('、')}。</p>);
  };
  const openFile = (path: string) => { if (!CODE[path] && !path.endsWith('.md')) return; setSelectedFile(path); setCodeTabs(c => c.includes(path) ? c : [...c, path]); setTab(`code:${path}`); };

  const p = progress[current] ?? 0;
  const suggestions: Suggestion[] = issue.state === 'testing' || issue.state === 'merged'
    ? [{ id: 'v', label: issue.state === 'testing' ? '在测试面查看用例' : '查看合并提交', onClick: () => say(current, <p>{issue.state === 'testing' ? '测试面还在设计中，' : ''}{current} 当前状态：{STATE_LABEL[issue.state]}。</p>) }]
    : p < 1 ? [{ id: 's', label: 'ToSpec', onClick: () => run('to_spec') }, { id: 't', label: 'ToTDD', onClick: () => run('to_tdd') }]
    : p < 2 ? [{ id: 't', label: 'ToTDD', onClick: () => run('to_tdd') }, { id: 'r', label: '运行测试', onClick: () => run('run_tests') }]
    : failing ? [{ id: 'i', label: 'ToImpl', onClick: () => run('to_impl') }, { id: 'r', label: '运行测试', onClick: () => run('run_tests') }]
    : [{ id: 'v', label: 'ToReview', onClick: () => run('to_review') }, { id: 'm', label: '标记待测试', onClick: () => run('mark_testing') }];

  const sections: ExplorerSection[] = xpView === 'files' ? [
    { id: 'issues', title: '待办 · issues', count: issues.filter(i => i.state !== 'merged').length, actions: <button onClick={refreshIssues} title="从需求面拉取新 issue">↻ 刷新</button>,
      body: <IssueList issues={issues} current={current} fresh={fresh} branches={branches} onOpen={openIssue} /> },
    { id: 'repo', title: `reinlab · ${branch}`, grow: true, body: <Tree nodes={tree} active={tab.startsWith('code:') ? tab.slice(5) : undefined} selected={selectedFile} open={codeTabs} onSelect={setSelectedFile} onOpen={openFile} defaultOpen={path => !path.startsWith('requirements')} /> },
    { id: 'db', title: '数据库', folded: true, count: DATABASES.length, body: <div className="dv-xp-list">{DATABASES.map(d => <div key={d.name}><b>{d.name}</b><small>{d.kind} · {d.tables.join(' · ')}</small></div>)}</div> },
    { id: 'svc', title: '服务', folded: true, count: SERVICES.length, body: <div className="dv-xp-list">{SERVICES.map(s => <div key={s.name}><b><i data-on={s.on || undefined} />{s.name}</b><small>{s.addr}</small></div>)}</div> },
  ] : xpView === 'search' ? [
    { id: 'search', title: '搜索文件', grow: true, body: <SearchFiles tree={tree} onOpen={openFile} /> },
  ] : xpView === 'git' ? [
    { id: 'branch', title: '分支', body: <div className="dv-xp-list">{issues.filter(i => branches.has(i.id)).map(i => <button key={i.id} aria-current={i.id === current || undefined} onClick={() => openIssue(i.id)}><b>⎇ {branchOf(i)}</b><small>{STATE_LABEL[i.state]}</small></button>)}</div> },
    { id: 'changes', title: '本分支改动', count: issue.files.length, grow: true, body: <Tree nodes={issue.files.map(f => ({ name: f.split('/').pop()!, path: f, title: f.split('/').slice(0, -1).join('/'), badge: CODE[f]?.isNew ? 'A' : 'M' }))} onOpen={openFile} /> },
  ] : [
    { id: 'trace', title: `追溯 · ${current}`, grow: true, body: <Trace issue={issue} checkpoints={checkpoints[current] ?? []} /> },
  ];

  return <div className="dv rh">
    <Explorer open={xpOpen} view={xpView} onView={setXpView} onToggle={() => setXpOpen(v => !v)} title={branch} sections={sections} badges={{ files: fresh.size || undefined, git: issue.files.length }} />
    <section className="dv-center" data-wb-panel>
      <header className="dv-bar" data-busy={busy || undefined}>
        <div className="dv-bar-id"><b>DEV</b><small>ISSUE<br />开发</small></div>
        <div className="dv-issue" key={current}><em>{current}</em><strong>{issue.title}</strong><span>⎇ {branch}<i>·</i>{issue.from}</span></div>
        <span className="dv-state" data-state={issue.state}>{STATE_LABEL[issue.state]}</span>
        <div className="dv-tests" title="测试"><b>{String(passed).padStart(2, '0')}</b><i>/</i><em>{String(issue.tests.length).padStart(2, '0')}</em><small>TESTS · 通过</small>
          <span className="dv-ticks">{issue.tests.map((t, k) => <i key={k} data-s={t.pass === null ? 'none' : t.pass ? 'pass' : 'fail'} title={t.name} />)}</span></div>
        <button className="dv-run" onClick={() => run('run_tests')} disabled={!!busy}>{busy ? <Mobius stages={['红', '绿', '重构']} current={busy === 'to_impl' ? 1 : busy === 'to_tdd' ? 0 : 1} running width={54} /> : <i />}<span><b>{busy ? 'RUNNING' : 'RUN TESTS'}</b><small>{busy ? ACTIONS[busy].label : '运行测试'}</small></span></button>
      </header>
      <nav className="dv-tabs" role="tablist">
        {TABS.map((t, i) => <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}><b>{String(i + 1).padStart(2, '0')}</b>{t.label}<small>{t.en}</small></button>)}
        {codeTabs.map(path => <button key={path} role="tab" className="dv-codetab" aria-selected={tab === `code:${path}`} onClick={() => setTab(`code:${path}`)}>
          <span className="xp-ext" data-ext={(path.split('.').pop() ?? '').toUpperCase()}>{(path.split('.').pop() ?? '').toUpperCase().slice(0, 3)}</span>{path.split('/').pop()}
          <em onClick={e => { e.stopPropagation(); setCodeTabs(c => c.filter(x => x !== path)); if (tab === `code:${path}`) setTab('preview'); }}>×</em></button>)}
      </nav>
      <div className="dv-work" key={`${current}:${tab}`}>
        {tab === 'preview' ? <PreviewTab issue={issue} ping={ping} onPick={onPickElement} />
          : tab === 'diff' ? <DiffTab issue={issue} ping={ping} onComment={onComment} />
          : tab === 'term' ? <TermTab lines={terminal[current] ?? TERMINAL_BOOT} busy={busy === 'run_tests' || busy === 'to_tdd' || busy === 'to_impl'} onRun={cmd => cmd.includes('test') ? run('run_tests') : setTerminal(t => ({ ...t, [current]: [...(t[current] ?? []), `$ ${cmd}`, `（示例终端）没有执行 ${cmd}`] }))} />
          : <CodeTab path={tab.slice(5)} />}
      </div>
      <Archify open={archOpen} onToggle={() => setArchOpen(v => !v)} issue={issue} onModule={m => { const mod = MODULES.find(x => x.id === m); if (mod?.file) openFile(mod.file); }} />
      <footer className="dv-cps">
        <span>⎇ {branch}</span><b>CHECKPOINTS</b>
        <span className="dv-cps-line">{(checkpoints[current] ?? []).map((c, i) => <i key={i} title={`${c.at} · ${c.label}`} data-last={i === (checkpoints[current]?.length ?? 0) - 1 || undefined} />)}</span>
        <small>{checkpoints[current]?.slice(-1)[0]?.label ?? '还没有检查点'}</small>
      </footer>
    </section>
    <AgentDock name="开发助手" target={`${current} · ${branch}`} plan={{ stages: PLAN, current: Math.min(p, 5) }} suggestions={suggestions} events={events} busy={!!busy}
      loop={busy === 'to_tdd' || busy === 'to_impl' || busy === 'run_tests' ? { stages: ['红', '绿', '重构'], current: busy === 'to_tdd' ? 0 : busy === 'to_impl' ? 1 : 1 } : null}
      onSend={onSend} placeholder={`对 ${current} 的助手说，例如：跑一下测试`} />
  </div>;
}

/* ———— 01 待办 ———— */
function IssueList({ issues, current, fresh, branches, onOpen }: { issues: Issue[]; current: string; fresh: Set<string>; branches: Set<string>; onOpen: (id: string) => void }) {
  return <div className="dv-issues">{issues.map(i => <button key={i.id} aria-current={i.id === current || undefined} data-state={i.state} data-fresh={fresh.has(i.id) || undefined} onClick={() => onOpen(i.id)}>
    <em>{i.id}</em><b>{i.title}</b><span className="dv-state" data-state={i.state}>{STATE_LABEL[i.state]}</span>
    <small>{i.from}{branches.has(i.id) ? <> · ⎇ {branchOf(i)}</> : <> · 首次打开自动建分支</>}</small>
  </button>)}</div>;
}
function SearchFiles({ tree, onOpen }: { tree: ReturnType<typeof codeTree>; onOpen: (p: string) => void }) {
  const [q, setQ] = useState('');
  return <><div className="xp-search"><input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="文件名…" /></div><Tree nodes={tree} filter={q} onOpen={onOpen} /></>;
}
/** 追溯链：REQ ⇄ AC ⇄ issue ⇄ 提交 ⇄ 用例 ⇄ 本体概念。 */
function Trace({ issue, checkpoints }: { issue: Issue; checkpoints: { label: string; at: string }[] }) {
  const [req, ...acs] = issue.from.split(' · ');
  const rows: [string, ReactNode][] = [['需求', req], ['验收标准', acs.join(' · ')], ['issue', `${issue.id} ${issue.title}`], ['提交', checkpoints.length ? checkpoints.map(c => c.label).join(' → ') : '—'], ['用例', issue.tests.map(t => t.name).join(' · ')], ['本体概念', issue.concepts.join(' · ')]];
  return <ol className="dv-trace">{rows.map(([k, v], i) => <li key={k}><em>{String(i + 1).padStart(2, '0')}</em><span><small>{k}</small>{v}</span></li>)}</ol>;
}

/* ———— 02 预览：宽度标尺、元素点选、改动标注 ———— */
const FILES = [['X—013', '文献与实验'], ['X—014', '方法与证据'], ['X—015', '模型结构对照'], ['X—016', '研究笔记']];
function PreviewTab({ issue, ping, onPick }: { issue: Issue; ping: { id: string; n: number } | null; onPick: (ref: string) => void }) {
  const [width, setWidth] = useState(1280);
  const [sel, setSel] = useState(0);
  const [pick, setPick] = useState(false);
  const [opened, setOpened] = useState<string | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const narrow = width < 700;
  const touched = (m: string) => issue.modules.includes(m) && issue.state !== 'merged';
  const ref = (r: string) => pick ? { 'data-ref': r, onClick: (e: RMouseEvent) => { e.preventDefault(); e.stopPropagation(); onPick(r); setPick(false); } } : {};
  return <div className="dv-preview">
    <div className="dv-pv-tools">
      <span className="rh-micro">VIEWPORT</span>
      {[390, 768, 1280].map(w => <button key={w} aria-pressed={width === w} onClick={() => setWidth(w)}>{w}</button>)}
      <button className="dv-pick" aria-pressed={pick} onClick={() => setPick(v => !v)}>⌖ 点选元素</button>
      <span className="dv-pv-url">127.0.0.1:5173/?preview=entry · ⎇ {branchOf(issue)}</span>
    </div>
    <div className="dv-ruler" aria-hidden="true">{Array.from({ length: 14 }, (_, i) => <i key={i} style={{ left: `${(i * 100 / 1300) * 100}%` }}>{i % 2 === 0 ? i * 100 : ''}</i>)}
      {[390, 768, 1280].map(w => <b key={w} style={{ left: `${(w / 1300) * 100}%` }} data-on={width === w || undefined}>{w}</b>)}</div>
    <div className="dv-pv-stage">
      <div className="dv-frame" ref={frame} data-pick={pick || undefined} style={{ width: `${(width / 1300) * 100}%` } as CSSProperties} tabIndex={0}
        onKeyDown={e => { if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => (s + 1) % 4); } if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => (s + 3) % 4); } if (e.key === 'Enter') setOpened(FILES[sel][0]); }}>
        <div className="dv-app" data-narrow={narrow || undefined}>
          <ol className={`dv-app-list${touched('ArchiveList') ? ' is-touched' : ''}`} role="listbox" {...ref('ArchiveList')}>
            {ping?.id === 'pv-list' && <i className="en-ring" key={ping.n} />}
            {FILES.map(([no, t], i) => <li key={no} role="option" aria-selected={i === sel} onClick={() => !pick && setSel(i)} {...ref(`ArchiveList › li:nth(${i + 1})`)}><em>{no}</em>{t}</li>)}
            {touched('ArchiveList') && <span className="dv-anno" style={{ top: -10, right: 8 }}><b>ArchiveList</b>role=option · 已修改</span>}
          </ol>
          <aside className={`dv-app-callout${touched('FileCallout') || touched('browser.css') ? ' is-touched' : ''}`} {...ref('FileCallout')}>
            <small>FILE</small><h4>{FILES[sel][0]}</h4><p>{FILES[sel][1]}</p><button {...ref('FileCallout › ACCESS FILE')} onClick={() => !pick && setOpened(FILES[sel][0])}>ACCESS FILE →</button>
            {(touched('FileCallout') || touched('browser.css')) && <span className="dv-anno" style={{ bottom: -10, left: 8 }}><b>{touched('browser.css') ? 'browser.css' : 'FileCallout'}</b>窄屏布局</span>}
          </aside>
          {touched('useKeys') && <span className="dv-keys">↑ ↓ ENTER <b>useKeys</b></span>}
          <span className="dv-app-status" role="status">{opened ? `已抽出 ${opened}` : `选中 ${FILES[sel][0]} ${FILES[sel][1]}`}</span>
        </div>
      </div>
    </div>
    <p className="dv-pv-hint rh-micro">点进预览后可用 ↑ ↓ Enter 试本 issue 的键盘浏览 · 橙色虚线框是本 issue 改动的区域</p>
  </div>;
}

/* ———— 02 Diff：行内评论直接发给开发助手 ———— */
function DiffTab({ issue, ping, onComment }: { issue: Issue; ping: { id: string; n: number } | null; onComment: (path: string, line: number, text: string) => void }) {
  const hunks = useMemo(() => diffOf(issue), [issue]);
  const [at, setAt] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sent, setSent] = useState<Record<string, string>>({});
  if (!hunks.length) return <div className="dv-empty"><b>DIFF</b><p>这个 issue 还没有改动。ToImpl 之后，改动会出现在这里。</p></div>;
  return <div className="dv-diff">
    <span className="rh-micro">⎇ {branchOf(issue)} → develop · {hunks.length} 个文件 · +{hunks.reduce((n, h) => n + h.add, 0)} −{hunks.reduce((n, h) => n + h.del, 0)} · 点任意一行写评论</span>
    {hunks.map(h => <section key={h.path} className="dv-hunk">
      {ping?.id === `diff-${h.path.split('/').pop()!.replace(/\.\w+$/, '')}` && <i className="en-ring" key={ping.n} />}
      <header><span className="xp-ext" data-ext={(h.path.split('.').pop() ?? '').toUpperCase()}>{(h.path.split('.').pop() ?? '').toUpperCase().slice(0, 3)}</span><b>{h.path}</b><small>+{h.add} −{h.del}</small></header>
      {h.lines.map((l, i) => { const key = `${h.path}:${i}`; return <div key={i}>
        <button className="dv-line" data-op={l.op} onClick={() => { setAt(at === key ? null : key); setDraft(''); }}><i>{l.op === '-' ? '' : l.no}</i><em>{l.op}</em><code>{l.text || ' '}</code></button>
        {sent[key] && <div className="dv-comment is-sent"><b>你</b>{sent[key]}<small>已发给开发助手</small></div>}
        {at === key && <form className="dv-comment" onSubmit={e => { e.preventDefault(); if (!draft.trim()) return; onComment(h.path, l.no, draft.trim()); setSent(s => ({ ...s, [key]: draft.trim() })); setAt(null); }}>
          <input autoFocus value={draft} onChange={e => setDraft(e.target.value)} placeholder={`评论 ${h.path.split('/').pop()}:${l.no}…`} /><button className="rh-btn is-solid">发给开发助手</button></form>}
      </div>; })}
    </section>)}
  </div>;
}

/* ———— 02 终端（暗室）———— */
function TermTab({ lines, busy, onRun }: { lines: string[]; busy: boolean; onRun: (cmd: string) => void }) {
  const [cmd, setCmd] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight }); }, [lines.length, busy]);
  return <div className="dv-term" data-surface="darkroom" ref={box}>
    {lines.map((l, i) => <div key={i} data-k={l.startsWith('$') ? 'cmd' : /×|failed/.test(l) ? 'fail' : /✓|passed|ready/.test(l) ? 'ok' : undefined}>{l}</div>)}
    {busy && <div data-k="cmd" className="dv-term-busy">▍</div>}
    <form onSubmit={e => { e.preventDefault(); if (cmd.trim()) { onRun(cmd.trim()); setCmd(''); } }}><span>$</span><input value={cmd} onChange={e => setCmd(e.target.value)} placeholder="npx vitest run" /></form>
  </div>;
}
function CodeTab({ path }: { path: string }) {
  const c = CODE[path];
  if (!c) return <div className="dv-empty"><b>{path.split('.').pop()?.toUpperCase()}</b><p>{path} · 只读，在需求面编辑。</p></div>;
  return <div className="dv-code"><span className="rh-micro">{path} · {c.ai?.length ? `助手在本分支改了 ${c.ai.length} 行（橙色）` : '未改动'}</span>
    <pre>{c.lines.map((l, i) => <div key={i} data-ai={c.ai?.includes(i) || undefined}><i>{i + 1}</i><code>{l || ' '}</code></div>)}</pre></div>;
}

/* ———— 03 Archify：本 issue 波及的模块高亮 ———— */
function Archify({ open, onToggle, issue, onModule }: { open: boolean; onToggle: () => void; issue: Issue; onModule: (id: string) => void }) {
  const pos = (id: string) => { const m = MODULES.find(x => x.id === id)!; return { x: m.x, y: 14 + m.layer * 24 }; };
  const hot = new Set(issue.state === 'merged' ? [] : issue.modules);
  return <section className="dv-arch" data-open={open || undefined}>
    <header><span className="rh-ph-no">03</span><b>ARCHIFY</b><small>项目结构 · 本 issue 波及 {hot.size} 个模块</small><button onClick={onToggle} aria-label={open ? '收起结构图' : '展开结构图'}>{open ? '▾' : '▴'}</button></header>
    {open && <div className="dv-arch-map" key={issue.id}>
      <Crosshair />
      {LAYERS.map((l, i) => <span key={l} className="dv-arch-layer" style={{ top: `${6 + i * 24}%` }}>{l}</span>)}
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">{EDGES.map(([a, b]) => { const p = pos(a), q = pos(b); return <line key={a + b} x1={p.x} y1={p.y} x2={q.x} y2={q.y} data-hot={hot.has(a) && hot.has(b) || undefined} vectorEffect="non-scaling-stroke" />; })}</svg>
      {MODULES.map(m => <button key={m.id} className="dv-mod" data-hot={hot.has(m.id) || undefined} style={{ left: `${m.x}%`, top: `${14 + m.layer * 24}%` }} onClick={() => onModule(m.id)} title={m.file ?? m.id}>{hot.has(m.id) && <i />}{m.id}</button>)}
    </div>}
  </section>;
}
