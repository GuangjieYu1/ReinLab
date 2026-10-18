import React, { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import AgentDock, { type DockDraft, type DockEvent, type Suggestion } from '../AgentDock';
import { scrollWithin } from '../scrollWithin';
import { Mobius } from '../../rhine/RhineMark';
import { BASELINE, DIRECTORY, FLOWS, ONTOLOGY, KIND_LABEL, ORDER, SECTION, initialDocs, inspect, isComplete, reply, suggest, terms, type Block, type BlockKind, type Flow, type Note, type ReqDoc } from './model';
import Explorer, { Tree, type ExplorerSection, type ExplorerView, type TreeNode } from './Explorer';
import './requirements.css';

// 工程台 · 需求面
// 左：需求文档目录（双击打开，可收起）· 中：文档编辑区（可两列并排对照）· 右：需求助手。
// 写需求时实时补全（Tab 接受）；写完整的段落变绿；写完点「校验」，把 diff 通过 MCP 交给本体论模型；
// 模型的意见以标注钉在原文上，点选项自动修正，或写下理由「短提交」——每个分支是一个会话，下一轮校验记得你说过什么。

const clock = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
let seq = 0; const uid = () => `e${++seq}`;
const BRANCH = 'req/REQ-012';
const ONTOLOGY_COUNT = ONTOLOGY.length;
const MCP = { server: 'ontology-checker', transport: 'stdio', command: 'npx @rhine/ontology-mcp --repo .', tool: 'check_consistency' };
type Ping = { doc: string; block: string; n: number };

/** 与 develop 相比改动过的块。 */
function changedBlocks(docs: Record<string, ReqDoc>) {
  const out: { doc: string; block: Block }[] = [];
  for (const d of Object.values(docs)) {
    const base = BASELINE[d.id];
    for (const b of d.blocks) { const was = base?.blocks.find(x => x.id === b.id); if (!was || was.text !== b.text) out.push({ doc: d.id, block: b }); }
  }
  return out;
}

export default function RequirementsFace({ onCounts, reduced }: { onIssues: (n: number) => void; onCounts: (c: { req: number; conflicts: number; mr: number }) => void; reduced: boolean }) {
  const [docs, setDocs] = useState(initialDocs);
  const [panes, setPanes] = useState<string[]>(['REQ-012']);
  const [focus, setFocus] = useState(0);
  const [dirOpen, setDirOpen] = useState(true);
  const [picked, setPicked] = useState('REQ-012');
  const [notes, setNotes] = useState<Note[]>([]);
  const [rounds, setRounds] = useState<{ n: number; at: string; sent: number; found: number }[]>([]);
  const [checking, setChecking] = useState(false);
  const [explained, setExplained] = useState<Set<string>>(new Set());
  const [ping, setPing] = useState<Ping | null>(null);
  const [mcpOpen, setMcpOpen] = useState<'mcp' | 'session' | null>(null);
  const [busy, setBusy] = useState(false);
  const [events, setEvents] = useState<DockEvent[]>(() => [{ id: uid(), kind: 'agent', at: '09:40', text: <p>我在维护分支 <b>{BRANCH}</b>。写需求时我会在光标后给出补全，按 <kbd>Tab</kbd> 接受；写完点上方的「校验」，我把改动交给本体论模型。也可以问我「帮我找到调阅档案的全流程」。</p> }]);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = (ms: number, fn: () => void) => { timers.current.push(window.setTimeout(fn, reduced ? Math.min(ms, 60) : ms)); };

  const changed = useMemo(() => changedBlocks(docs), [docs]);
  const open = notes.filter(n => n.state === 'open');
  const round = rounds.length;
  useEffect(() => { onCounts({ req: open.length || (round ? 0 : 1), conflicts: open.filter(n => n.kind === 'conflict').length, mr: 0 }); }, [open.length, round, notes, onCounts]);

  const push = (e: DockDraft) => { const id = e.id ?? uid(); setEvents(list => [...list, { ...e, id } as DockEvent]); return id; };
  const patch = (id: string, p: Partial<DockEvent>) => setEvents(list => list.map(e => e.id === id ? { ...e, ...p } as DockEvent : e));
  const say = (text: ReactNode) => push({ kind: 'agent', text, at: clock() });

  const setText = useCallback((doc: string, block: string, text: string) => setDocs(d => ({ ...d, [doc]: { ...d[doc], blocks: d[doc].blocks.map(b => b.id === block ? { ...b, text } : b) } })), []);
  const addBlock = useCallback((doc: string, after: string, kind: BlockKind) => {
    let id = '';
    setDocs(d => {
      const blocks = d[doc].blocks, n = blocks.filter(b => b.kind === kind).length + 1;
      id = SECTION[kind].label(n);
      while (blocks.some(b => b.id === id)) id = `${id}′`;
      const at = after ? blocks.findIndex(b => b.id === after) + 1 : blocks.reduce((k, b, i) => b.kind === kind ? i + 1 : k, blocks.findIndex(b => ORDER.indexOf(b.kind) > ORDER.indexOf(kind)) < 0 ? blocks.length : blocks.findIndex(b => ORDER.indexOf(b.kind) > ORDER.indexOf(kind)));
      return { ...d, [doc]: { ...d[doc], blocks: [...blocks.slice(0, at), { id, kind, text: '' }, ...blocks.slice(at)] } };
    });
    return () => id;
  }, []);
  const removeBlock = useCallback((doc: string, block: string) => setDocs(d => ({ ...d, [doc]: { ...d[doc], blocks: d[doc].blocks.filter(b => b.id !== block) } })), []);

  /** 打开文档：并排时打开到当前聚焦的那一列。 */
  const openDoc = (id: string, at = focus) => { setPanes(p => { const next = [...p]; next[Math.min(at, p.length - 1)] = id; return next; }); setPicked(id); };
  /** 跳到原文：并排时打开到右列（不顶掉正在写的文档），否则打开到当前列。 */
  const jump = (doc: string, block: string) => {
    let at = panes.indexOf(doc);
    if (at < 0) { at = panes.length > 1 ? 1 : 0; openDoc(doc, at); }
    setFocus(at); setPing({ doc, block, n: Date.now() });
  };
  const toggleSplit = () => setPanes(p => p.length > 1 ? [p[focus] ?? p[0]] : [p[0], p[0] === 'REQ-013' ? 'REQ-010' : 'REQ-013']);

  /* ———— 校验：diff → MCP → 本体论模型 → 标注 ———— */
  const runCheck = () => {
    if (checking) return;
    const sent = changed.filter(c => c.block.text.trim());
    setChecking(true); setMcpOpen(null);
    const tool = push({ kind: 'tool', action: `mcp:${MCP.server}/${MCP.tool}`, label: `提交 diff · ${sent.length} 处改动`, state: 'running' }); const t0 = performance.now();
    later(1600, () => {
      const found: Note[] = sent.flatMap(c => inspect(c.doc, c.block, explained).map(n => ({ ...n, state: 'open' as const, round: round + 1, thread: [{ who: 'model' as const, text: n.detail }] })));
      setNotes(prev => [...prev.filter(n => n.state === 'explained'), ...found]);
      setRounds(r => [...r, { n: r.length + 1, at: clock(), sent: sent.length, found: found.length }]);
      setChecking(false);
      patch(tool, { state: 'done', ms: performance.now() - t0, detail: found.length ? `${found.length} 条标注` : '通过' } as Partial<DockEvent>);
      if (found.length) {
        const first = found[0]; jump(first.doc, first.block);
        say(<p>第 {round + 1} 轮校验：本体论模型提出 {found.length} 条意见，已标注在原文上。{explained.size ? `你上一轮说明过的 ${explained.size} 条，它记得，没有再提。` : ''}点选项可以自动修正；不认同的，在标注里写下理由再短提交。</p>);
      } else say(<p>第 {round + 1} 轮校验通过：{sent.length} 处改动与本体一致，内部逻辑自洽。可以提交 MR 了。</p>);
    });
  };
  const applyOption = (note: Note, i: number) => {
    const opt = note.options[i];
    setText(note.doc, note.block, opt.text);
    setNotes(ns => ns.map(n => n.key === note.key ? { ...n, state: 'fixed', thread: [...n.thread, { who: 'me', text: `采用：${opt.label}` }] } : n));
    setPing({ doc: note.doc, block: note.block, n: Date.now() });
  };
  const shortSubmit = (note: Note, text: string) => {
    setNotes(ns => ns.map(n => n.key === note.key ? { ...n, thread: [...n.thread, { who: 'me', text }] } : n));
    const tool = push({ kind: 'tool', action: `mcp:${MCP.server}/reply`, label: `短提交 · ${note.doc} ${note.block}`, detail: `会话 ${BRANCH} · 第 ${round} 轮`, state: 'running' }); const t0 = performance.now();
    later(900, () => {
      const r = reply(note, text);
      setNotes(ns => ns.map(n => n.key === note.key ? { ...n, state: r.accept ? 'explained' : 'open', thread: [...n.thread, { who: 'model', text: r.text }] } : n));
      if (r.accept) setExplained(s => new Set(s).add(note.key));
      patch(tool, { state: 'done', ms: performance.now() - t0, detail: r.accept ? '模型接受，已记入会话' : '模型追问' } as Partial<DockEvent>);
    });
  };

  /* ———— 助手 ———— */
  const showFlow = (flow: Flow) => {
    push({ kind: 'tool', action: 'req_trace_flow', label: `检索「${flow.title}」`, detail: `${new Set(flow.steps.map(s => s.doc)).size} 份文档 · ${flow.steps.length} 处原文`, state: 'done', ms: 640 });
    say(<p>「{flow.title}」的全流程在下面，点任意一步跳到原文{panes.length > 1 ? '（打开在右列）' : ''}。</p>);
    push({ kind: 'card', body: <FlowCard flow={flow} docs={docs} onJump={jump} /> });
  };
  const onSend = (text: string) => {
    push({ kind: 'user', text, at: clock() });
    setBusy(true);
    later(700, () => {
      setBusy(false);
      const flow = FLOWS.find(f => f.keywords.test(text));
      if (flow && /流程|找|在哪|哪些|怎么/.test(text)) return showFlow(flow);
      if (/缺|没写完|未完成/.test(text)) {
        const left = Object.values(docs).flatMap(d => d.blocks.filter(b => !isComplete(b)).map(b => ({ doc: d.id, b })));
        return say(<><p>还没写完的有 {left.length} 段：</p><p>{left.map(x => <b key={x.doc + x.b.id} className="ad-ref" onClick={() => jump(x.doc, x.b.id)}>{x.doc} {x.b.id}</b>).reduce<ReactNode[]>((a, n, i) => i ? [...a, '、', n] : [n], [])}</p></>);
      }
      if (/校验|检查/.test(text)) { say(<p>好，开始第 {round + 1} 轮校验。</p>); return runCheck(); }
      if (flow) return showFlow(flow);
      say(<p>我可以：找某个功能的全流程（例如「帮我找到调阅档案的全流程」）、列出还没写完的需求、发起校验。</p>);
    });
  };
  const stage = open.length ? 2 : round && !open.length ? (changed.length ? 3 : 4) : changed.some(c => !isComplete(c.block)) ? 0 : 1;
  const suggestions: Suggestion[] = [
    { id: 'f1', label: '找到「调阅档案」全流程', onClick: () => onSend('帮我找到调阅档案的全流程') },
    { id: 'f2', label: '找到「键盘浏览」全流程', onClick: () => onSend('帮我找到键盘浏览的全流程') },
    { id: 'm', label: '还有哪些没写完', onClick: () => onSend('还有哪些需求没写完？') },
  ];

  return <div className="rq rh" data-dir={dirOpen ? 'open' : 'closed'}>
    <Directory open={dirOpen} onToggle={() => setDirOpen(v => !v)} docs={docs} picked={picked} panes={panes} changed={changed}
      onPick={setPicked} onOpen={id => openDoc(id)} />
    <section className="rq-center" data-wb-panel>
      <header className="rq-bar" data-checking={checking || undefined}>
        <div className="rq-bar-id"><b>CTRL</b><small>EDITOR<br />编辑区</small></div>
        <div className="rq-seg" role="group" aria-label="列数">
          <button aria-pressed={panes.length === 1} onClick={() => panes.length > 1 && toggleSplit()}><b>1</b>单列</button>
          <button aria-pressed={panes.length > 1} onClick={() => panes.length === 1 && toggleSplit()}><b>2</b>并排对照</button>
        </div>
        <span className="rh-micro rq-bar-hint">双击目录打开到{panes.length > 1 ? `第 ${focus + 1} 列` : '编辑区'}</span>
        <div className="rq-bar-right">
          <button className="rq-node" aria-expanded={mcpOpen === 'mcp'} onClick={() => setMcpOpen(v => v === 'mcp' ? null : 'mcp')}>
            <small>MCP NODE</small><b><i className="rq-dot is-on" />{MCP.server}</b>
          </button>
          <button className="rq-node" aria-expanded={mcpOpen === 'session'} onClick={() => setMcpOpen(v => v === 'session' ? null : 'session')}>
            <small>SESSION · {BRANCH}</small><b>ROUND {String(round).padStart(2, '0')}</b>
          </button>
          <button className="rq-verify" onClick={runCheck} disabled={checking} data-busy={checking || undefined}>
            {checking ? <Mobius stages={['diff', 'MCP', '推理', '标注']} current={2} running width={58} /> : <i />}
            <span><b>{checking ? 'VERIFYING' : 'VERIFY'}</b><small>{checking ? '本体论模型检查中…' : `校验 · ${changed.length} 处改动`}</small></span>
            <em>{checking ? '' : '▸'}</em>
          </button>
        </div>
        {mcpOpen === 'mcp' && <McpPanel onClose={() => setMcpOpen(null)} />}
        {mcpOpen === 'session' && <SessionPanel rounds={rounds} explained={notes.filter(n => n.state === 'explained')} onJump={jump} />}
      </header>
      <div className="rq-panes" data-count={panes.length}>
        {panes.map((id, i) => <Pane key={i} index={i} doc={docs[id]} focused={i === focus} split={panes.length > 1} notes={notes.filter(n => n.doc === id)}
          ping={ping?.doc === id ? ping : null} checking={checking ? changed.filter(c => c.doc === id).map(c => c.block.id) : []}
          onFocus={() => setFocus(i)} onClose={() => { setPanes(p => p.filter((_, k) => k !== i)); setFocus(0); }}
          onText={(b, t) => setText(id, b, t)} onAdd={(after, kind) => addBlock(id, after, kind)} onRemove={b => removeBlock(id, b)}
          onOption={applyOption} onReply={shortSubmit} />)}
      </div>
    </section>
    <AgentDock name="需求助手" target={`分支 ${BRANCH} · 会话第 ${round} 轮 · ${changed.length} 处改动`} plan={{ stages: ['编写需求', '校验', '处理标注', '再次校验', '提交 MR'], current: stage }}
      suggestions={suggestions} events={events} busy={busy} onSend={onSend} placeholder="例如：帮我找到调阅档案的全流程" />
  </div>;
}

/* ———— 01 资源管理器：和 IDE 一样的文件目录 ———— */
function Directory({ open, onToggle, docs, picked, panes, changed, onPick, onOpen }: {
  open: boolean; onToggle: () => void; docs: Record<string, ReqDoc>; picked: string; panes: string[]; changed: { doc: string; block: Block }[];
  onPick: (id: string) => void; onOpen: (id: string) => void;
}) {
  const [view, setView] = useState<ExplorerView>('files');
  const [q, setQ] = useState('');
  const changedDocs = [...new Set(changed.map(c => c.doc))];
  const file = (id: string): TreeNode => {
    const d = docs[id], done = d.blocks.filter(isComplete).length;
    return { name: `${id}.md`, path: id, title: d.title, badge: !BASELINE[id] ? 'A' : changedDocs.includes(id) ? 'M' : undefined,
      meta: <span className="rq-xp-meta" data-full={done === d.blocks.length || undefined}>{done}/{d.blocks.length}</span> };
  };
  const tree: TreeNode[] = [{ name: 'requirements', path: 'requirements', children: [
    ...DIRECTORY.map(g => ({ name: g.id, path: `requirements/${g.id}`, title: g.title, children: g.docs.map(file) })),
    { name: 'README.md', path: 'requirements/README.md', title: '需求写法约定' },
  ] }, { name: 'ontology', path: 'ontology', children: [{ name: 'concepts.yaml', path: 'ontology/concepts.yaml', title: `${ONTOLOGY_COUNT} 个概念` }] }];
  const openDoc = (p: string) => { if (docs[p]) onOpen(p); };
  const pick = (p: string) => { if (docs[p]) onPick(p); };
  const sections: ExplorerSection[] = view === 'files' ? [
    { id: 'open', title: '打开的编辑器', count: panes.length, body: <Tree nodes={panes.map((id, i) => ({ ...file(id), path: id, name: `${id}.md`, meta: <span className="rq-xp-meta">第 {i + 1} 列</span> }))} active={picked} onOpen={openDoc} /> },
    { id: 'tree', title: 'reinlab · 需求', grow: true, actions: <><button title="新建需求">＋</button></>, body: <Tree nodes={tree} active={picked} open={panes} onSelect={pick} onOpen={openDoc} /> },
    { id: 'changes', title: `改动 · ${BRANCH}`, count: changed.length, body: changedDocs.length ? <Tree nodes={changedDocs.map(id => ({ ...file(id), meta: <span className="rq-xp-meta">{changed.filter(c => c.doc === id).length} 段</span> }))} active={picked} onSelect={pick} onOpen={openDoc} /> : <p className="xp-empty">没有改动</p> },
  ] : view === 'search' ? [
    { id: 'search', title: '搜索需求', grow: true, body: <><div className="xp-search"><input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="文档号、标题…" /></div><Tree nodes={tree} filter={q} active={picked} onSelect={pick} onOpen={openDoc} /></> },
  ] : view === 'git' ? [
    { id: 'branch', title: '分支', body: <div className="rq-xp-git"><b>⎇ {BRANCH}</b><span>基于 develop @ a1f3c9 · 每个分支一个校验会话</span></div> },
    { id: 'staged', title: '改动', count: changed.length, grow: true, body: <div className="rq-xp-changes">{changed.map(c => <button key={c.doc + c.block.id} onClick={() => onOpen(c.doc)}><b className="xp-badge" data-b={BASELINE[c.doc]?.blocks.some(b => b.id === c.block.id) ? 'M' : 'A'}>{BASELINE[c.doc]?.blocks.some(b => b.id === c.block.id) ? 'M' : 'A'}</b><em>{c.doc} · {c.block.id}</em><span>{c.block.text || '（空）'}</span></button>)}</div> },
  ] : [
    { id: 'concepts', title: '本体概念', count: ONTOLOGY_COUNT, grow: true, body: <div className="rq-xp-onto">{ONTOLOGY.map(c => <div key={c.id}><em>{c.id}</em><b>{c.name}</b><span>{c.def}</span>{c.rule && <small>■ {c.rule}</small>}</div>)}</div> },
  ];
  return <Explorer open={open} view={view} onView={setView} onToggle={onToggle} title={`requirements · ${Object.keys(docs).length} 份`} sections={sections} badges={{ git: changed.length || undefined }} />;
}

/* ———— 文档列 ———— */
function Pane({ index, doc, focused, split, notes, ping, checking, onFocus, onClose, onText, onAdd, onRemove, onOption, onReply }: {
  index: number; doc: ReqDoc; focused: boolean; split: boolean; notes: Note[]; ping: Ping | null; checking: string[];
  onFocus: () => void; onClose: () => void; onText: (block: string, text: string) => void; onAdd: (after: string, kind: BlockKind) => () => string; onRemove: (block: string) => void;
  onOption: (n: Note, i: number) => void; onReply: (n: Note, text: string) => void;
}) {
  const body = useRef<HTMLDivElement>(null);
  const [want, setWant] = useState<{ id: string; at: 'end' | 'start' } | null>(null);
  useEffect(() => { if (ping) scrollWithin(body.current?.querySelector(`[data-block="${ping.block}"]`), 'center'); }, [ping]);
  const done = doc.blocks.filter(isComplete).length;
  return <section className="rq-pane rh-panel" data-focused={focused || undefined} onFocusCapture={onFocus} onMouseDown={onFocus}>
    <header className="rq-dossier" key={`h-${doc.id}`}>
      <span className="rq-dossier-ghost" aria-hidden="true">{doc.id.split('-')[1]}</span>
      <div className="rq-dossier-no"><small>{String(index + 2).padStart(2, '0')} · REQUIREMENT</small><b aria-label={doc.id}><Decode text={doc.id.replace('-', '—')} /></b></div>
      <div className="rq-dossier-title"><strong>{doc.title}</strong><span>{doc.path}<i>·</i>⎇ {doc.branch}</span></div>
      <div className="rq-dossier-gauge" title="写完的段落">
        <span><b>{String(done).padStart(2, '0')}</b><i>/</i><em>{String(doc.blocks.length).padStart(2, '0')}</em></span>
        <small>WRITTEN · 写完</small>
        <i className="rq-ticks">{doc.blocks.map((b, k) => <i key={k} data-done={isComplete(b) || undefined} data-note={notes.some(n => n.block === b.id && n.state === 'open') || undefined} />)}</i>
      </div>
      {split && <button className="rq-close" onClick={onClose} aria-label="关闭这一列">×</button>}
    </header>
    <div className="rq-pane-body" ref={body} key={`b-${doc.id}`}>
      <i className="rq-scan" aria-hidden="true" />
      <i className="rq-crop" data-c="tl" /><i className="rq-crop" data-c="tr" />
      <div className="rq-legend rh-micro"><b>LEGEND</b><span><i className="is-done" />写完</span><span><i />编写中</span><span><i className="is-note" />有标注</span><span className="rq-legend-tab"><kbd>TAB</kbd> 接受补全<i>·</i><kbd>ENTER</kbd> 新段落<i>·</i><kbd>ESC</kbd> 放弃</span></div>
      {ORDER.map(kind => {
        const rows = doc.blocks.filter(b => b.kind === kind);
        if (!rows.length && kind !== 'ac') return null;
        return <section key={kind} className="rq-sec">
          <h3 className="rq-sec-head"><b>{kind === 'ac' ? 'AC' : kind === 'story' ? 'ST' : kind === 'rule' ? 'RC' : kind === 'nfr' ? 'NF' : 'OQ'}<i /></b><span><strong>{SECTION[kind].zh}</strong><small>{SECTION[kind].en} · {String(rows.length).padStart(2, '0')}</small></span><i className="rq-sec-line" /></h3>
          {rows.map(b => <BlockRow key={b.id} order={doc.blocks.indexOf(b)} block={b} notes={notes.filter(n => n.block === b.id)} ping={ping?.block === b.id ? ping.n : 0} working={checking.includes(b.id)}
            autofocus={want?.id === b.id ? want.at : null} onFocused={() => setWant(null)}
            onText={t => onText(b.id, t)} onEnter={() => { const get = onAdd(b.id, b.kind); requestAnimationFrame(() => setWant({ id: get(), at: 'start' })); }}
            onRemove={() => { const i = doc.blocks.findIndex(x => x.id === b.id); const prev = doc.blocks[i - 1]; onRemove(b.id); if (prev) setWant({ id: prev.id, at: 'end' }); }}
            onOption={onOption} onReply={onReply} />)}
          {(kind === 'ac' || kind === 'open') && <button className="rq-add" onClick={() => { const get = onAdd('', kind); requestAnimationFrame(() => setWant({ id: get(), at: 'start' })); }}>＋ 添加{SECTION[kind].zh}</button>}
        </section>;
      })}
    </div>
  </section>;
}

/* ———— 一段需求：可编辑、实时补全、写完变绿、标注 ———— */
function BlockRow({ order, block, notes, ping, working, autofocus, onFocused, onText, onEnter, onRemove, onOption, onReply }: {
  order: number; block: Block; notes: Note[]; ping: number; working: boolean; autofocus: 'start' | 'end' | null; onFocused: () => void;
  onText: (t: string) => void; onEnter: () => void; onRemove: () => void; onOption: (n: Note, i: number) => void; onReply: (n: Note, text: string) => void;
}) {
  const area = useRef<HTMLTextAreaElement>(null), mirror = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  const [ghost, setGhost] = useState('');
  const [thinking, setThinking] = useState(false);
  const composing = useRef(false);
  const timer = useRef(0);
  const complete = isComplete(block);
  const openNotes = notes.filter(n => n.state === 'open');
  // 刚写完的那一刻：一道绿光扫过这一段。
  const was = useRef(complete);
  const [justDone, setJustDone] = useState(0);
  useEffect(() => { if (complete && !was.current) setJustDone(Date.now()); was.current = complete; }, [complete]);

  useLayoutEffect(() => {
    if (!autofocus || !area.current) return;
    const el = area.current, at = autofocus === 'end' ? el.value.length : 0;
    el.focus({ preventScroll: false }); el.setSelectionRange(at, at); onFocused();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autofocus]);
  // 实时补全：停顿 280ms 后，光标在段末时请求一次（本地模拟模型）。
  const ask = (text: string) => {
    window.clearTimeout(timer.current); setGhost('');
    const el = area.current; if (!el || composing.current || el.selectionStart !== text.length) return;
    setThinking(true);
    timer.current = window.setTimeout(() => { setThinking(false); if (area.current && area.current.selectionStart === area.current.value.length) setGhost(suggest(area.current.value, block.kind)); }, 280);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const accept = () => { if (!ghost) return false; const t = block.text + ghost; onText(t); setGhost(''); requestAnimationFrame(() => { area.current?.setSelectionRange(t.length, t.length); ask(t); }); return true; };

  // 未聚焦时渲染层可交互（悬停术语看定义）；点一下把光标放到点击处。
  const placeCaret = (e: React.MouseEvent) => {
    const el = area.current, m = mirror.current; if (!el || !m || focused) return;
    if ((e.target as HTMLElement).closest('.rq-term-card')) return;
    e.preventDefault();
    let offset = block.text.length;
    const r = (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint?.(e.clientX, e.clientY);
    if (r && m.contains(r.startContainer)) {
      const walk = document.createTreeWalker(m, NodeFilter.SHOW_TEXT, { acceptNode: n => (n.parentElement?.closest('[data-skip]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
      let sum = 0, node: Node | null;
      while ((node = walk.nextNode())) { if (node === r.startContainer) { offset = sum + r.startOffset; break; } sum += node.textContent?.length ?? 0; }
    }
    el.focus(); el.setSelectionRange(offset, offset);
  };

  // 渲染层：标注片段（波浪线）→ 本体术语（下划线）。
  const marks = openNotes.map(n => ({ q: n.quote, kind: n.kind })).filter(m => m.q && block.text.includes(m.q));
  const parts: { text: string; kind?: string }[] = [];
  let rest = block.text;
  while (rest) {
    const hit = marks.map(m => ({ ...m, i: rest.indexOf(m.q) })).filter(m => m.i >= 0).sort((a, b) => a.i - b.i)[0];
    if (!hit) { parts.push({ text: rest }); break; }
    if (hit.i) parts.push({ text: rest.slice(0, hit.i) });
    parts.push({ text: hit.q, kind: hit.kind }); rest = rest.slice(hit.i + hit.q.length);
  }

  return <div className="rq-block" style={{ '--i': Math.min(order, 14) } as React.CSSProperties} data-block={block.id} data-state={openNotes.length ? 'note' : complete ? 'done' : 'draft'} data-has-notes={notes.length ? true : undefined}>
    {ping ? <i className="en-ring" key={ping} /> : null}
    {justDone ? <i className="rq-donesweep" key={justDone} aria-hidden="true" /> : null}
    <span className="rq-gutter" aria-hidden="true"><i /></span>
    <span className="rq-label">{block.id}</span>
    <div className={`rq-edit${working ? ' rh-working' : ''}`} onMouseDown={placeCaret}>
      <div className="rq-mirror" ref={mirror} data-focused={focused || undefined}>
        {parts.map((p, i) => <span key={i} className={p.kind ? 'rq-mark' : undefined} data-kind={p.kind}>
          {terms(p.text).map((s, k) => s.concept
            ? <span key={k} className="rq-term" tabIndex={-1}>{s.text}<span className="rq-term-card" data-skip><span className="rh-micro">{s.concept.id} · 本体概念</span><b>{s.concept.name}</b>{s.concept.def}{s.concept.rule && <em>■ {s.concept.rule}</em>}<span className="rq-term-rel">{s.concept.rel.map(r => <i key={r}>{r}</i>)}</span></span></span>
            : <Fragment key={k}>{s.text}</Fragment>)}
        </span>)}
        {focused && ghost && <span className="rq-ghost" data-skip>{ghost}<kbd>Tab</kbd></span>}
        {focused && thinking && !ghost && <span className="rq-thinking" data-skip>▍</span>}
        {!block.text && !ghost && <span className="rq-placeholder" data-skip>{block.kind === 'ac' ? 'Given … · When … · Then …' : '写下这一段…'}</span>}
        {'​'}
      </div>
      <textarea ref={area} value={block.text} rows={1} spellCheck={false} aria-label={`${block.id} ${SECTION[block.kind].zh}`}
        onFocus={() => { setFocused(true); ask(block.text); }} onBlur={() => { setFocused(false); setGhost(''); setThinking(false); window.clearTimeout(timer.current); }}
        onChange={e => { const t = e.target.value.replace(/\n/g, ''); onText(t); ask(t); }}
        onSelect={e => { const el = e.currentTarget; if (el.selectionStart !== el.value.length) { setGhost(''); window.clearTimeout(timer.current); setThinking(false); } else if (!ghost && !thinking && el.selectionStart === el.selectionEnd) ask(el.value); }}
        onCompositionStart={() => { composing.current = true; setGhost(''); }} onCompositionEnd={e => { composing.current = false; ask(e.currentTarget.value); }}
        onKeyDown={e => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Tab' && ghost) { e.preventDefault(); accept(); }
          else if (e.key === 'Escape' && ghost) { e.preventDefault(); setGhost(''); }
          else if (e.key === 'Enter') { e.preventDefault(); if (ghost) accept(); else onEnter(); }
          else if (e.key === 'Backspace' && !block.text) { e.preventDefault(); onRemove(); }
        }} />
    </div>
    {notes.length > 0 && <div className="rq-notes" style={{ '--i': Math.min(order, 14) } as React.CSSProperties}>{notes.map(n => <NoteCard key={n.key} note={n} onOption={i => onOption(n, i)} onReply={t => onReply(n, t)} />)}</div>}
  </div>;
}

/* ———— 标注：模型的意见、修改选项、你的理由（短提交）———— */
function NoteCard({ note, onOption, onReply }: { note: Note; onOption: (i: number) => void; onReply: (text: string) => void }) {
  const [draft, setDraft] = useState('');
  const [expand, setExpand] = useState(note.state === 'open');
  useEffect(() => { setExpand(note.state === 'open'); }, [note.state]);
  const pending = note.thread[note.thread.length - 1]?.who === 'me' && note.state === 'open';
  if (!expand) return <button className="rq-note is-folded" data-kind={note.kind} data-state={note.state} onClick={() => setExpand(true)}>
    <span>{note.state === 'fixed' ? '已修正' : '已说明 · 模型已记住'}</span><b>{note.title}</b>
  </button>;
  return <article className="rq-note rh-enter" data-kind={note.kind} data-state={note.state}>
    <header><i />{KIND_LABEL[note.kind]}<em>R{String(note.round).padStart(2, '0')} · {note.block}</em>{note.state !== 'open' && <button onClick={() => setExpand(false)} aria-label="收起">−</button>}</header>
    <strong>{note.title}</strong>
    <div className="rq-thread">{note.thread.map((m, i) => <p key={i} data-who={m.who}><i>{m.who === 'model' ? '本体' : '你'}</i>{m.text}</p>)}{pending && <p data-who="model" className="rq-wait"><i>本体</i>…</p>}</div>
    {note.state === 'open' && <>
      <div className="rq-options">{note.options.map((o, i) => <button key={o.label} onClick={() => onOption(i)} title={o.text}><em>{String.fromCharCode(65 + i)}</em>{o.label}</button>)}</div>
      <form className="rq-reply" onSubmit={e => { e.preventDefault(); if (draft.trim()) { onReply(draft.trim()); setDraft(''); } }}>
        <input value={draft} onChange={e => setDraft(e.target.value)} placeholder="不接受？写下你的理由…" />
        <button className="rh-btn" disabled={!draft.trim()}>短提交</button>
      </form>
    </>}
  </article>;
}

/** 解密：档案号先乱码，再从左到右逐位定格（设计语言 §6.3，300ms）。 */
const GLYPHS = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789—';
function Decode({ text }: { text: string }) {
  const [shown, setShown] = useState(text);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setShown(text); return; }
    let frame = 0; const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / 340), fixed = Math.floor(p * text.length);
      setShown(text.split('').map((c, i) => i < fixed || p >= 1 ? c : GLYPHS[(i * 7 + Math.floor(now / 40)) % GLYPHS.length]).join(''));
      if (p < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [text]);
  return <>{shown}</>;
}

/* ———— MCP 配置与会话 ———— */
function McpPanel({ onClose }: { onClose: () => void }) {
  const [tested, setTested] = useState<'idle' | 'busy' | 'ok'>('idle');
  return <div className="rq-pop rq-mcp" role="dialog" aria-label="本体论模型 · MCP 配置">
    <span className="rh-micro">ONTOLOGY MODEL · 通过 MCP 配置</span>
    <dl>
      <dt>服务</dt><dd><code>{MCP.server}</code></dd>
      <dt>传输</dt><dd><code>{MCP.transport}</code></dd>
      <dt>命令</dt><dd><code>{MCP.command}</code></dd>
      <dt>工具</dt><dd><code>{MCP.tool}</code> · <code>reply</code></dd>
      <dt>会话</dt><dd>每个分支一个会话 · <code>session = {BRANCH}</code></dd>
    </dl>
    <pre>{`{\n  "mcpServers": {\n    "${MCP.server}": {\n      "command": "npx",\n      "args": ["@rhine/ontology-mcp", "--repo", "."]\n    }\n  }\n}`}</pre>
    <div className="rq-pop-act">
      <button className="rh-btn" onClick={() => { setTested('busy'); window.setTimeout(() => setTested('ok'), 700); }}>{tested === 'busy' ? '连接中…' : tested === 'ok' ? '■ 已连接 · 2 个工具' : '测试连接'}</button>
      <button className="rh-btn is-ghost" onClick={onClose}>关闭</button>
    </div>
    <small>示例数据 · 不连接真实模型</small>
  </div>;
}
function SessionPanel({ rounds, explained, onJump }: { rounds: { n: number; at: string; sent: number; found: number }[]; explained: Note[]; onJump: (doc: string, block: string) => void }) {
  return <div className="rq-pop rq-session" role="dialog" aria-label="分支会话">
    <span className="rh-micro">SESSION · {BRANCH}</span>
    {rounds.length ? <ol>{rounds.map(r => <li key={r.n}><em>第 {r.n} 轮</em><span>{r.at}</span><span>提交 {r.sent} 处</span><b>{r.found ? `${r.found} 条标注` : '通过'}</b></li>)}</ol> : <p>还没有校验过。</p>}
    <span className="rh-micro">会话记住的说明 · {explained.length}</span>
    {explained.length ? explained.map(n => <button key={n.key} onClick={() => onJump(n.doc, n.block)}><em>{n.doc} {n.block}</em>{n.thread.filter(m => m.who === 'me').slice(-1)[0]?.text}</button>) : <p>你在标注里写下的理由会出现在这里，下一轮校验会带上。</p>}
  </div>;
}

/* ———— 助手回复里的交互卡片：功能全流程 ———— */
function FlowCard({ flow, docs, onJump }: { flow: Flow; docs: Record<string, ReqDoc>; onJump: (doc: string, block: string) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const [visited, setVisited] = useState<Set<number>>(new Set());
  const used = [...new Set(flow.steps.map(s => s.doc))];
  return <div className="rq-flow">
    <span className="rh-micro">FLOW · 功能全流程 · {flow.steps.length} 步 · 跨 {used.length} 份文档</span>
    <strong>{flow.title}</strong>
    <div className="rq-flow-docs">{used.map(d => <span key={d} data-on={hover !== null && flow.steps[hover].doc === d || undefined}><b>{d}</b>{docs[d]?.title}</span>)}</div>
    <ol>{flow.steps.map((s, i) => {
      const b = docs[s.doc]?.blocks.find(x => x.id === s.block);
      return <li key={i}>
        <button onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onClick={() => { setVisited(v => new Set(v).add(i)); onJump(s.doc, s.block); }} data-visited={visited.has(i) || undefined}>
          <em>{String(i + 1).padStart(2, '0')}</em>
          <span><code>{s.doc} · {s.block}</code><b>{s.note}</b><small>{b?.text ?? '（原文已删除）'}</small></span>
          <i>跳到原文 →</i>
        </button>
      </li>;
    })}</ol>
  </div>;
}
