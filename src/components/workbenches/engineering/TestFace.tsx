import { useEffect, useRef, useState, type ReactNode } from 'react';
import AgentDock, { type DockDraft, type DockEvent, type Risk, type Suggestion } from '../AgentDock';
import { Mobius } from '../../rhine/RhineMark';
import Explorer, { type ExplorerSection, type ExplorerView } from './Explorer';
import { API_CASES, CASES, DRAFTS, ENVS, LAST_BATCH, QUEUE, RECORDING, REQ_TITLE, STATUS_LABEL, type ApiCase, type Case, type Env, type Status } from './testModel';
import './test.css';

// 工程台 · 测试面：用例由需求的验收标准生成。
// 左：资源管理器（测试队列 · 用例树，每个用例三个环境的状态格）· 中：用例详情（失败定位）/ 录制回放 / 接口 / 矩阵 · 报告 · 右：测试助手。
// 按钮与测试助手共用同一张动作表；批量运行时显示莫比乌斯。

type ActionId = 'run_batch' | 'rerun_failed' | 'run_mobile' | 'gen_cases' | 'gen_api_cases' | 'analyze' | 'report';
const ACTIONS: Record<ActionId, { label: string; risk: Risk }> = {
  run_batch: { label: '批量运行', risk: 'read' }, rerun_failed: { label: '只重跑失败的', risk: 'read' }, run_mobile: { label: '在 390 宽下再跑一遍', risk: 'read' },
  gen_cases: { label: '为 AC-3 补边界用例', risk: 'write' }, gen_api_cases: { label: '按契约生成接口用例', risk: 'write' },
  analyze: { label: '分析失败的共同原因', risk: 'read' }, report: { label: '生成测试报告', risk: 'read' },
};
type Tab = 'case' | 'replay' | 'api' | 'matrix';
const TABS: { id: Tab; label: string; en: string }[] = [{ id: 'case', label: '用例详情', en: 'CASE' }, { id: 'replay', label: '录制回放', en: 'REPLAY' }, { id: 'api', label: '接口', en: 'API' }, { id: 'matrix', label: '矩阵 · 报告', en: 'MATRIX' }];
const clock = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
let seq = 0; const uid = () => `t${++seq}`;
/** 运行后的结果（本地模拟）：未运行的长性能用例通过，新端点 404 失败，其余保持原样；不稳定的用例这次通过。 */
const outcome = (c: Case, env: Env): Status => c.id === 'CASE-121' ? 'pass' : c.id === 'CASE-203' ? 'fail' : c.draft ? (c.id === 'CASE-118c' && env === 'mobile' ? 'fail' : 'pass') : c.results[env] === 'flaky' ? 'pass' : c.results[env] === 'none' ? 'pass' : c.results[env];

