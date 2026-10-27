import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import BenchFrame from '../BenchFrame';
import Explorer, { type ExplorerSection, type ExplorerViewDef } from '../engineering/Explorer';
import { Mobius } from '../../rhine/RhineMark';
import { scrollWithin } from '../scrollWithin';
import type { BenchProps } from '../WorkbenchStudio';
import Chart, { type ChartTheme } from './Chart';
import { DATASETS, HINTS, START_ENC, derive, typeOf, type Enc, type FieldType, type Table } from './dataModel';
import '../engineering/dev.css';
import './data.css';

// 数据台 DATA：布局与交互照搬 microsoft/data-formulator v0.7，只换莱茵生命的皮。
//  · 左：数据源侧栏（图标栏：数据 / 工作区 / 连接器 / Agent 知识 + 可收起的面板）
//  · 中：数据线程（顶部是源表架；每条分支一列，列里是时间线：提问 → Agent 说明 → 派生表与图；从中间某步再问就开新列，列首「接自」指回分叉点）。DataAgent 输入框固定在线程底部。
//  · 右：画布（只显示聚焦的那一项，可关闭）：浮动工具栏（缩放 · 样式变体 · 日志 / 代码 / 编码弹出面板）+ 图表与洞察标题 + 快速配置条 + 数据表（表头可拖进编码槽）。
// 全部为前端示例：派生规则在本地模拟。

type Node = { id: string; parent?: string; title: string; insight: string; table: Table; enc: Enc; ask?: string; code?: string; kind?: string; theme: ChartTheme; sorted?: boolean };
type Slot = 'x' | 'y' | 'color';
type Busy = { text: string; from: string; step: number };
const TYPE_GLYPH: Record<FieldType, string> = { quantitative: '#', temporal: '◷', nominal: 'Aa' };
const STEPS = ['理解问题', '写代码', '运行', '选图'];
let seq = 0; const uid = () => `n${++seq}`;
const svg = (d: ReactNode) => <svg viewBox="0 0 24 24">{d}</svg>;
const VIEWS: ExplorerViewDef[] = [
  { id: 'data', label: '数据', icon: svg(<><ellipse cx="12" cy="6" rx="7" ry="2.6" /><path d="M5 6v12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6M5 12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6" /></>) },
  { id: 'sessions', label: '工作区', icon: svg(<path d="M4 6h6l2 2h8v11H4z" />) },
  { id: 'connect', label: '连接器', icon: svg(<path d="M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0zM12 16v5" />) },
  { id: 'know', label: 'Agent 知识', icon: svg(<><path d="M5 4h11l3 3v13H5z" /><path d="M8 10h8M8 14h8M8 18h5" /></>) },
];

