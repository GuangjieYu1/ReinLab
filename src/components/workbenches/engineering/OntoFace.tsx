import { useEffect, useRef, useState, type ReactNode } from 'react';
import AgentDock, { type DockDraft, type DockEvent, type Suggestion } from '../AgentDock';
import Explorer, { type ExplorerSection, type ExplorerView } from './Explorer';
import { ONTOLOGY } from './model';
import Crosshair from './Crosshair';
import './onto.css';

// 工程台 · 本体面：以 develop 为准。
// 左：分支（develop 永远在最上，其他分支显示冲突数）· 中：本体图 ⇄ 需求树，叠加所选分支的 WhatIf（新增橙 · 删除划线 · 冲突锈色虚线），可两分支对比
// · 节点详情（定义 · 关系 · 约束 · 追溯链）· 右：本体助手（影响分析 · 解释冲突 · 建议消解）。

type Node = { id: string; name: string; x: number; y: number; def: string; rule?: string };
const POS: Record<string, [number, number]> = { 'C-BENCH': [50, 12], 'C-FILE': [50, 38], 'C-FILENO': [18, 38], 'C-AGENT': [82, 38], 'C-CASSETTE': [34, 64], 'C-SLIP': [66, 64], 'C-FIELD': [34, 88] };
const BASE_NODES: Node[] = ONTOLOGY.map(c => ({ id: c.id, name: c.name, x: POS[c.id]?.[0] ?? 50, y: POS[c.id]?.[1] ?? 50, def: c.def, rule: c.rule }));
type Edge = { a: string; b: string; label: string };
const BASE_EDGES: Edge[] = [
  { a: 'C-BENCH', b: 'C-FILE', label: '拥有' }, { a: 'C-FILENO', b: 'C-FILE', label: '标识' }, { a: 'C-AGENT', b: 'C-FILE', label: '维护' },
  { a: 'C-CASSETTE', b: 'C-FILE', label: '容纳' }, { a: 'C-SLIP', b: 'C-FILE', label: '摘要' }, { a: 'C-FIELD', b: 'C-CASSETTE', label: '包含' },
];
type Overlay = { added: Node[]; addedEdges: Edge[]; removed: string[]; changed: string[]; conflicts: { node: string; text: string; source: string }[] };
type Branch = { name: string; note: string; overlay: Overlay };
const EMPTY: Overlay = { added: [], addedEdges: [], removed: [], changed: [], conflicts: [] };
const BRANCHES: Branch[] = [
  { name: 'develop', note: '无冲突 · 以此为准', overlay: EMPTY },
  { name: 'req/REQ-012', note: '变更集 2 个文件', overlay: {
    added: [{ id: 'C-CELL', name: '选中格', x: 66, y: 88, def: '（草稿）档案场里当前被选中的那一格。' }], addedEdges: [{ a: 'C-CELL', b: 'C-FIELD', label: '属于' }],
    removed: [], changed: ['C-SLIP'], conflicts: [{ node: 'C-FIELD', text: 'REQ-012 AC-5「停在最后一份」假设档案场有尽头，与约束「档案场在行、列两个方向上都没有边界」冲突。', source: 'REQ-012 · AC-5' }] } },
  { name: 'req/REQ-013', note: '新增需求', overlay: {
    added: [{ id: 'C-SEA', name: '档案海', x: 12, y: 88, def: '档案场远处沉没、循环复用的区域。' }], addedEdges: [{ a: 'C-SEA', b: 'C-FIELD', label: '延伸' }], removed: [], changed: ['C-FIELD'], conflicts: [] } },
  { name: 'feat/ISS-32-keyboard-nav', note: '只改代码', overlay: { ...EMPTY, changed: ['C-FILENO'] } },
  { name: 'feat/legacy-paging', note: '旧分支', overlay: { ...EMPTY, removed: ['C-SLIP'], conflicts: [{ node: 'C-FIELD', text: '分页浏览引入「最后一页」，与档案场无边界约束冲突。', source: 'REQ-009 · AC-2' }, { node: 'C-SLIP', text: '删除了档案小票，但 REQ-010 AC-2、AC-3 仍引用它。', source: 'REQ-010' }] } },
];
const TRACE: Record<string, { reqs: string[]; issues: string[]; commits: string[]; cases: string[] }> = {
  'C-FIELD': { reqs: ['REQ-010 · AC-1', 'REQ-012 · AC-5', 'REQ-013 · AC-1~3'], issues: ['ISS-29', 'ISS-34'], commits: ['c47e02 档案场显影'], cases: ['CASE-131', 'CASE-203'] },
  'C-FILE': { reqs: ['REQ-010 · S-1', 'REQ-012 · AC-1', 'REQ-013 · S-1'], issues: ['ISS-31', 'ISS-32', 'ISS-33'], commits: ['a1f3c9 列表 option 语义'], cases: ['CASE-101', 'CASE-102', 'CASE-118'] },
  'C-FILENO': { reqs: ['REQ-012 · AC-1'], issues: ['ISS-32'], commits: ['useKeys 实现'], cases: ['CASE-101', 'CASE-202'] },
  'C-CASSETTE': { reqs: ['REQ-010 · AC-1~3', 'REQ-012 · AC-2'], issues: ['ISS-29', 'ISS-30'], commits: ['c47e02'], cases: ['CASE-110', 'CASE-131'] },
  'C-SLIP': { reqs: ['REQ-010 · AC-2', 'REQ-010 · AC-3', 'REQ-012 · AC-2'], issues: ['ISS-30'], commits: ['9b2d17 小票取出动画'], cases: ['CASE-131', 'CASE-132'] },
  'C-BENCH': { reqs: ['REQ-020 · AC-1', 'REQ-013 · AC-1'], issues: [], commits: [], cases: [] },
  'C-AGENT': { reqs: ['REQ-021 · S-1', 'REQ-021 · AC-1~3'], issues: [], commits: [], cases: [] },
};
const TREE = [
  { id: 'browse', title: '档案浏览', reqs: [{ id: 'REQ-010', title: '档案场与抽取', acs: [['AC-1', ['C-FIELD', 'C-CASSETTE']], ['AC-2', ['C-SLIP', 'C-CASSETTE']], ['AC-3', ['C-SLIP', 'C-BENCH']]] },
    { id: 'REQ-012', title: '档案浏览器 · 键盘与窄屏', acs: [['AC-1', ['C-FILE', 'C-FILENO']], ['AC-2', ['C-CASSETTE', 'C-SLIP']], ['AC-3', ['C-FILE']], ['AC-5', ['C-FIELD']]] },
    { id: 'REQ-013', title: '无限档案场', acs: [['AC-1', ['C-FIELD', 'C-BENCH']], ['AC-2', ['C-FIELD']]] }] },
  { id: 'shell', title: '工作台外壳', reqs: [{ id: 'REQ-020', title: '顶栏与面签', acs: [['AC-1', ['C-BENCH', 'C-FILENO']]] }, { id: 'REQ-021', title: 'Agent 坞与动作表', acs: [['AC-1', ['C-AGENT']]] }] },
] as { id: string; title: string; reqs: { id: string; title: string; acs: [string, string[]][] }[] }[];
const clock = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
let seq = 0; const uid = () => `o${++seq}`;

