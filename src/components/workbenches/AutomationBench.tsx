import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { BenchProps } from './WorkbenchStudio';
import './bench-automation.css';

/* ── A maintained library of scripts and workflows ── */
type Kind = 'trigger' | 'script' | 'agent' | 'branch' | 'approve' | 'output';
interface Node { id: string; kind: Kind; name: string; tool: string; col: number; row: number; code?: string[]; params?: [string, string][] }
type RunState = 'ok' | 'fail' | 'skip' | 'warn';
interface Run { id: string; at: string; took: string; state: RunState; note: string; log: string[]; rehearsal?: boolean }
interface Flow { id: string; name: string; group: number; trigger: string; kind: '定时' | '事件' | 'Webhook' | '手动'; times: number[]; lang: string; owner: string; version: string; history: string; nodes: Node[]; edges: [string, string, string?][]; secrets: string[]; runs: Run[]; versions: [string, string, string][] }
const GROUPS = ['资料整理', '研究汇总', '作品归档', '编排与接续'];
const LANG_MARK: Record<string, string> = { Python: 'PY', Shell: 'SH', Agent: 'AI', Node: 'JS' };

const collectCode = ['import feedparser, pathlib', 'from reinlab import archive', '', 'def collect(since):', '    items = []', '    for url in archive.feeds("research"):', '        items += [e for e in feedparser.parse(url).entries', '                  if e.published_parsed > since]', '    items += list(pathlib.Path("~/Inbox").expanduser().glob("*.pdf"))', '    return dedupe(items)'];
const FLOWS: Flow[] = [
  { id: 'WF-01', name: '每日资料整理', group: 0, trigger: '每天 08:30', kind: '定时', times: [8.5], lang: 'Python', owner: 'RSCH', version: 'v1.4', history: 'oooowoooxooooo',
    nodes: [
      { id: 'T', kind: 'trigger', name: '每天 08:30', tool: 'cron · 30 8 * * *', col: 0, row: 0 },
      { id: 'S1', kind: 'script', name: '收集新资料', tool: 'collect.py', col: 1, row: 0, code: collectCode, params: [['since', '上次成功运行'], ['inbox', '~/Inbox']] },
      { id: 'B1', kind: 'branch', name: '有新资料？', tool: 'len(items) > 0', col: 2, row: 0 },
      { id: 'S2', kind: 'agent', name: '摘要与标签', tool: 'Agent · 摘要模板 v3', col: 3, row: 0, code: ['# prompt: summarize.md', '对每份资料：', '- 三句话摘要，保留数字', '- 从 tags.yaml 选 1–3 个标签', '- 无法归类时标记 needs_review'], params: [['model', 'reinlab-default'], ['max_items', '40']] },
      { id: 'A1', kind: 'approve', name: '人工确认', tool: '待确认 ≥ 1 时', col: 4, row: 0 },
      { id: 'O1', kind: 'output', name: '写入 R—014', tool: 'archive.write()', col: 5, row: 0, code: ['archive.write("R—014", entries,', '              mode="append", dry_run=False)'] },
      { id: 'O2', kind: 'output', name: '记录空跑', tool: 'log.info()', col: 3, row: 1 },
    ], edges: [['T', 'S1'], ['S1', 'B1'], ['B1', 'S2', '是'], ['B1', 'O2', '否'], ['S2', 'A1'], ['A1', 'O1']], secrets: ['ARCHIVE_TOKEN', 'FEED_COOKIE'],
    runs: [
      { id: 'R-0412', at: '今天 08:30', took: '1m 42s', state: 'ok', note: '12 份资料 · 3 份待确认', log: ['08:30:00 trigger cron', '08:30:02 S1 collect → 12 items', '08:30:03 B1 → 是', '08:31:20 S2 summarized 12, needs_review 3', '08:31:42 A1 waiting for approval'] },
      { id: 'R-0411', at: '昨天 08:30', took: '2m 05s', state: 'warn', note: '2 份无法归类', log: ['08:30:00 trigger cron', '08:30:04 S1 collect → 15 items', '08:32:01 S2 needs_review 2', '08:32:05 O1 wrote 13'] },
      { id: 'R-0410', at: '10-07 08:30', took: '0m 41s', state: 'fail', note: 'feed 超时 · 已重试 2 次', log: ['08:30:00 trigger cron', '08:30:30 S1 timeout feeds.arxiv', '08:30:35 retry 1/2', '08:30:41 S1 failed: TimeoutError'] },
    ], versions: [['v1.4', '10-05', '摘要改用模板 v3'], ['v1.3', '09-28', '加入人工确认节点'], ['v1.2', '09-20', '去重改为按 DOI']] },
  { id: 'WF-02', name: 'PDF 收件箱归档', group: 0, trigger: '文件夹变动', kind: '事件', times: [9.2, 13.6, 17.1], lang: 'Shell', owner: 'RSCH', version: 'v0.9', history: 'ooooooooooooo-',
    nodes: [{ id: 'T', kind: 'trigger', name: '~/Inbox 新文件', tool: 'fswatch', col: 0, row: 0 }, { id: 'S1', kind: 'script', name: '重命名', tool: 'rename.sh', col: 1, row: 0, code: ['#!/usr/bin/env bash', 'for f in "$@"; do', '  title=$(pdfinfo "$f" | awk -F: \'/Title/{print $2}\')', '  mv "$f" "$ARCHIVE/$(date +%F)-${title// /_}.pdf"', 'done'] }, { id: 'O1', kind: 'output', name: '移入资料库', tool: '$ARCHIVE', col: 2, row: 0 }],
    edges: [['T', 'S1'], ['S1', 'O1']], secrets: [], runs: [{ id: 'R-0098', at: '今天 13:36', took: '0m 02s', state: 'ok', note: '1 个文件', log: ['13:36:10 rename 1 file'] }], versions: [['v0.9', '09-30', '初版']] },
  { id: 'WF-03', name: '研究周报', group: 1, trigger: '每周五 18:00', kind: '定时', times: [18], lang: 'Agent', owner: 'RSCH', version: 'v2.0', history: 'oooooo-oooooo-',
    nodes: [{ id: 'T', kind: 'trigger', name: '周五 18:00', tool: 'cron · 0 18 * * 5', col: 0, row: 0 }, { id: 'S1', kind: 'script', name: '读取本周变动', tool: 'diff_week.py', col: 1, row: 0, code: ['changes = archive.changes(since=week_start())', 'experiments = runs.query(week=current)'] }, { id: 'S2', kind: 'agent', name: '起草周报', tool: 'Agent · 周报模板', col: 2, row: 0, code: ['# 只引用已确认的证据', '# 每条结论附实验编号'] }, { id: 'A1', kind: 'approve', name: '人工确认', tool: '必需', col: 3, row: 0 }, { id: 'O1', kind: 'output', name: '发到研究档案', tool: 'archive.write()', col: 4, row: 0 }],
    edges: [['T', 'S1'], ['S1', 'S2'], ['S2', 'A1'], ['A1', 'O1']], secrets: ['ARCHIVE_TOKEN'], runs: [{ id: 'R-0040', at: '10-03 18:00', took: '3m 10s', state: 'ok', note: '周报草稿 1 份', log: ['18:00 start', '18:03 draft ready'] }], versions: [['v2.0', '09-26', '改为 Agent 起草']] },
  { id: 'WF-04', name: '实验结果入库', group: 1, trigger: 'POST /runs', kind: 'Webhook', times: [2, 2.4, 3.1, 4.6, 11.2], lang: 'Node', owner: 'DATA', version: 'v1.1', history: 'ooooxxoooooooo',
    nodes: [{ id: 'T', kind: 'trigger', name: 'POST /runs', tool: 'webhook', col: 0, row: 0 }, { id: 'S1', kind: 'script', name: '校验与写库', tool: 'ingest.ts', col: 1, row: 0, code: ['const run = RunSchema.parse(req.body);', "await db.insert('runs', run);"] }, { id: 'O1', kind: 'output', name: 'runs 表', tool: 'PostgreSQL', col: 2, row: 0 }],
    edges: [['T', 'S1'], ['S1', 'O1']], secrets: ['DATABASE_URL', 'WEBHOOK_SECRET'], runs: [{ id: 'R-1203', at: '今天 11:12', took: '0m 01s', state: 'ok', note: 'EXP-026', log: ['11:12 insert runs#1203'] }], versions: [['v1.1', '10-01', '加 schema 校验']] },
  { id: 'WF-05', name: '作品定稿归档', group: 2, trigger: '画墙标记定稿', kind: '事件', times: [21.2], lang: 'Python', owner: 'CRTV', version: 'v1.0', history: '-----o----x--o',
    nodes: [{ id: 'T', kind: 'trigger', name: '标记定稿', tool: 'event · creative.final', col: 0, row: 0 }, { id: 'S1', kind: 'script', name: '导出与封面', tool: 'cover.py', col: 1, row: 0, code: ['export(final, formats=["png", "pdf"])', 'cover = make_cover(final, template="rhine")'] }, { id: 'A1', kind: 'approve', name: '人工确认', tool: '必需', col: 2, row: 0 }, { id: 'O1', kind: 'output', name: '作品档案', tool: 'C—008', col: 3, row: 0 }],
    edges: [['T', 'S1'], ['S1', 'A1'], ['A1', 'O1']], secrets: [], runs: [{ id: 'R-0012', at: '10-05 21:14', took: '0m 48s', state: 'ok', note: 'V-04 已整理', log: ['21:14 export ok'] }, { id: 'R-0011', at: '10-02 16:40', took: '0m 31s', state: 'fail', note: '缺少定稿标记', log: ['16:40 missing final flag'] }], versions: [['v1.0', '10-01', '初版']] },
  { id: 'WF-06', name: '探索照片回收', group: 2, trigger: '每天 22:00', kind: '定时', times: [22], lang: 'Python', owner: 'EXPL', version: 'v0.3', history: '--------oooo--', nodes: [{ id: 'T', kind: 'trigger', name: '每天 22:00', tool: 'cron', col: 0, row: 0 }, { id: 'S1', kind: 'script', name: '按 GPS 归到站点', tool: 'geotag.py', col: 1, row: 0, code: ['for p in photos: p.stop = nearest_stop(p.gps)'] }, { id: 'O1', kind: 'output', name: '旅程档案', tool: 'P—013', col: 2, row: 0 }], edges: [['T', 'S1'], ['S1', 'O1']], secrets: [], runs: [], versions: [['v0.3', '10-06', '草稿']] },
  { id: 'WF-07', name: '明日接续清单', group: 3, trigger: '手动 / 每天 23:30', kind: '手动', times: [23.5], lang: 'Agent', owner: 'ALL', version: 'v1.2', history: 'oooooooooooooo', nodes: [{ id: 'T', kind: 'trigger', name: '每天 23:30', tool: 'cron', col: 0, row: 0 }, { id: 'S1', kind: 'script', name: '盘点未完成', tool: 'todo_scan.py', col: 1, row: 0, code: ['open_items = [f for b in benches for f in b.files if not f.done]'] }, { id: 'S2', kind: 'agent', name: '排序与交接说明', tool: 'Agent', col: 2, row: 0, code: ['# 截止日期优先，其次是阻塞他人的事项'] }, { id: 'O1', kind: 'output', name: '明日起点', tool: '首页', col: 3, row: 0 }], edges: [['T', 'S1'], ['S1', 'S2'], ['S2', 'O1']], secrets: [], runs: [{ id: 'R-0301', at: '昨天 23:30', took: '0m 22s', state: 'ok', note: '7 项', log: ['23:30 7 items'] }], versions: [['v1.2', '10-04', '加入阻塞优先']] },
  { id: 'WF-08', name: '依赖与磁盘巡检', group: 3, trigger: '每周一 07:00', kind: '定时', times: [7], lang: 'Shell', owner: 'ENGR', version: 'v1.0', history: 'o------o------', nodes: [{ id: 'T', kind: 'trigger', name: '周一 07:00', tool: 'cron', col: 0, row: 0 }, { id: 'S1', kind: 'script', name: 'npm outdated · df -h', tool: 'check.sh', col: 1, row: 0, code: ['npm outdated --json > outdated.json', 'df -h ~ | tail -1'] }, { id: 'O1', kind: 'output', name: '提醒', tool: '通知', col: 2, row: 0 }], edges: [['T', 'S1'], ['S1', 'O1']], secrets: [], runs: [], versions: [['v1.0', '09-22', '初版']] },
];
const KIND_LABEL: Record<Kind, string> = { trigger: '触发', script: '脚本', agent: '智能体', branch: '条件', approve: '审批', output: '输出' };
const HOUR = new Date().getHours() + new Date().getMinutes() / 60;