export default function DataStudio({ file, reduced, chrome }: BenchProps) {
  const base = useMemo(() => DATASETS[file % DATASETS.length](), [file]);
  const startEnc = START_ENC[file % START_ENC.length];
  const [nodes, setNodes] = useState<Node[]>(() => [{ id: 'root', title: base.name, insight: `${base.name} · ${base.rows.length} 行原始数据。问 DataAgent 一个问题开始探索。`, table: base, enc: startEnc, theme: 'ink' }]);
  const [focus, setFocus] = useState('root');
  const [canvas, setCanvas] = useState(true);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [miss, setMiss] = useState<{ text: string; from: string } | null>(null);
  const [face, setFace] = useState<'explore' | 'report'>('explore');
  const [fresh, setFresh] = useState<string | null>(null);
  const [xpOpen, setXpOpen] = useState(true), [xpView, setXpView] = useState('data');
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = (ms: number, fn: () => void) => { timers.current.push(window.setTimeout(fn, reduced ? 40 : ms)); };
  const node = nodes.find(n => n.id === focus)!;
  const patchNode = (p: Partial<Node>) => setNodes(ns => ns.map(n => n.id === focus ? { ...n, ...p } : n));
  const setEnc = (p: Partial<Enc>) => patchNode({ enc: { ...node.enc, ...p } });

  /** DataAgent：从聚焦的表出发；成功则长出子节点（从非末端出发即开新分支列）。 */
  const ask = (text: string, slot?: Slot) => {
    if (!text.trim() || busy) return;
    const from = node, d = derive(text, from.table);
    setMiss(null); setBusy({ text, from: from.id, step: 0 });
    STEPS.forEach((_, i) => later(260 * (i + 1), () => setBusy(b => b && { ...b, step: i + 1 })));
    later(1200, () => {
      setBusy(null);
      if (!d) { setMiss({ text, from: from.id }); return; }
      const table = d.apply(from.table), id = uid();
      const enc: Enc = { ...from.enc, ...d.enc, ...(slot ? { [slot]: d.name } : {}) };
      if (!enc.x || !enc.y || !table.cols.includes(enc.x) || !table.cols.includes(enc.y)) Object.assign(enc, { x: startEnc.x, y: startEnc.y, mark: startEnc.mark });
      if (!table.cols.includes(enc.x!) || !table.cols.includes(enc.y!)) Object.assign(enc, d.enc);
      if (enc.color && !table.cols.includes(enc.color)) enc.color = undefined;
      setNodes(ns => [...ns, { id, parent: from.id, title: d.kind === 'column' ? `+ ${d.name}` : d.name, insight: d.say, table, enc, ask: text, code: d.code, kind: d.kind, theme: 'ink' }]);
      setFocus(id); setCanvas(true); setFresh(d.name);
    });
  };
  const remove = (id: string) => { if (id === 'root' || nodes.some(n => n.parent === id)) return; const p = nodes.find(n => n.id === id)!.parent!; setNodes(ns => ns.filter(n => n.id !== id)); setFocus(p); };

  const sections: ExplorerSection[] = xpView === 'data' ? [
    { id: 'tables', title: '工作区里的表', count: nodes.length, grow: true, body: <div className="dfs-tables">{nodes.map(n => <button key={n.id} aria-current={n.id === focus || undefined} onClick={() => { setFocus(n.id); setCanvas(true); }}><i>{n.id === 'root' ? '源' : '派'}</i><span><b>{n.title}</b><small>{n.table.rows.length} 行 · {n.table.cols.length} 列</small></span></button>)}</div> },
    { id: 'add', title: '添加数据', body: <div className="dfs-add">{['上传 CSV / Excel', '粘贴文本或截图', '让 Agent 去找数据'].map(x => <button key={x}>＋ {x}</button>)}</div> },
  ] : xpView === 'sessions' ? [
    { id: 'ws', title: '保存的工作区', grow: true, body: <div className="dv-xp-list">{[[`${base.name} · 探索`, `刚才 · ${nodes.length} 张表`], ['研究台周报', '昨天 · 4 张表 · 6 个图'], ['京都行前分析', '上周 · 3 张表']].map(([a, b]) => <div key={a}><b>{a}</b><small>{b}</small></div>)}</div> },
  ] : xpView === 'connect' ? [
    { id: 'conn', title: '数据连接器', grow: true, body: <div className="dv-xp-list">{([['研究台 · results.tsv', '同步自 X—013 自研循环', true], ['PostgreSQL · reinlab_dev', 'localhost:5432 · 只读', true], ['S3 · rhine-archive', '未连接', false]] as [string, string, boolean][]).map(([a, b, on]) => <div key={a}><b><i data-on={on || undefined} />{a}</b><small>{b}</small></div>)}</div> },
  ] : [
    { id: 'k', title: 'Agent 知识 · 规则', grow: true, body: <ol className="dfs-know">{['val_bpb 越低越好，比较时纵轴不从 0 开始', '「保留」= 相对此前最优改进超过 0.0004', '日期统一按 YYYY-MM-DD 处理', '图表单色为主，只把派生出的重点系列标橙'].map(x => <li key={x}>{x}</li>)}</ol> },
  ];

  return <BenchFrame code="DATA" section="007" file={file} reduced={reduced} chrome={chrome} face={face} onFace={id => setFace(id as 'explore' | 'report')}
    faces={[{ id: 'explore', label: '探索', en: 'EXPLORE', badge: nodes.length - 1 }, { id: 'report', label: '报告', en: 'REPORT', locked: nodes.length < 2 }]}
    strip={<>{base.name} <i>·</i> {base.rows.length} 行 <i>·</i> 线程 {nodes.length - 1} 步 <i>·</i> 参照 Data Formulator</>}
    shutterLines={f => [`> load · ${base.name}`, `> face · ${f.en.toLowerCase()}`, '> ready']}
    status={<><span><i className="en-sq" />{base.name}</span><span>表 {nodes.length}</span><span>分支 {nodes.filter(n => n.id !== 'root' && !nodes.some(m => m.parent === n.id)).length}</span><span data-alert={!!busy || undefined}>{busy ? 'DataAgent 工作中' : '空闲'}</span><span>示例数据 · 不连接模型</span></>}>
    {face === 'report' ? <Report nodes={nodes} /> : <div className="df rh" data-canvas={canvas || undefined}>
      <Explorer code="DATA" views={VIEWS} open={xpOpen} view={xpView} onView={setXpView} onToggle={() => setXpOpen(v => !v)} title={base.name} sections={sections} badges={{ data: nodes.length }} />
      <Thread nodes={nodes} focus={focus} busy={busy} miss={miss} hints={HINTS[file % HINTS.length]} onFocus={id => { setFocus(id); setCanvas(true); }} onAsk={t => ask(t)} />
      {canvas && <Canvas key={focus} node={node} fresh={fresh} busy={!!busy} onClose={() => setCanvas(false)} onEnc={setEnc} onPatch={patchNode} onAsk={ask} onDelete={() => remove(node.id)} canDelete={node.id !== 'root' && !nodes.some(n => n.parent === node.id)} />}
    </div>}
  </BenchFrame>;
}