export default function TestFace({ reduced, onGoDev }: { reduced: boolean; onGoDev: (issue: string) => void }) {
  const [cases, setCases] = useState<Case[]>(CASES);
  const [sel, setSel] = useState('CASE-118');
  const [tab, setTab] = useState<Tab>('case');
  const [xpOpen, setXpOpen] = useState(true);
  const [xpView, setXpView] = useState<ExplorerView>('files');
  const [batch, setBatch] = useState(7);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<ActionId | null>(null);
  const [showReport, setShowReport] = useState(false);
  const [apiCases, setApiCases] = useState<ApiCase[]>(API_CASES);
  const [events, setEvents] = useState<DockEvent[]>(() => [{ id: uid(), kind: 'agent', at: '10:13', text: <p>批次 <b>#07</b> 跑完了：<b>3 处失败</b>、<b>1 处不稳定</b>。失败集中在手机宽度和一个接口。可以说「分析失败的共同原因」，或者「只重跑失败的」。</p> }]);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = (ms: number, fn: () => void) => { timers.current.push(window.setTimeout(fn, reduced ? Math.min(ms, 60) : ms)); };

  const c = cases.find(x => x.id === sel) ?? cases[0];
  const cells = cases.flatMap(x => ENVS.map(e => x.results[e.id]));
  const count = (s: Status) => cells.filter(v => v === s).length;
  const push = (e: DockDraft) => { const id = e.id ?? uid(); setEvents(l => [...l, { ...e, id } as DockEvent]); return id; };
  const patch = (id: string, p: Partial<DockEvent>) => setEvents(l => l.map(e => e.id === id ? { ...e, ...p } as DockEvent : e));
  const say = (text: ReactNode) => push({ kind: 'agent', text, at: clock() });
  const pick = (id: string, t: Tab = 'case') => { setSel(id); setTab(t); setShowReport(false); };

  /** 运行一组「用例 × 环境」：逐格变成运行中，再落下结果。 */
  const runCells = (targets: [string, Env][], label: string, tool: string, t0: number) => {
    setRunning(new Set(targets.map(([id, e]) => `${id}:${e}`)));
    targets.forEach(([id, env], i) => later(260 + i * 90, () => {
      setCases(list => list.map(x => x.id === id ? { ...x, results: { ...x.results, [env]: outcome(x, env) }, lastRun: clock(), ms: x.ms || 520 } : x));
      setRunning(r => { const n = new Set(r); n.delete(`${id}:${env}`); return n; });
    }));
    later(260 + targets.length * 90 + 200, () => {
      setBusy(null); setBatch(b => b + 1);
      patch(tool, { state: 'done', ms: performance.now() - t0, detail: `${targets.length} 格 · ${label}` } as Partial<DockEvent>);
      setCases(list => { const fails = list.flatMap(x => ENVS.filter(e => x.results[e.id] === 'fail').map(e => `${x.id}·${e.label}`)); say(<p>批次跑完：{fails.length ? <>还有 <b>{fails.length}</b> 处失败（{fails.slice(0, 4).join('、')}{fails.length > 4 ? '…' : ''}）。</> : '全部通过。'}</p>); return list; });
    });
  };
  const run = (a: ActionId) => {
    const act = ACTIONS[a];
    const exec = () => {
      setBusy(a);
      const tool = push({ kind: 'tool', action: a, label: act.label, state: 'running' }); const t0 = performance.now();
      const done = (detail: string) => { patch(tool, { state: 'done', ms: performance.now() - t0, detail } as Partial<DockEvent>); setBusy(null); };
      if (a === 'run_batch') runCells(cases.flatMap(x => ENVS.map(e => [x.id, e.id] as [string, Env])), '全部', tool, t0);
      else if (a === 'rerun_failed') runCells(cases.flatMap(x => ENVS.filter(e => x.results[e.id] === 'fail' || x.results[e.id] === 'flaky').map(e => [x.id, e.id] as [string, Env])), '只重跑失败与不稳定', tool, t0);
      else if (a === 'run_mobile') runCells(cases.filter(x => x.kind === 'ui').map(x => [x.id, 'mobile'] as [string, Env]), '390 宽', tool, t0);
      else if (a === 'gen_cases') later(1100, () => { setCases(list => [...list.filter(x => !x.draft), ...DRAFTS]); done(`${DRAFTS.length} 条草稿`); pick(DRAFTS[0].id); say(<p>为 <b>REQ-012 AC-3</b> 补了 {DRAFTS.length} 条边界用例草稿（900px 临界、竖排后选中项可见），标着「草稿」，可以直接运行。</p>); });
      else if (a === 'gen_api_cases') later(900, () => { setApiCases(l => l.map(x => x.contract ? { ...x, caseId: x.caseId ?? 'CASE-204' } : x)); done('新增 1 · 更新 1'); say(<p>按 <code>openapi.yaml</code> 的契约变化更新了接口用例：<b>/neighbors</b> 新增用例，<b>/session/selection</b> 增加 <code>announced</code> 断言。</p>); });
      else if (a === 'analyze') later(1200, () => { done('2 个根因');
        say(<><p>失败有两个根因：</p>
          <p>① <b className="ad-ref" onClick={() => pick('CASE-118')}>CASE-118</b>、<b className="ad-ref" onClick={() => pick('CASE-119')}>CASE-119</b> 同源——<code>browser.css</code> 的容器查询没有生效（父级没有 <code>container-type</code>），只在手机宽度出现。对应 <b>ISS-33</b>。</p>
          <p>② <b className="ad-ref" onClick={() => pick('CASE-202')}>CASE-202</b> 是接口实现还没合入 develop，对应 <b>ISS-32</b>，不是用例的问题。</p>
          <p>CASE-110 的不稳定来自动画未结束就截图，建议在用例里等待 <code>transitionend</code>。</p></>); });
      else if (a === 'report') later(700, () => { done(`批次 #${String(batch).padStart(2, '0')}`); setTab('matrix'); setShowReport(true); say(<p>报告已生成，在「矩阵 · 报告」页签，可导出 md / PDF。</p>); });
    };
    if (act.risk === 'write') {
      const effects: Record<string, string[]> = { gen_cases: ['在 cases/REQ-012/AC-3/ 新增 2 条草稿用例', '草稿需要你确认后才进入正式批次'], gen_api_cases: ['按 openapi.yaml 的契约变化新增 / 更新接口用例'] };
      const card = push({ kind: 'approval', action: a, title: act.label, effects: effects[a] ?? [], risk: 'write', state: 'pending', onApprove: () => {}, onReject: () => {} });
      patch(card, { onApprove: () => { patch(card, { state: 'approved' } as Partial<DockEvent>); exec(); }, onReject: () => { patch(card, { state: 'rejected' } as Partial<DockEvent>); say(<p>好的，没有执行。</p>); } } as Partial<DockEvent>);
      return;
    }
    exec();
  };
  const onSend = (text: string) => {
    push({ kind: 'user', text, at: clock() });
    const a: ActionId | null = /重跑|失败的/.test(text) && !/原因/.test(text) ? 'rerun_failed' : /390|手机|窄屏/.test(text) && /跑/.test(text) ? 'run_mobile' : /原因|分析|为什么/.test(text) ? 'analyze' : /补|边界|生成用例/.test(text) ? 'gen_cases' : /接口|契约/.test(text) ? 'gen_api_cases' : /报告/.test(text) ? 'report' : /跑|运行|键盘/.test(text) ? 'run_batch' : null;
    if (a) run(a); else later(500, () => say(<p>我可以：批量运行、只重跑失败的、在 390 宽下再跑、为某条验收标准补边界用例、按接口契约生成用例、分析失败原因、生成报告。</p>));
  };

  const suggestions: Suggestion[] = [
    { id: 'k', label: '跑所有键盘相关的用例', onClick: () => onSend('跑所有键盘相关的用例') },
    { id: 'f', label: '只重跑失败的', onClick: () => run('rerun_failed') },
    { id: 'm', label: '在 390 宽下再跑一遍', onClick: () => run('run_mobile') },
    { id: 'g', label: '为 AC-3 补边界用例', onClick: () => run('gen_cases') },
    { id: 'a', label: '分析失败的共同原因', onClick: () => run('analyze') },
  ];
  const sections: ExplorerSection[] = xpView === 'files' ? [
    { id: 'queue', title: '测试队列', count: QUEUE.length, body: <div className="ts-queue">{QUEUE.map(q => <div key={q.id}><em>{q.id}</em><b>{q.title}</b><small>{q.from} · {q.cases} 个用例</small></div>)}</div> },
    { id: 'cases', title: '用例 · 需求 → 验收标准', count: cases.length, grow: true, actions: <button onClick={() => run('gen_cases')} title="补边界用例">＋</button>, body: <CaseTree cases={cases} sel={sel} running={running} onPick={id => pick(id)} /> },
  ] : xpView === 'search' ? [
    { id: 'search', title: '搜索用例', grow: true, body: <CaseSearch cases={cases} sel={sel} onPick={id => pick(id)} /> },
  ] : xpView === 'git' ? [
    { id: 'runs', title: '运行记录', grow: true, body: <div className="ts-runs">{Array.from({ length: batch - 4 }, (_, i) => batch - i).map(n => <div key={n} aria-current={n === batch || undefined}><em>#{String(n).padStart(2, '0')}</em><span>{n === batch ? `${count('pass')} 通过 · ${count('fail')} 失败` : n === LAST_BATCH.n ? `${LAST_BATCH.pass} 通过 · ${LAST_BATCH.fail} 失败` : '全部通过'}</span><small>{n === batch ? '刚才' : `${n === 6 ? '09:41' : '昨天'}`}</small></div>)}</div> },
  ] : [
    { id: 'trace', title: `追溯 · ${c.id}`, grow: true, body: <ol className="dv-trace">{([['需求', `${c.req} ${REQ_TITLE[c.req] ?? ''}`], ['验收标准', c.ac], ['用例', `${c.id} ${c.title}`], ['issue', c.failure?.issue ?? (c.req === 'REQ-012' ? 'ISS-32' : '—')], ['文件', c.failure?.stack.file ?? '—']] as [string, string][]).map(([k, v], i) => <li key={k}><em>{String(i + 1).padStart(2, '0')}</em><span><small>{k}</small>{v}</span></li>)}</ol> },
  ];

  return <div className="ts rh">
    <Explorer open={xpOpen} view={xpView} onView={setXpView} onToggle={() => setXpOpen(v => !v)} title={`批次 #${String(batch).padStart(2, '0')}`} sections={sections} badges={{ files: count('fail') || undefined }} />
    <section className="ts-center" data-wb-panel>
      <header className="dv-bar ts-bar" data-busy={busy || undefined}>
        <div className="dv-bar-id"><b>TEST</b><small>BATCH<br />测试</small></div>
        <div className="ts-batch"><em>#{String(batch).padStart(2, '0')}</em><span><strong>批次 · {cases.length} 个用例 × {ENVS.length} 个环境</strong><small>{ENVS.map(e => `${e.label} ${e.w}`).join(' · ')}</small></span></div>
        <div className="ts-counts">
          {(['pass', 'fail', 'flaky', 'none'] as Status[]).map(s => <span key={s} data-s={s}><b>{String(count(s)).padStart(2, '0')}</b><small>{STATUS_LABEL[s]}</small></span>)}
        </div>
        <button className="dv-run" onClick={() => run('run_batch')} disabled={!!busy}>{busy ? <Mobius stages={['排队', '运行', '比对', '归档']} current={1} running width={54} /> : <i />}<span><b>{busy ? 'RUNNING' : 'RUN BATCH'}</b><small>{busy ? ACTIONS[busy].label : '批量运行'}</small></span></button>
      </header>
      <nav className="dv-tabs" role="tablist">
        {TABS.map((t, i) => <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => { setTab(t.id); if (t.id === 'matrix') setShowReport(false); }}><b>{String(i + 1).padStart(2, '0')}</b>{t.label}<small>{t.en}</small>{t.id === 'api' && apiCases.some(x => x.contract) ? <i className="dv-dot" /> : null}</button>)}
      </nav>
      <div className="dv-work" key={`${tab}:${tab === 'case' ? sel : ''}:${showReport}`}>
        {tab === 'case' ? <CaseDetail c={c} running={running} onRun={env => { const t0 = performance.now(); setBusy('run_batch'); runCells(env ? [[c.id, env]] : ENVS.map(e => [c.id, e.id] as [string, Env]), `${c.id}`, push({ kind: 'tool', action: 'run_case', label: `运行 ${c.id}`, state: 'running' }), t0); }} onGoDev={onGoDev} onReplay={() => setTab('replay')} onAccept={() => setCases(l => l.map(x => x.id === c.id ? { ...x, draft: false } : x))} />
          : tab === 'replay' ? <Replay c={cases.find(x => x.id === 'CASE-118')!} />
          : tab === 'api' ? <ApiTests cases={apiCases} onPick={id => id && pick(id)} onContract={() => run('gen_api_cases')} />
          : showReport ? <Report cases={cases} batch={batch} onPick={id => pick(id)} />
          : <Matrix cases={cases} running={running} sel={sel} onPick={id => pick(id)} onReport={() => run('report')} />}
      </div>
    </section>
    <AgentDock name="测试助手" target={`批次 #${String(batch).padStart(2, '0')} · ${cases.length} 个用例 × ${ENVS.length} 个环境`} plan={{ stages: ['拉取待测 issue', '生成用例', '批量运行', '定位失败', '生成报告'], current: showReport ? 4 : count('fail') ? 3 : 2 }}
      suggestions={suggestions} events={events} busy={!!busy} loop={busy && busy.startsWith('r') && busy !== 'report' ? { stages: ['排队', '运行', '比对', '归档'], current: 1 } : null}
      onSend={onSend} placeholder="例如：只重跑失败的 · 在 390 宽下再跑一遍" />
  </div>;
}

/* ———— 用例树：需求 → 验收标准 → 用例，每个用例三格状态 ———— */
function Cells({ c, running }: { c: Case; running: Set<string> }) {
  return <span className="ts-cells">{ENVS.map(e => <i key={e.id} data-s={running.has(`${c.id}:${e.id}`) ? 'running' : c.results[e.id]} title={`${e.label} · ${STATUS_LABEL[running.has(`${c.id}:${e.id}`) ? 'running' : c.results[e.id]]}`} />)}</span>;
}
function CaseTree({ cases, sel, running, onPick }: { cases: Case[]; sel: string; running: Set<string>; onPick: (id: string) => void }) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const reqs = [...new Set(cases.map(c => c.req))];
  return <div className="ts-tree">{reqs.map(r => {
    const rc = cases.filter(c => c.req === r), acs = [...new Set(rc.map(c => c.ac))];
    return <div key={r}>
      <button className="ts-req" onClick={() => setClosed(s => { const n = new Set(s); if (n.has(r)) n.delete(r); else n.add(r); return n; })}><i>{closed.has(r) ? '▸' : '▾'}</i><em>{r}</em><span>{REQ_TITLE[r]}</span><small>{rc.filter(c => ENVS.every(e => c.results[e.id] === 'pass')).length}/{rc.length}</small></button>
      {!closed.has(r) && acs.map(ac => <div key={ac} className="ts-ac"><span className="ts-ac-head">{ac}</span>
        {rc.filter(c => c.ac === ac).map(c => <button key={c.id} className="ts-case" aria-current={c.id === sel || undefined} data-draft={c.draft || undefined} onClick={() => onPick(c.id)}>
          <em>{c.id.replace('CASE-', '')}</em><span>{c.title}</span><Cells c={c} running={running} />
        </button>)}
      </div>)}
    </div>;
  })}</div>;
}
function CaseSearch({ cases, sel, onPick }: { cases: Case[]; sel: string; onPick: (id: string) => void }) {
  const [q, setQ] = useState('');
  const hit = cases.filter(c => !q || `${c.id} ${c.title} ${c.tags.join(' ')} ${c.req} ${c.ac}`.includes(q));
  return <><div className="xp-search"><input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="用例号、标题、标签（如：键盘）…" /></div>
    <div className="ts-tree">{hit.map(c => <button key={c.id} className="ts-case" aria-current={c.id === sel || undefined} onClick={() => onPick(c.id)}><em>{c.id.replace('CASE-', '')}</em><span>{c.title}<small>{c.tags.join(' · ')}</small></span><Cells c={c} running={new Set()} /></button>)}</div></>;
}

/* ———— 01 用例详情：步骤表 + 失败定位 ———— */
function CaseDetail({ c, running, onRun, onGoDev, onReplay, onAccept }: { c: Case; running: Set<string>; onRun: (env?: Env) => void; onGoDev: (issue: string) => void; onReplay: () => void; onAccept: () => void }) {
  const failing = ENVS.filter(e => c.results[e.id] === 'fail');
  return <div className="ts-case-detail">
    <header className="ts-cd-head">
      <div><span className="rh-micro">{c.kind === 'api' ? 'API CASE' : 'UI CASE'} · {c.req} · {c.ac}{c.draft ? ' · 草稿' : ''}</span><h2><em>{c.id}</em>{c.title}</h2>
        <span className="ts-tags">{c.tags.map(t => <i key={t}>{t}</i>)}<small>上次运行 {c.lastRun} · {c.ms ? `${c.ms}ms` : '—'}</small></span></div>
      <div className="ts-cd-envs">{ENVS.map(e => { const s = running.has(`${c.id}:${e.id}`) ? 'running' : c.results[e.id]; return <button key={e.id} data-s={s} onClick={() => onRun(e.id)} title={`在${e.label}重跑`}><small>{e.label} · {e.w}</small><b>{STATUS_LABEL[s]}</b></button>; })}</div>
      <div className="ts-cd-act">{c.draft && <button className="rh-btn" onClick={onAccept}>确认草稿</button>}<button className="rh-btn is-solid" onClick={() => onRun()}>重跑这个用例</button></div>
    </header>
    <table className="ts-steps"><thead><tr><th>#</th><th>步骤</th><th>期望</th><th>实际</th></tr></thead>
      <tbody>{c.steps.map((s, i) => <tr key={i} data-ok={s.ok === undefined ? undefined : String(s.ok)}><td>{String(i + 1).padStart(2, '0')}</td><td>{s.action}</td><td>{s.expect}</td><td>{s.ok === undefined ? '—' : s.actual ?? (s.ok ? '符合' : '不符')}</td></tr>)}</tbody></table>
    {c.failure && failing.length > 0 ? <section className="ts-fail">
      <header><i />失败定位<small>{failing.map(e => e.label).join(' · ')}</small></header>
      <p className="ts-fail-sum">{c.failure.summary}</p>
      {c.failure.kind === 'visual' ? <div className="ts-shots">
        <figure><figcaption>期望 · 390</figcaption><MockShot layout="stacked" /></figure>
        <figure><figcaption>实际 · 390</figcaption><MockShot layout="overflow" diff /></figure>
        <figure className="ts-dom"><figcaption>DOM</figcaption><pre>{c.failure.dom}</pre></figure>
      </div> : <div className="ts-jsondiff">
        <figure><figcaption>期望响应</figcaption><pre>{JSON.stringify(c.failure.expected, null, 2)}</pre></figure>
        <figure><figcaption>实际响应</figcaption><pre>{JSON.stringify(c.failure.actual, null, 2).replace('\n}', '\n  ' + '<缺少 announced>' + '\n}')}</pre></figure>
      </div>}
      <div className="ts-stack"><code>{c.failure.stack.file}:{c.failure.stack.line}</code><span>{c.failure.stack.text}</span>
        <div>{c.failure.kind === 'visual' && <button className="rh-btn" onClick={onReplay}>▶ 看录制</button>}<button className="rh-btn is-solid" onClick={() => onGoDev(c.failure!.issue)}>带到开发面 · {c.failure.issue} →</button></div></div>
    </section> : <section className="ts-ok"><b>{ENVS.every(e => c.results[e.id] === 'pass') ? '三个环境全部通过' : ENVS.some(e => c.results[e.id] === 'none') ? '还没有运行' : '没有失败'}</b><small>{c.results.mobile === 'flaky' ? '手机宽度下不稳定：动画未结束就截图，建议等待 transitionend。' : ''}</small></section>}
  </div>;
}
/** 截图的示意：期望（竖排）与实际（列表在左、说明溢出），差异处橙色框。 */
function MockShot({ layout, diff }: { layout: 'stacked' | 'overflow' | 'side' | 'loading'; diff?: boolean }) {
  return <div className="ts-shot" data-layout={layout}>
    {layout === 'loading' ? <span className="ts-shot-loading">加载中…</span> : <>
      <div className="ts-shot-callout"><small>FILE</small><b>X—013</b><i /></div>
      <ol className="ts-shot-list">{['X—013', 'X—014', 'X—015', 'X—016'].map((n, i) => <li key={n} data-on={i === 0 || undefined}>{n}</li>)}</ol>
      {diff && <><span className="ts-shot-diff" style={{ left: '58%', top: '8%', width: '58%', height: '70%' }} /><span className="ts-shot-tag">溢出 112px</span></>}
    </>}
  </div>;
}

/* ———— 02 录制回放（暗室）———— */
function Replay({ c }: { c: Case }) {
  const total = 3;
  const [t, setT] = useState(0);
  const [play, setPlay] = useState(false);
  useEffect(() => {
    if (!play) return;
    let raf = 0, last = performance.now();
    const tick = (now: number) => { setT(v => { const n = Math.min(total, v + (now - last) / 1000); if (n >= total) setPlay(false); return n; }); last = now; raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf);
  }, [play]);
  const frame = [...RECORDING].reverse().find(f => f.at <= t) ?? RECORDING[0];
  return <div className="ts-replay" data-surface="darkroom">
    <header><span className="rh-micro">REPLAY · {c.id} · 手机 390 × 844 · {total.toFixed(1)}s</span><b>{c.title}</b></header>
    <div className="ts-player"><div className="ts-device"><MockShot layout={frame.layout} diff={frame.fail} /></div>
      <p className="ts-caption" data-fail={frame.fail || undefined}>{frame.fail ? '■ ' : ''}{frame.step}</p></div>
    <div className="ts-timeline">
      <button onClick={() => { if (t >= total) setT(0); setPlay(v => !v); }} aria-label={play ? '暂停' : '播放'}>{play ? '❚❚' : '▶'}</button>
      <div className="ts-track" onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setT(((e.clientX - r.left) / r.width) * total); setPlay(false); }}>
        <span className="ts-progress" style={{ transform: `scaleX(${t / total})` }} />
        {RECORDING.map(f => <i key={f.at} style={{ left: `${(f.at / total) * 100}%` }} data-fail={f.fail || undefined} title={f.step} />)}
        <b style={{ left: `${(t / total) * 100}%` }} />
      </div>
      <small>{t.toFixed(1)}s / {total.toFixed(1)}s</small>
    </div>
    <ol className="ts-steplist">{RECORDING.map((f, i) => <li key={i} data-on={f === frame || undefined} data-fail={f.fail || undefined}><button onClick={() => { setT(f.at); setPlay(false); }}><em>{f.at.toFixed(1)}s</em>{f.step}</button></li>)}</ol>
  </div>;
}

/* ———— 03 接口：端点 · 请求 · 响应 · 断言 · 契约 ———— */
function ApiTests({ cases, onPick, onContract }: { cases: ApiCase[]; onPick: (caseId?: string) => void; onContract: () => void }) {
  const [sel, setSel] = useState(3);
  const [res, setRes] = useState<boolean>(false);
  const [sending, setSending] = useState(false);
  const [history, setHistory] = useState<{ m: string; p: string; ms: number; at: string; ok: boolean }[]>([]);
  const ep = cases[sel];
  const send = () => { setSending(true); setRes(false); window.setTimeout(() => { setSending(false); setRes(true); setHistory(h => [{ m: ep.method, p: ep.path, ms: ep.ms, at: clock(), ok: ep.assertions.every(a => a.ok) }, ...h].slice(0, 6)); }, 420); };
  return <div className="dv-api ts-api">
    <nav className="dv-api-list">
      <div className="ts-contract"><span className="rh-micro">CONTRACT · openapi.yaml vs develop</span><b>新增 {cases.filter(x => x.contract === 'new').length} · 变更 {cases.filter(x => x.contract === 'changed').length}</b><button className="rh-btn" onClick={onContract}>按契约生成用例</button></div>
      <span className="rh-micro">ENDPOINTS</span>
      {cases.map((e, i) => <button key={e.method + e.path} aria-current={i === sel || undefined} onClick={() => { setSel(i); setRes(false); }}><em data-m={e.method}>{e.method}</em><span><b>{e.path}</b><small>{e.title}{e.caseId ? ` · ${e.caseId}` : ''}</small></span><i className="ts-api-mark" data-ok={String(e.assertions.every(a => a.ok))} title={e.assertions.every(a => a.ok) ? '断言全部通过' : '有断言失败'} />{e.contract && <i className="dv-dot" title={e.contract === 'new' ? '新增' : '变更'} />}</button>)}
      {history.length > 0 && <><span className="rh-micro">HISTORY</span>{history.map((h, i) => <div key={i} className="dv-api-hist"><em data-m={h.m}>{h.m}</em><span>{h.p}</span><small>{h.ms}ms · {h.at} · {h.ok ? '通过' : '失败'}</small></div>)}</>}
    </nav>
    <div className="dv-api-main" key={sel}>
      <div className="dv-api-req"><em data-m={ep.method}>{ep.method}</em><code>{ep.path}</code><button className="rh-btn is-solid" onClick={send} disabled={sending}>{sending ? '发送中…' : '发送 ▸'}</button></div>
      {ep.contract && <p className="dv-api-fresh">■ {ep.contract === 'new' ? '契约里新增的端点，还没有实现' : '契约在 feat/ISS-32 上变更了这个端点'}</p>}
      {ep.body !== undefined && <label className="dv-api-body"><span className="rh-micro">REQUEST BODY</span><textarea defaultValue={ep.body} rows={4} /></label>}
      <div className="ts-asserts"><span className="rh-micro">ASSERTIONS · {ep.caseId ? <button className="ts-link" onClick={() => onPick(ep.caseId)}>{ep.caseId}</button> : '未关联用例'}</span>
        {ep.assertions.map(a => <div key={a.text} data-ok={res ? String(a.ok) : undefined}><i />{a.text}<small>{res ? (a.ok ? '通过' : '失败') : '—'}</small></div>)}</div>
      <div className="dv-api-res"><span className="rh-micro">RESPONSE {res && <>· <b>{ep.status}</b> · {ep.ms}ms</>}</span><pre>{res ? JSON.stringify(ep.response, null, 2) : '点「发送」运行这一组断言'}</pre></div>
    </div>
  </div>;
}

/* ———— 04 运行矩阵 · 报告 ———— */
function Matrix({ cases, running, sel, onPick, onReport }: { cases: Case[]; running: Set<string>; sel: string; onPick: (id: string) => void; onReport: () => void }) {
  const reqs = [...new Set(cases.map(c => c.req))];
  return <div className="ts-matrix">
    <div className="ts-mx-head"><span className="rh-micro">MATRIX · 用例 × 环境</span><span className="ts-legend">{(['pass', 'fail', 'flaky', 'none'] as Status[]).map(s => <span key={s}><i data-s={s} />{STATUS_LABEL[s]}</span>)}</span><button className="rh-btn is-solid" onClick={onReport}>生成报告</button></div>
    <div className="ts-cov">{reqs.map(r => { const rc = cases.filter(c => c.req === r), ok = rc.filter(c => ENVS.every(e => c.results[e.id] === 'pass')).length; return <div key={r}><em>{r}</em><span>{REQ_TITLE[r]}</span><i className="rq-ticks">{rc.map(c => <i key={c.id} data-done={ENVS.every(e => c.results[e.id] === 'pass') || undefined} data-note={ENVS.some(e => c.results[e.id] === 'fail') || undefined} />)}</i><b>{Math.round((ok / rc.length) * 100)}%</b></div>; })}</div>
    <table className="ts-grid"><thead><tr><th>用例</th>{ENVS.map(e => <th key={e.id}>{e.label}<small>{e.w}</small></th>)}</tr></thead>
      <tbody>{reqs.map(r => [<tr key={r} className="ts-grid-req"><td colSpan={4}>{r} · {REQ_TITLE[r]}</td></tr>, ...cases.filter(c => c.req === r).map(c => <tr key={c.id} aria-current={c.id === sel || undefined} onClick={() => onPick(c.id)}>
        <td><em>{c.id}</em>{c.title}{c.draft && <small>草稿</small>}</td>
        {ENVS.map(e => { const s = running.has(`${c.id}:${e.id}`) ? 'running' : c.results[e.id]; return <td key={e.id}><span className="ts-cell" data-s={s}>{STATUS_LABEL[s]}</span></td>; })}
      </tr>)])}</tbody></table>
  </div>;
}
function Report({ cases, batch, onPick }: { cases: Case[]; batch: number; onPick: (id: string) => void }) {
  const cells = cases.flatMap(c => ENVS.map(e => ({ c, e, s: c.results[e.id] })));
  const n = (s: Status) => cells.filter(x => x.s === s).length;
  const fails = cells.filter(x => x.s === 'fail');
  const diff = (now: number, was: number) => now === was ? '持平' : now > was ? `+${now - was}` : `${now - was}`;
  return <div className="en-report ts-report">
    <nav className="en-report-index"><span className="rh-micro">INDEX · 失败</span>{fails.map(f => <button key={f.c.id + f.e.id} data-kind="conflict" onClick={() => onPick(f.c.id)}><em>{f.c.id} · {f.e.label}</em>{f.c.title}</button>)}{!fails.length && <span className="en-report-none">没有失败</span>}</nav>
    <article className="rh-read en-report-body">
      <span className="rh-micro">TEST REPORT · 批次 #{String(batch).padStart(2, '0')} · {clock()} · {cases.length} 个用例 × {ENVS.length} 个环境</span>
      <h2>测试报告</h2>
      <div className="ts-report-nums">{(['pass', 'fail', 'flaky', 'none'] as Status[]).map(s => <span key={s} data-s={s}><b>{String(n(s)).padStart(2, '0')}</b><small>{STATUS_LABEL[s]} · 较 #{String(LAST_BATCH.n).padStart(2, '0')} {diff(n(s), LAST_BATCH[s as 'pass'])}</small></span>)}</div>
      <h3>按需求的覆盖率</h3>
      <ul>{[...new Set(cases.map(c => c.req))].map(r => { const rc = cases.filter(c => c.req === r); return <li key={r}>{r} {REQ_TITLE[r]}：{rc.filter(c => ENVS.every(e => c.results[e.id] === 'pass')).length} / {rc.length} 个用例三环境全部通过，覆盖验收标准 {[...new Set(rc.map(c => c.ac))].join('、')}。</li>; })}</ul>
      <h3>失败</h3>
      {fails.length ? fails.map(f => <section key={f.c.id + f.e.id}><p><b>{f.c.id} {f.c.title}</b> · {f.e.label} {f.e.w}<br />{f.c.failure?.summary ?? '见用例详情。'}{f.c.failure && <> 定位：<code>{f.c.failure.stack.file}:{f.c.failure.stack.line}</code>，对应 {f.c.failure.issue}。</>}</p><button className="rh-btn" onClick={() => onPick(f.c.id)}>打开用例</button></section>) : <p>没有失败。</p>}
      <h3>环境</h3>
      <p>Chromium 无头 · {ENVS.map(e => `${e.label} ${e.w}`).join(' / ')} · 分支 develop @ a1f3c9 + 待测 issue（ISS-31、ISS-32）。示例数据 · 不连接真实运行器。</p>
      <div className="ts-report-act"><button className="rh-btn is-solid">导出 md</button><button className="rh-btn">导出 PDF</button></div>
    </article>
  </div>;
}