export default function OntoFace({ reduced }: { reduced: boolean }) {
  const [branch, setBranch] = useState('req/REQ-012');
  const [compare, setCompare] = useState<string | null>(null);
  const [view, setView] = useState<'graph' | 'tree'>('graph');
  const [node, setNode] = useState('C-FIELD');
  const [xpOpen, setXpOpen] = useState(true);
  const [xpView, setXpView] = useState<ExplorerView>('files');
  const [busy, setBusy] = useState(false);
  const [impact, setImpact] = useState<string[]>([]);
  const [events, setEvents] = useState<DockEvent[]>(() => [{ id: uid(), kind: 'agent', at: '10:20', text: <p>本体以 <b>develop</b> 为准。现在叠加的是 <b>req/REQ-012</b> 的 WhatIf：新增概念「选中格」，<b>档案场</b>上有 1 处冲突。点任意概念看定义与追溯，或问我「改档案场会影响哪些需求」。</p> }]);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = (ms: number, fn: () => void) => { timers.current.push(window.setTimeout(fn, reduced ? Math.min(ms, 60) : ms)); };
  const push = (e: DockDraft) => { const id = e.id ?? uid(); setEvents(l => [...l, { ...e, id } as DockEvent]); return id; };
  const patch = (id: string, p: Partial<DockEvent>) => setEvents(l => l.map(e => e.id === id ? { ...e, ...p } as DockEvent : e));
  const say = (text: ReactNode) => push({ kind: 'agent', text, at: clock() });

  const br = BRANCHES.find(b => b.name === branch)!;
  const allNodes = [...BASE_NODES, ...BRANCHES.flatMap(b => b.overlay.added)];
  const cur = allNodes.find(n => n.id === node) ?? BASE_NODES[0];

  const act = (kind: 'impact' | 'explain' | 'resolve', target = node) => {
    setBusy(true);
    const name = allNodes.find(n => n.id === target)?.name ?? target;
    const tool = push({ kind: 'tool', action: kind === 'impact' ? 'onto_impact' : kind === 'explain' ? 'onto_explain' : 'onto_resolve', label: kind === 'impact' ? `影响分析 · ${name}` : kind === 'explain' ? `解释冲突 · ${name}` : `建议消解 · ${name}`, state: 'running' }); const t0 = performance.now();
    later(1000, () => {
      setBusy(false);
      const tr = TRACE[target];
      if (kind === 'impact') {
        setImpact(tr ? [target, ...BASE_EDGES.filter(e => e.a === target || e.b === target).map(e => e.a === target ? e.b : e.a)] : [target]);
        patch(tool, { state: 'done', ms: performance.now() - t0, detail: `${tr?.reqs.length ?? 0} 条需求 · ${tr?.cases.length ?? 0} 个用例` } as Partial<DockEvent>);
        say(<><p>改「<b>{name}</b>」会波及：</p><p>需求 {tr?.reqs.join('、') || '无'}；issue {tr?.issues.join('、') || '无'}；用例 {tr?.cases.join('、') || '无'}。</p><p>图上已用虚线框标出直接相连的概念。</p></>);
      } else {
        const c = br.overlay.conflicts.find(x => x.node === target);
        patch(tool, { state: 'done', ms: performance.now() - t0, detail: c ? c.source : '无冲突' } as Partial<DockEvent>);
        if (!c) say(<p>在 {branch} 上，「{name}」没有冲突。</p>);
        else if (kind === 'explain') say(<p>{c.text} 两边同时成立的话，测试面会生成互相矛盾的用例。</p>);
        else say(<><p>两种消解方式：</p><p>A. 改需求：把 {c.source} 改成「进入下一轮的第一份」，与约束一致（推荐，需求面里已有这个选项）。</p><p>B. 改本体：给约束加例外「演示模式下档案场有尽头」——会影响 REQ-013 的 3 条验收标准，不推荐。</p></>);
      }
    });
  };
  const onSend = (text: string) => {
    push({ kind: 'user', text, at: clock() });
    const hit = allNodes.find(n => text.includes(n.name));
    const target = hit?.id ?? node;
    if (hit) setNode(hit.id);
    if (/影响|波及|哪些/.test(text)) act('impact', target);
    else if (/解释|为什么|冲突/.test(text)) act('explain', target);
    else if (/消解|怎么办|建议|解决/.test(text)) act('resolve', target);
    else later(400, () => say(<p>可以问我：改某个概念会影响哪些需求（影响分析）、解释某处冲突、建议如何消解。</p>));
  };
  const suggestions: Suggestion[] = [
    { id: 'i', label: `影响分析 · ${cur.name}`, onClick: () => act('impact') },
    ...(br.overlay.conflicts.some(c => c.node === node) ? [{ id: 'e', label: '解释这条冲突', onClick: () => act('explain') }, { id: 'r', label: '建议消解', onClick: () => act('resolve') }] : []),
  ];

  const sections: ExplorerSection[] = xpView === 'files' ? [
    { id: 'branches', title: '分支 · 叠加 WhatIf', count: BRANCHES.length, grow: true, body: <div className="on-branches">
      {BRANCHES.map(b => <div key={b.name} className="on-br" aria-current={b.name === branch || undefined} data-compare={b.name === compare || undefined}>
        <button onClick={() => { setBranch(b.name); if (compare === b.name) setCompare(null); }}>
          <b>⎇ {b.name}</b>
          {b.name === 'develop' ? <span className="on-ok"><i />无冲突</span> : b.overlay.conflicts.length ? <span className="on-bad">▲ {b.overlay.conflicts.length}</span> : <span className="on-ok"><i />0</span>}
          <small>{b.note}{b.overlay.added.length ? ` · 新增 ${b.overlay.added.length}` : ''}{b.overlay.changed.length ? ` · 修改 ${b.overlay.changed.length}` : ''}{b.overlay.removed.length ? ` · 删除 ${b.overlay.removed.length}` : ''}</small>
        </button>
        {b.name !== branch && <button className="on-cmp" onClick={() => setCompare(c => c === b.name ? null : b.name)} aria-pressed={b.name === compare}>{b.name === compare ? '取消对比' : '对比'}</button>}
      </div>)}
    </div> },
  ] : xpView === 'search' ? [
    { id: 's', title: '概念', grow: true, body: <div className="on-concepts">{allNodes.map(n => <button key={n.id} aria-current={n.id === node || undefined} onClick={() => setNode(n.id)}><em>{n.id}</em>{n.name}</button>)}</div> },
  ] : [
    { id: 'trace', title: `追溯 · ${cur.name}`, grow: true, body: <TraceList id={cur.id} /> },
  ];

  return <div className="on rh">
    <Explorer open={xpOpen} view={xpView} onView={setXpView} onToggle={() => setXpOpen(v => !v)} title={`ontology · ${branch}`} sections={sections} badges={{ files: BRANCHES.filter(b => b.overlay.conflicts.length).length || undefined }} />
    <section className="on-center" data-wb-panel>
      <header className="dv-bar on-bar" data-busy={busy || undefined}>
        <div className="dv-bar-id"><b>ONTO</b><small>ONTOLOGY<br />本体</small></div>
        <div className="on-head"><span className="rh-micro">BASE · develop @ a1f3c9 · 叠加</span><strong>⎇ {branch}{compare && <> <i>⇄</i> ⎇ {compare}</>}</strong></div>
        <div className="on-legend"><span data-k="add"><i />新增 {br.overlay.added.length}</span><span data-k="chg"><i />修改 {br.overlay.changed.length}</span><span data-k="del"><i />删除 {br.overlay.removed.length}</span><span data-k="bad"><i />冲突 {br.overlay.conflicts.length}</span></div>
        <div className="rq-seg on-seg" role="group" aria-label="视图"><button aria-pressed={view === 'graph'} onClick={() => setView('graph')}><b>◎</b>本体图</button><button aria-pressed={view === 'tree'} onClick={() => setView('tree')}><b>≡</b>需求树</button></div>
      </header>
      <div className="on-main">
        <div className="on-views" data-count={compare ? 2 : 1} key={`${view}:${branch}:${compare}`}>
          {[branch, ...(compare ? [compare] : [])].map(b => { const ov = BRANCHES.find(x => x.name === b)!.overlay; return <div key={b} className="on-view">
            {compare && <span className="on-view-tag">⎇ {b}</span>}
            {view === 'graph' ? <Graph overlay={ov} node={node} impact={impact} onPick={id => { setNode(id); setImpact([]); }} /> : <Tree overlay={ov} node={node} onPick={setNode} />}
          </div>; })}
        </div>
        <NodePanel n={cur} br={br} onImpact={() => act('impact')} onExplain={() => act('explain')} onResolve={() => act('resolve')} />
      </div>
    </section>
    <AgentDock name="本体助手" target={`develop ⇐ ${branch}`} plan={{ stages: ['选择分支', '查看 WhatIf 叠加', '影响分析', '消解冲突'], current: br.overlay.conflicts.length ? 3 : 1 }}
      suggestions={suggestions} events={events} busy={busy} onSend={onSend} placeholder="例如：改档案场会影响哪些需求？" />
  </div>;
}