/* ———— 数据线程：源表架 + 每条分支一列 ———— */
function Thread({ nodes, focus, busy, miss, hints, onFocus, onAsk }: { nodes: Node[]; focus: string; busy: Busy | null; miss: { text: string; from: string } | null; hints: string[]; onFocus: (id: string) => void; onAsk: (t: string) => void }) {
  const root = nodes[0], byId = (id?: string) => nodes.find(n => n.id === id);
  const chainOf = (n: Node) => { const c: Node[] = []; for (let x: Node | undefined = n; x && x.id !== 'root'; x = byId(x.parent)) c.unshift(x); return c; };
  const leaves = nodes.filter(n => n.id !== 'root' && !nodes.some(m => m.parent === n.id));
  const pendingFrom = busy?.from ?? miss?.from;
  const pendingLeaf = !!pendingFrom && leaves.some(l => l.id === pendingFrom);
  const focusChain = new Set(chainOf(byId(focus) ?? root).map(n => n.id));
  const seen = new Set<string>();
  const cols = leaves.map(l => { const chain = chainOf(l), start = chain.findIndex(x => !seen.has(x.id)); const own = chain.slice(start); own.forEach(x => seen.add(x.id)); return { leaf: l, own, hl: chain.some(x => focusChain.has(x.id)) && focusChain.has(l.id) || l.id === focus || chain.some(x => x.id === focus) }; });
  const pending = (busy || miss) && <div className="dft-item is-pending">
    <p className="dft-ask"><i>你</i>{busy?.text ?? miss?.text}</p>
    {busy ? <div className="dft-thinking"><Mobius stages={STEPS} current={Math.min(busy.step, 3)} running width={60} /><ol>{STEPS.map((s, i) => <li key={s} data-s={i < busy.step ? 'done' : i === busy.step ? 'now' : undefined}>{s}</li>)}</ol></div>
      : <div className="dft-miss"><b>这个我推不出来</b><span>当前表里没有能支撑「{miss!.text}」的字段。试试：</span><div>{hints.map(h => <button key={h} onClick={() => onAsk(h)}>{h}</button>)}</div></div>}
  </div>;
  const colsBox = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = colsBox.current; el?.scrollTo({ left: el.scrollWidth, behavior: 'smooth' }); }, [nodes.length, !!busy]);
  return <section className="dft" data-wb-panel>
    <header className="dft-shelf">
      <span className="rh-micro">SOURCE · 源表</span>
      <button className="dft-src" aria-current={focus === 'root' || undefined} onClick={() => onFocus('root')}><span className="dft-src-chart"><Chart table={root.table} enc={root.enc} mini /></span><span><b>{root.title}</b><small>{root.table.rows.length} 行 · {root.table.cols.length} 列</small><em>{root.table.cols.join(' · ')}</em></span></button>
    </header>
    <div className="dft-cols" ref={colsBox}>
      {cols.length === 0 && !pending && <div className="dft-empty"><span className="rh-micro">DATA THREAD</span><b>从一个问题开始</b><span>在下面问 DataAgent，或者点一个建议。每次回答都会在这里长出一张新表，换个起点再问就会分出新的一列。</span></div>}
      {cols.map((c, k) => <div key={c.leaf.id} className="dft-col" data-hl={c.hl || undefined}>
        <span className="dft-col-head"><em>{String(k + 1).padStart(2, '0')}</em>分支 · {c.own.length} 步</span>
        {c.own[0]?.parent && c.own[0].parent !== 'root' && <button className="dft-from" onClick={() => onFocus(c.own[0].parent!)}>↳ 接自「{byId(c.own[0].parent)?.title}」</button>}
        {c.own.map(n => <div key={n.id} className="dft-item">
          {n.ask && <p className="dft-ask"><i>你</i>{n.ask}</p>}
          <p className="dft-turn"><i>AI</i>{n.insight}</p>
          <button className="dft-card" aria-current={n.id === focus || undefined} data-chain={focusChain.has(n.id) || undefined} onClick={() => onFocus(n.id)}>
            <header><b>{n.title}</b><small>{n.table.rows.length} 行 · {n.table.cols.length} 列</small></header>
            {n.table.derived.length > 0 && <span className="dft-newcols">{n.table.derived.map(d => <i key={d}>{d}</i>)}</span>}
            <span className="dft-card-chart"><Chart table={n.table} enc={n.enc} mini theme={n.theme} sorted={n.sorted} /></span>
          </button>
        </div>)}
        {pending && pendingLeaf && c.leaf.id === pendingFrom && pending}
      </div>)}
      {pending && !pendingLeaf && <div className="dft-col is-new"><span className="dft-col-head"><em>{String(cols.length + 1).padStart(2, '0')}</em>新分支</span>{pendingFrom !== 'root' && <span className="dft-from">↳ 接自「{byId(pendingFrom)?.title}」</span>}{pending}</div>}
    </div>
    <AgentInput anchor={byId(focus)!} busy={!!busy} hints={hints} onAsk={onAsk} />
  </section>;
}