export default function AutomationBench({ file, reduced }: BenchProps) {
  const [flows, setFlows] = useState(FLOWS.map(f => ({ ...f, enabled: f.version !== 'v0.3' })));
  const [selId, setSelId] = useState(() => FLOWS.find(f => f.group === file)!.id);
  const [filter, setFilter] = useState<'all' | 'issue' | Flow['kind']>('all');
  const [query, setQuery] = useState('');
  const flow = flows.find(f => f.id === selId)!;
  const [nodeId, setNodeId] = useState(() => flow.nodes.find(n => n.code)?.id ?? flow.nodes[0].id);
  const [tab, setTab] = useState<'code' | 'config' | 'runs' | 'versions'>('code');
  const [live, setLive] = useState<string | null>(null);
  const [passed, setPassed] = useState<string[]>([]);
  const [runSel, setRunSel] = useState(0);
  const timers = useRef<number[]>([]);
  const canvasRef = useRef<HTMLDivElement>(null);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  useEffect(() => { setNodeId(flow.nodes.find(n => n.code)?.id ?? flow.nodes[0].id); setRunSel(0); setLive(null); setPassed([]); }, [selId]); // eslint-disable-line react-hooks/exhaustive-deps
  const node = flow.nodes.find(n => n.id === nodeId) ?? flow.nodes[0];

  const shown = flows.filter(f => (filter === 'all' || (filter === 'issue' ? f.history.slice(-5).includes('x') : f.kind === filter)) && (f.name.includes(query) || f.id.toLowerCase().includes(query.toLowerCase())));
  const next = useMemo(() => flows.filter(f => f.enabled).flatMap(f => f.times.map(t => ({ f, t: t > HOUR ? t : t + 24 }))).sort((a, b) => a.t - b.t)[0], [flows]);
  const failing = flows.filter(f => f.history.slice(-5).includes('x')).length;

  function rehearse() {
    // Walk the main path (branches take their first edge) and light each node in turn.
    const path: string[] = []; let cur: string | undefined = flow.nodes[0].id;
    while (cur && !path.includes(cur)) { path.push(cur); cur = flow.edges.find(e => e[0] === cur)?.[1]; }
    setPassed([]);
    path.forEach((id, i) => timers.current.push(window.setTimeout(() => { setLive(id); setPassed(p => [...p, ...path.slice(0, i)]); }, (reduced ? 0 : 520) * i)));
    timers.current.push(window.setTimeout(() => {
      setLive(null); setPassed(path);
      setFlows(list => list.map(f => f.id === flow.id ? { ...f, runs: [{ id: `PRE-${String(f.runs.length + 1).padStart(2, '0')}`, at: '刚才', took: `${(path.length * .5).toFixed(1)}s`, state: 'ok', note: '预演 · 未执行任何脚本，未写入', log: path.map((id, k) => `+${(k * .5).toFixed(1)}s ${id} ${flow.nodes.find(n => n.id === id)!.name} · dry-run`), rehearsal: true }, ...f.runs] } : f));
      setTab('runs'); setRunSel(0);
    }, (reduced ? 0 : 520) * path.length));
  }

  // Canvas geometry: scale the flow to the canvas; wrap onto a new band only when it would get too small.
  const CW = 128, CH = 70, GX = 26, GY = 24;
  const [avail, setAvail] = useState(900);
  useLayoutEffect(() => {
    const el = canvasRef.current; if (!el) return;
    const measure = () => setAvail(el.clientWidth - 8);
    measure(); const ro = new ResizeObserver(measure); ro.observe(el); return () => ro.disconnect();
  }, []);
  const cols = Math.max(...flow.nodes.map(n => n.col)) + 1, rows = Math.max(...flow.nodes.map(n => n.row)) + 1;
  const fullW = 40 + cols * (CW + GX);
  const perRow = avail / fullW >= .78 ? cols : Math.max(2, Math.floor((avail / .9 - 40) / (CW + GX)));
  const bandH = rows * (CH + GY) + 34;
  const pos = (n: Node) => ({ x: 20 + (n.col % perRow) * (CW + GX), y: 24 + Math.floor(n.col / perRow) * bandH + n.row * (CH + GY) });
  const needW = 40 + Math.min(cols, perRow) * (CW + GX), needH = 36 + Math.ceil(cols / perRow) * bandH;
  const fit = Math.min(1.15, avail / needW);

  return <div className="au">
    <div className="au-summary">
      <span><b className="num">{flows.length}</b>个流程</span>
      <span><b className="num">{flows.filter(f => f.enabled).length}</b>启用</span>
      <span className={failing ? 'au-bad' : ''}><b className="num">{failing}</b>近 5 次有失败</span>
      <span><small>下一次</small>{next ? <><b className="mono">{String(Math.floor(next.t % 24)).padStart(2, '0')}:{String(Math.round((next.t % 1) * 60)).padStart(2, '0')}</b>{next.f.name}</> : '—'}</span>
      <span className="au-summary-gap" />
      <span className="chip sim">执行器未接入 · 只能预演</span>
    </div>

    <aside className="p au-lib">
      <header className="p-h"><b>脚本与流程</b><span>LIBRARY</span></header>
      <div className="au-lib-tools"><input placeholder="查找流程" value={query} onChange={e => setQuery(e.target.value)} aria-label="查找流程" />
        <div className="au-filters">{([['all', '全部'], ['issue', '异常'], ['定时', '定时'], ['事件', '事件'], ['Webhook', 'Hook'], ['手动', '手动']] as const).map(([k, n]) => <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>{n}</button>)}</div></div>
      <div className="p-body scroll-thin">{GROUPS.map((g, gi) => { const items = shown.filter(f => f.group === gi); if (!items.length) return null; return <div key={g} className="au-group"><span>{String(gi + 1).padStart(2, '0')} · {g}</span>
        {items.map(f => <button key={f.id} className="au-item" aria-current={f.id === selId || undefined} onClick={() => setSelId(f.id)}>
          <span className="au-item-top"><em className="mono">{f.id}</em><b>{f.name}</b><i className="au-lang">{LANG_MARK[f.lang]}</i></span>
          <span className="au-item-mid"><small>{f.kind} · {f.trigger}</small>{!f.enabled && <small className="au-off">已停用</small>}</span>
          <span className="au-hist" aria-label="最近 14 次运行">{f.history.split('').map((c, i) => <i key={i} data-s={c} />)}</span>
        </button>)}</div>; })}</div>
    </aside>

    <section className="au-center">
      <div className="p au-flow">
        <header className="au-flow-head">
          <em className="mono">{flow.id}</em><b>{flow.name}</b><span className="chip">{flow.kind} · {flow.trigger}</span><span className="chip">{flow.lang}</span><span className="chip">{flow.version}</span><span className="chip">归属 {flow.owner}</span>
          <label className="au-toggle"><input type="checkbox" checked={flow.enabled} onChange={e => setFlows(l => l.map(f => f.id === flow.id ? { ...f, enabled: e.target.checked } : f))} /><i />{flow.enabled ? '启用' : '停用'}</label>
          <button className="b solid" onClick={rehearse} disabled={!!live}>{live ? '预演中…' : '预演'}</button>
          <button className="b" disabled title="需要接入执行器">立即运行</button>
        </header>
        <div className="au-canvas scroll-thin" ref={canvasRef}>
          <div className="au-canvas-in" style={{ width: needW, height: needH, transform: `scale(${fit})`, marginBottom: needH * (fit - 1) }}>
            <svg width={needW} height={needH} aria-hidden="true">
              {flow.edges.map(([a, b, label]) => { const A = pos(flow.nodes.find(n => n.id === a)!), B = pos(flow.nodes.find(n => n.id === b)!); const x1 = A.x + CW, y1 = A.y + CH / 2, x2 = B.x, y2 = B.y + CH / 2; const done = passed.includes(a) && (passed.includes(b) || live === b);
                const d = y1 === y2 && x2 > x1 ? `M${x1} ${y1} H${x2}` : x2 > x1 ? `M${A.x + CW / 2} ${A.y + CH} V${y2} H${x2}` : `M${x1} ${y1} H${x1 + 14} V${B.y - 14} H${x2 - 18} V${y2} H${x2}`;
                return <g key={a + b} className={done ? 'on' : ''}><path d={d} /><path d={`M${x2 - 6} ${y2 - 4} L${x2} ${y2} L${x2 - 6} ${y2 + 4}`} />{label && <text x={y1 === y2 && x2 > x1 ? (x1 + x2) / 2 - 6 : A.x + CW / 2 + 6} y={y1 === y2 && x2 > x1 ? y1 - 6 : A.y + CH + 16}>{label}</text>}</g>; })}
            </svg>
            {flow.nodes.map(n => { const p = pos(n); return <button key={n.id} className="au-node" data-kind={n.kind} aria-pressed={n.id === node.id} data-live={live === n.id || undefined} data-passed={passed.includes(n.id) || undefined} style={{ left: p.x, top: p.y, width: CW, height: CH }} onClick={() => { setNodeId(n.id); if (n.code || n.params) setTab('code'); }}>
              <span className="mono">{KIND_LABEL[n.kind]} · {n.id}</span><b>{n.name}</b><small className="mono">{n.tool}</small>
            </button>; })}
          </div>
        </div>
      </div>

      <div className="p au-gantt">
        <header className="p-h"><b>调度总图</b><span>今日 00:00 – 24:00 · 当前 {String(Math.floor(HOUR)).padStart(2, '0')}:{String(Math.floor((HOUR % 1) * 60)).padStart(2, '0')}</span></header>
        <div className="au-gantt-body">
          <div className="au-hours">{Array.from({ length: 9 }, (_, i) => <span key={i} style={{ left: `${(i * 3) / 24 * 100}%` }}>{String(i * 3).padStart(2, '0')}</span>)}</div>
          {flows.map(f => <button key={f.id} className="au-row" aria-current={f.id === selId || undefined} onClick={() => setSelId(f.id)}><span className="au-row-name">{f.name}</span><span className="au-row-track">{f.times.map(t => <i key={t} data-past={t < HOUR || undefined} data-state={t < HOUR ? (f.history.at(-1) === 'x' && t === f.times.filter(x => x < HOUR).at(-1) ? 'fail' : 'ok') : 'plan'} data-off={!f.enabled || undefined} style={{ left: `${t / 24 * 100}%` }} />)}</span></button>)}
          <div className="au-now" style={{ left: `calc(132px + (100% - 132px) * ${HOUR / 24})` }} />
        </div>
      </div>
    </section>

    <aside className="p au-inspect">
      <div className="tabs" role="tablist">{([['code', '脚本'], ['config', '配置'], ['runs', '运行'], ['versions', '版本']] as const).map(([k, n]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{n}{k === 'runs' && <em>{flow.runs.length}</em>}</button>)}</div>
      <div className="p-body scroll-thin au-inspect-body">
        {tab === 'code' && <><div className="au-node-head"><span className="chip ink">{KIND_LABEL[node.kind]}</span><b>{node.name}</b><small className="mono">{node.tool}</small></div>
          {node.code ? <pre className="au-code mono">{node.code.map((l, i) => <span key={i}><i>{i + 1}</i>{l || ' '}</span>)}</pre> : <p className="au-muted">这个节点没有脚本。{node.kind === 'approve' ? '运行到这里会暂停，等待你在通知里确认。' : node.kind === 'branch' ? `条件：${node.tool}` : ''}</p>}
          {node.params && <dl className="kv au-params">{node.params.map(([k, v]) => [<dt key={k}>{k}</dt>, <dd key={k + 'v'} className="mono">{v}</dd>])}</dl>}</>}
        {tab === 'config' && <dl className="kv au-config">
          <dt>触发</dt><dd>{flow.kind} · {flow.trigger}</dd><dt>超时</dt><dd>10 分钟</dd><dt>重试</dt><dd>2 次 · 间隔 30 秒</dd><dt>并发</dt><dd>同一流程只跑一个</dd><dt>失败时</dt><dd>通知 · 不写入档案</dd>
          <dt>密钥</dt><dd>{flow.secrets.length ? flow.secrets.map(s => <span key={s} className="au-secret mono">{s}<i>••••••</i></span>) : '无'}<small className="au-muted">从密钥库引用，页面上不显示明文</small></dd>
          <dt>写入</dt><dd>{flow.nodes.some(n => n.kind === 'approve') ? '写入前需人工确认' : '直接写入'}</dd></dl>}
        {tab === 'runs' && <div className="au-runs">{flow.runs.length ? <><ol>{flow.runs.map((r, i) => <li key={r.id + r.at}><button aria-pressed={i === runSel} onClick={() => setRunSel(i)}><span className={`dot ${r.state === 'ok' ? 'ok' : r.state === 'fail' ? 'fail' : 'idle'}`} /><em className="mono">{r.id}</em><span>{r.at}</span><small className="mono">{r.took}</small>{r.rehearsal && <i className="chip sim">预演</i>}</button></li>)}</ol>
          <div className="au-log"><span>{flow.runs[runSel]?.note}</span><pre className="mono">{flow.runs[runSel]?.log.join('\n')}</pre></div></> : <p className="au-muted">还没有运行记录。可以先预演一遍。</p>}</div>}
        {tab === 'versions' && <ol className="au-versions">{flow.versions.map(([v, d, note], i) => <li key={v}><b className="mono">{v}</b><span>{d}</span><p>{note}</p>{i > 0 ? <button className="b ghost" disabled title="预览中不修改流程">回滚到此版本</button> : <span className="chip ink">当前</span>}</li>)}</ol>}
      </div>
    </aside>
  </div>;
}