/* ———— 本体图（SVG，无 WebGL）———— */
function Graph({ overlay, node, impact, onPick }: { overlay: Overlay; node: string; impact: string[]; onPick: (id: string) => void }) {
  const nodes = [...BASE_NODES, ...overlay.added];
  const edges = [...BASE_EDGES, ...overlay.addedEdges];
  const at = (id: string) => nodes.find(n => n.id === id)!;
  const added = new Set(overlay.added.map(n => n.id)), bad = new Set(overlay.conflicts.map(c => c.node));
  return <div className="on-graph">
    <Crosshair />
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      {edges.map(e => { const p = at(e.a), q = at(e.b); const k = added.has(e.a) || added.has(e.b) ? 'add' : bad.has(e.a) || bad.has(e.b) ? 'bad' : overlay.removed.includes(e.a) || overlay.removed.includes(e.b) ? 'del' : undefined;
        return <line key={e.a + e.b} x1={p.x} y1={p.y} x2={q.x} y2={q.y} data-k={k} vectorEffect="non-scaling-stroke" />; })}
    </svg>
    {edges.map(e => { const p = at(e.a), q = at(e.b); return <span key={'l' + e.a + e.b} className="on-elabel" style={{ left: `${(p.x + q.x) / 2}%`, top: `${(p.y + q.y) / 2}%` }}>{e.label}</span>; })}
    {nodes.map((n, i) => { const k = added.has(n.id) ? 'add' : overlay.removed.includes(n.id) ? 'del' : overlay.changed.includes(n.id) ? 'chg' : undefined;
      return <button key={n.id} className="on-node" data-k={k} data-bad={bad.has(n.id) || undefined} data-impact={impact.includes(n.id) || undefined} aria-current={n.id === node || undefined}
        style={{ left: `${n.x}%`, top: `${n.y}%`, animationDelay: `${i * 40}ms` }} onClick={() => onPick(n.id)}>
        <small>{n.id}</small><b>{n.name}</b>{bad.has(n.id) && <i>▲</i>}
      </button>; })}
  </div>;
}