/** DataAgent 输入：上方是「从哪张表继续」的标签，聚焦时弹出建议。 */
function AgentInput({ anchor, busy, hints, onAsk }: { anchor: Node; busy: boolean; hints: string[]; onAsk: (t: string) => void }) {
  const [q, setQ] = useState(''), [open, setOpen] = useState(false);
  const send = (t: string) => { if (!t.trim()) return; onAsk(t); setQ(''); setOpen(false); };
  return <form className="dfa" onSubmit={e => { e.preventDefault(); send(q); }}>
    {open && !busy && <div className="dfa-sugg"><span className="rh-micro">建议 · 从「{anchor.title}」继续</span>{hints.map(h => <button key={h} type="button" onMouseDown={e => { e.preventDefault(); send(h); }}>{h}</button>)}</div>}
    <span className="dfa-chip"><i>表</i>{anchor.title}<small>{anchor.table.rows.length} 行</small></span>
    <div className="dfa-box"><textarea value={q} rows={2} onChange={e => setQ(e.target.value)} onFocus={() => setOpen(true)} onBlur={() => window.setTimeout(() => setOpen(false), 120)}
      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(q); } }} placeholder="问 DataAgent：例如「累计最优」「按类别看保留率」" />
      <button className="rh-btn is-solid" disabled={!q.trim() || busy}>{busy ? '…' : '↵'}</button></div>
  </form>;
}

/* ———— 画布 ———— */
function Canvas({ node, fresh, busy, onClose, onEnc, onPatch, onAsk, onDelete, canDelete }: { node: Node; fresh: string | null; busy: boolean; onClose: () => void; onEnc: (p: Partial<Enc>) => void; onPatch: (p: Partial<Node>) => void; onAsk: (t: string, slot?: Slot) => void; onDelete: () => void; canDelete: boolean }) {
  const [zoom, setZoom] = useState(100);
  const [pop, setPop] = useState<'enc' | 'code' | 'log' | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  return <section className="dfc" data-wb-panel>
    <div className="dfc-bar">
      <span className="dfc-zoom"><button onClick={() => setZoom(z => Math.max(60, z - 20))} aria-label="缩小">−</button><b>{zoom}%</b><button onClick={() => setZoom(z => Math.min(140, z + 20))} aria-label="放大">＋</button></span>
      <span className="dfc-variants" role="group" aria-label="样式变体">{([['ink', '墨'], ['accent', '橙强调'], ['dark', '暗室']] as [ChartTheme, string][]).map(([k, l]) => <button key={k} aria-pressed={node.theme === k} data-v={k} onClick={() => onPatch({ theme: k })}><i />{l}</button>)}</span>
      <span className="dfc-right">
        {node.code && <button aria-pressed={pop === 'log'} onClick={() => setPop(p => p === 'log' ? null : 'log')}>日志</button>}
        {node.code && <button aria-pressed={pop === 'code'} onClick={() => setPop(p => p === 'code' ? null : 'code')}>代码</button>}
        <button className="is-enc" aria-pressed={pop === 'enc'} onClick={() => setPop(p => p === 'enc' ? null : 'enc')}>编码 ▾</button>
        <button className="dfc-close" onClick={onClose} aria-label="关闭画布">×</button>
      </span>
      {pop === 'enc' && <EncodingShelf node={node} drag={drag} busy={busy} onEnc={onEnc} onAsk={onAsk} />}
      {pop === 'code' && <div className="dfc-pop dfc-code"><span className="rh-micro">PY · 生成的代码</span><pre>{node.code}</pre></div>}
      {pop === 'log' && <div className="dfc-pop dfc-log"><span className="rh-micro">AGENT LOG</span><ol>{[`收到：「${node.ask}」`, '读取表结构与字段语义', `生成${node.kind === 'filter' ? '过滤' : node.kind === 'group' ? '聚合' : '派生列'}代码并在沙箱中运行`, `选图：${node.enc.mark === 'bar' ? '柱状' : node.enc.mark === 'line' ? '折线' : '散点'} · x=${node.enc.x} · y=${node.enc.y}`].map((x, i) => <li key={i}><em>{String(i + 1).padStart(2, '0')}</em>{x}</li>)}</ol></div>}
    </div>
    <div className="dfc-main" data-look={node.theme}>
      <div className="dfc-insight"><span className="rh-micro">{node.id === 'root' ? 'SOURCE' : node.kind === 'filter' ? 'FILTER' : node.kind === 'group' ? 'AGGREGATE' : 'DERIVE'}</span><h2>{node.title}</h2><p>{node.insight}</p></div>
      <div className="dfc-chart" style={{ height: `${zoom * 2.9}px` }}><Chart table={node.table} enc={node.enc} accent={fresh && node.table.derived.includes(fresh) ? fresh : node.table.derived.at(-1) ?? null} theme={node.theme} sorted={node.sorted} /></div>
      <div className="dfc-quick">
        <span className="dfc-marks">{([['point', '∴', '散点'], ['line', '∿', '折线'], ['bar', '▮', '柱状']] as [Enc['mark'], string, string][]).map(([k, g, l]) => <button key={k} aria-pressed={node.enc.mark === k} onClick={() => onEnc({ mark: k })}><b>{g}</b>{l}</button>)}</span>
        <label><input type="checkbox" checked={!!node.sorted} onChange={e => onPatch({ sorted: e.target.checked })} disabled={node.enc.mark !== 'bar'} />按值排序</label>
        <span className="dfc-agg">{([['mean', '平均'], ['sum', '合计'], ['count', '计数']] as [Enc['agg'], string][]).map(([k, l]) => <button key={k} aria-pressed={node.enc.agg === k} onClick={() => onEnc({ agg: k })}>{l}</button>)}</span>
        <button className="dfc-del" onClick={onDelete} disabled={!canDelete} title={canDelete ? '删除这一步' : '只能删除没有后续的步骤'}>删除</button>
      </div>
      <DataTable table={node.table} fresh={fresh} onDragField={setDrag} />
    </div>
  </section>;
}