/* ———— 需求树：领域 → 需求 → 验收标准，标出引用的概念 ———— */
function Tree({ overlay, node, onPick }: { overlay: Overlay; node: string; onPick: (id: string) => void }) {
  const name = (id: string) => ONTOLOGY.find(c => c.id === id)?.name ?? id;
  const bad = new Set(overlay.conflicts.map(c => c.source.split(' · ').join(' · ')));
  return <div className="on-tree">{TREE.map(d => <section key={d.id}>
    <h4><b>{d.id.toUpperCase()}</b>{d.title}</h4>
    {d.reqs.map(r => <div key={r.id} className="on-req"><span><em>{r.id}</em>{r.title}</span>
      {r.acs.map(([ac, cs]) => <div key={ac} className="on-ac" data-bad={bad.has(`${r.id} · ${ac}`) || undefined}><em>{ac}</em>
        {cs.map(c => <button key={c} aria-current={c === node || undefined} data-k={overlay.changed.includes(c) ? 'chg' : overlay.removed.includes(c) ? 'del' : undefined} onClick={() => onPick(c)}>{name(c)}</button>)}
        {bad.has(`${r.id} · ${ac}`) && <i>▲ 冲突</i>}
      </div>)}
    </div>)}
  </section>)}</div>;
}

/* ———— 节点详情 ———— */
function NodePanel({ n, br, onImpact, onExplain, onResolve }: { n: Node; br: Branch; onImpact: () => void; onExplain: () => void; onResolve: () => void }) {
  const rel = [...BASE_EDGES, ...br.overlay.addedEdges].filter(e => e.a === n.id || e.b === n.id);
  const name = (id: string) => [...BASE_NODES, ...BRANCHES.flatMap(b => b.overlay.added)].find(x => x.id === id)?.name ?? id;
  const conflict = br.overlay.conflicts.filter(c => c.node === n.id);
  const state = br.overlay.added.some(x => x.id === n.id) ? '新增 · 草稿' : br.overlay.removed.includes(n.id) ? '本分支删除' : br.overlay.changed.includes(n.id) ? '本分支修改' : 'develop';
  return <aside className="on-node-panel" key={n.id}>
    <header><span className="rh-ph-no">03</span><span><small>{n.id} · {state}</small><b>{n.name}</b></span></header>
    <section><span className="rh-micro">DEFINITION · 定义</span><p>{n.def}</p></section>
    {n.rule && <section className="on-rule"><span className="rh-micro">CONSTRAINT · 约束</span><p>■ {n.rule}</p></section>}
    <section><span className="rh-micro">RELATIONS · 关系 {rel.length}</span><div className="on-rels">{rel.map(e => <span key={e.a + e.b}>{name(e.a)} <i>— {e.label} →</i> {name(e.b)}</span>)}</div></section>
    {conflict.map(c => <section key={c.source} className="on-conflict"><span className="rh-micro">▲ CONFLICT · {c.source}</span><p>{c.text}</p><div><button className="rh-btn" onClick={onExplain}>解释</button><button className="rh-btn is-solid" onClick={onResolve}>建议消解</button></div></section>)}
    <section className="on-trace-sec"><span className="rh-micro">TRACE · 追溯链</span><TraceList id={n.id} /></section>
    <button className="rh-btn on-impact" onClick={onImpact}>影响分析：改这个概念会波及什么 →</button>
  </aside>;
}
function TraceList({ id }: { id: string }) {
  const t = TRACE[id] ?? { reqs: [], issues: [], commits: [], cases: [] };
  const rows: [string, string[]][] = [['需求', t.reqs], ['issue', t.issues], ['提交', t.commits], ['用例', t.cases]];
  return <ol className="dv-trace">{rows.map(([k, v], i) => <li key={k}><em>{String(i + 1).padStart(2, '0')}</em><span><small>{k}</small>{v.length ? v.join(' · ') : '—'}</span></li>)}</ol>;
}