/** 编码栏（弹出面板，对应 Data Formulator 的 EncodingShelfCard）：可从下方数据表的表头拖字段进来，或在槽里打新概念触发派生。 */
function EncodingShelf({ node, drag, busy, onEnc, onAsk }: { node: Node; drag: string | null; busy: boolean; onEnc: (p: Partial<Enc>) => void; onAsk: (t: string, slot?: Slot) => void }) {
  const [over, setOver] = useState<Slot | null>(null), [typing, setTyping] = useState<Record<Slot, string>>({ x: '', y: '', color: '' });
  const t = node.table;
  return <div className="dfc-pop dfe">
    <span className="rh-micro">ENCODING · 从下方表头拖字段进来，或打一个新概念</span>
    <div className="dfe-fields">{t.cols.map(c => <span key={c} draggable onDragStart={e => e.dataTransfer.setData('text/plain', c)} data-derived={t.derived.includes(c) || undefined}><i data-t={typeOf(t, c)}>{TYPE_GLYPH[typeOf(t, c)]}</i>{c}</span>)}</div>
    {(['x', 'y', 'color'] as Slot[]).map(s => { const v = node.enc[s]; return <div key={s} className={`dfe-slot${over === s || (drag && !v) ? ' is-over' : ''}`} onDragOver={e => { e.preventDefault(); setOver(s); }} onDragLeave={() => setOver(null)} onDrop={e => { e.preventDefault(); setOver(null); onEnc({ [s]: e.dataTransfer.getData('text/plain') }); }}>
      <em>{s === 'color' ? '颜色' : `${s} 轴`}</em>
      {v ? <span className="dfe-val" data-derived={t.derived.includes(v) || undefined}><i data-t={typeOf(t, v)}>{TYPE_GLYPH[typeOf(t, v)]}</i>{v}<button onClick={() => onEnc({ [s]: undefined })} aria-label="移除">×</button></span>
        : <form onSubmit={e => { e.preventDefault(); const q = typing[s].trim(); if (!q) return; if (t.cols.includes(q)) onEnc({ [s]: q }); else onAsk(q, s); setTyping(x => ({ ...x, [s]: '' })); }}><input value={typing[s]} disabled={busy} onChange={e => setTyping(x => ({ ...x, [s]: e.target.value }))} placeholder="拖入字段，或打一个新概念" /></form>}
    </div>; })}
  </div>;
}

function DataTable({ table, fresh, onDragField }: { table: Table; fresh: string | null; onDragField: (c: string | null) => void }) {
  const [sort, setSort] = useState<{ c: string; d: 1 | -1 } | null>(null);
  const rows = sort ? [...table.rows].sort((a, b) => (a[sort.c] > b[sort.c] ? 1 : -1) * sort.d) : table.rows;
  return <div className="dfc-table">
    <div className="dfc-dock"><b>{table.name}</b><small>{table.rows.length} 行 · {table.cols.length} 列 · 表头可拖进编码栏</small><button>导出 CSV</button></div>
    <div className="dfc-grid"><table><thead><tr><th>#</th>{table.cols.map(c => <th key={c} draggable onDragStart={e => { e.dataTransfer.setData('text/plain', c); onDragField(c); }} onDragEnd={() => onDragField(null)} data-derived={table.derived.includes(c) || undefined} data-new={fresh === c || undefined} onClick={() => setSort(s => s?.c === c ? { c, d: s.d === 1 ? -1 : 1 } : { c, d: 1 })}><i data-t={typeOf(table, c)}>{TYPE_GLYPH[typeOf(table, c)]}</i>{c}{sort?.c === c ? (sort.d === 1 ? ' ↑' : ' ↓') : ''}</th>)}</tr></thead>
      <tbody>{rows.slice(0, 60).map((r, i) => <tr key={i}><td>{i + 1}</td>{table.cols.map(c => <td key={c} data-derived={table.derived.includes(c) || undefined}>{String(r[c])}</td>)}</tr>)}</tbody></table></div>
  </div>;
}

function Report({ nodes }: { nodes: Node[] }) {
  const kids = nodes.filter(n => n.parent);
  return <div className="df-report en-report">
    <nav className="en-report-index"><span className="rh-micro">INDEX · 线程节点</span>{kids.map((n, i) => <button key={n.id} onClick={() => scrollWithin(document.getElementById(`df-r-${n.id}`), 'start')}><em>{String(i + 1).padStart(2, '0')}</em>{n.title}</button>)}</nav>
    <article className="rh-read en-report-body"><span className="rh-micro">DATA REPORT · 由数据线程整理 · {kids.length} 个发现</span><h2>{nodes[0].title} · 探索报告</h2>
      {kids.map((n, i) => <section key={n.id} id={`df-r-${n.id}`}><h3>{String(i + 1).padStart(2, '0')} · {n.title}</h3><p>{n.insight}</p><div className="df-r-chart"><Chart table={n.table} enc={n.enc} theme={n.theme} sorted={n.sorted} /></div><pre className="df-r-code">{n.code}</pre></section>)}
      <div className="ts-report-act"><button className="rh-btn is-solid">导出 md</button><button className="rh-btn">导出 notebook</button></div></article>
  </div>;
}
