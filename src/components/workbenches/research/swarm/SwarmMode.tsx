import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import BenchFrame from '../../BenchFrame';
import AgentDock, { type DockEvent, type Suggestion } from '../../AgentDock';
import Explorer, { type ExplorerSection, type ExplorerView } from '../../engineering/Explorer';
import type { BenchChrome } from '../../WorkbenchStudio';
import { mockSwarmAdapter } from './mockSwarm';
import { emptyView } from './swarmStore';
import {
  LIVE_INTERVENTIONS, isTerminal,
  type BoardPost, type BusEntry, type BusType, type InterventionKind, type MemberLogItem, type MemberRole, type SwarmAdapter, type SwarmAsk,
  type SwarmMember, type SwarmPlan, type SwarmRoute, type SwarmRunState, type SwarmTask, type SwarmTaskState, type SwarmView,
} from './swarmTypes';
import '../../engineering/dev.css';
import './swarm.css';
// 研究台 · 群研模式：一个负责人带一队 agent 攻一个问题。四个面只读服务端投影（design/prd/13-swarm-contract.md）：
// 01 任务树 · 02 通信（星座 + 消息流）· 03 留言板 · 04 汇总。底部时间轴右端是「实时」，拖回去只读历史，不影响后台。

type Face = 'tree' | 'bus' | 'board' | 'synth';
const RUN_ZH: Record<SwarmRunState, string> = {
  clarifying: '澄清中', awaiting_confirm: '等你确认计划', running: '运行中', waiting_user: '等你回答', paused: '已暂停', near_limit: '快到额度',
  finishing: '收尾中', awaiting_review: '报告前有分歧', done: '已完成', partial: '部分完成', unresolved: '没有可靠答案', cancelled: '已取消', failed: '失败',
};
const TASK_ZH: Record<SwarmTaskState, string> = {
  open: '开放', doing: '进行中', delivered: '已交付', sync_pending: '交付已存 · 状态待同步', blocked: '被挡住', waiting_user: '等你',
  stopped: '已停止', failed: '失败', superseded: '计划已改掉',
};
const ROUTE_ZH: Record<SwarmRoute['state'], string> = { active: '进行中', blocked: '阻塞', stopped: '已停止', reopened: '重新开放', merged: '已合并' };
const MEMBER_ZH: Record<SwarmMember['state'], string> = { creating: '创建中', running: '运行中', idle: '空闲', interrupted: '被打断', failed: '失败' };
const ROLE: Record<MemberRole, { zh: string; en: string }> = {
  lead: { zh: '负责人', en: 'LEAD' }, researcher: { zh: '研究员', en: 'RESEARCHER' }, critic: { zh: '反驳', en: 'CRITIC' }, verifier: { zh: '核实', en: 'VERIFIER' },
};
const ORDER: MemberRole[] = ['lead', 'researcher', 'critic', 'verifier'];
const MSG: Record<BusType, { zh: string; glyph: string; desc: string }> = {
  broadcast: { zh: '决定', glyph: '◎', desc: '发到研究黑板的公共决定：成员按需读，不逐个发消息。' },
  claim: { zh: '领取', glyph: '✋', desc: '在任务板上认领一个任务（原子操作，依赖没完成不能领）。' },
  ask: { zh: '提问', glyph: '?', desc: '向某个队员要一条具体信息；回答和提问配对。' },
  deliver: { zh: '交付', glyph: '↳', desc: '交出具体产出（结论、数据、负结果）；交付后任务前进一格。' },
  help: { zh: '求助', glyph: '!', desc: '卡住了：发到留言板，谁能帮谁接。' },
  handoff: { zh: '转交', glyph: '⇢', desc: '任务依赖 + 一条消息，把半成品交给下一棒。' },
  refute: { zh: '反驳', glyph: '✕', desc: '质疑某条结论并附理由；要么补证据，要么降级。' },
  verify: { zh: '核实', glyph: '✓', desc: '独立核对原始来源，不看谁吵赢。' },
  message: { zh: '消息', glyph: '→', desc: '队员之间的点对点消息（进对方收件箱）。' },
  interrupt: { zh: '打断', glyph: '‖', desc: '负责人打断某个队员；任务归属保留。' },
  conflict: { zh: '版本冲突', glyph: '≠', desc: '两人同时改一个任务，后到的刷新重来，不覆盖别人。' },
  user: { zh: '用户', glyph: '●', desc: '发给负责人的用户指令或系统转达。' },
  system: { zh: '系统', glyph: '·', desc: '系统记录：暂停、恢复、到限等。' },
};
const DELIVERY_ZH = { sent: '已发出', received: '已收到', failed: '发送失败', unknown: '结果未知' } as const;
const IV_ZH = { received: '已接收', pending_approval: '等你批准', delivered: '已投递', applied: '已执行', replied: '已回复', rejected: '被拒绝', failed: '没有完成' } as const;
const IV_KIND: Record<InterventionKind, string> = { mention: '@队员', redirect: '改方向', add_member: '加人', stop_route: '停止路线', pause: '暂停', resume: '继续', finish: '结束研究', extend: '追加额度' };

const hhmm = (iso: string | undefined) => { const d = new Date(iso ?? ''); if (Number.isNaN(d.getTime())) return ''; return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`; };
const dur = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
/** 根任务：明确标了 root，或是别的任务的上级而自己没有上级。没有上级也没有下级的就是普通任务。 */
const rootsOf = (tasks: SwarmTask[]) => new Set(tasks.filter(t => t.kind === 'root' || ((!t.parentId || t.parentId === 'none') && tasks.some(x => x.parentId === t.id))).map(t => t.id));
const errText = (e: unknown) => (e instanceof Error ? e.message : '请求没有完成，请稍后重试。');

function useSwarm(adapter: SwarmAdapter) {
  const [view, setView] = useState<SwarmView>(emptyView);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const off = adapter.subscribe(setView);
    setLoading(true); setLoadError(null);
    adapter.load().catch(e => setLoadError(errText(e))).finally(() => setLoading(false));
    return off;
  }, [adapter]);
  return { view, loading, loadError, retry: () => { setLoadError(null); adapter.load().catch(e => setLoadError(errText(e))); } };
}

export default function SwarmMode({ file, reduced, chrome, modeSwitch, question, swarmAdapter }: {
  file: number; reduced: boolean; chrome: BenchChrome; modeSwitch: ReactNode; question?: string | null; onDispatch?: (to: 'auto', text: string) => void; swarmAdapter?: SwarmAdapter;
}) {
  const adapter = useMemo(() => swarmAdapter ?? mockSwarmAdapter(), [swarmAdapter]);
  const { view, loading, loadError, retry } = useSwarm(adapter);
  const { snap, bus } = view;
  const run = snap?.run ?? null;
  const ended = isTerminal(run);
  const team = !!snap && snap.members.some(m => m.role !== 'lead');
  const [face, setFace] = useState<Face>('tree');
  const [selMember, setSelMember] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<string | null>(null);
  const [selMsg, setSelMsg] = useState<number | null>(null);
  const [viewAt, setViewAt] = useState<number | null>(null);   // 回放：只看这个时刻之前的通信
  const [busyAct, setBusyAct] = useState<string | null>(null);
  const [actError, setActError] = useState<string | null>(null);
  const [xpOpen, setXpOpen] = useState(true), [xpView, setXpView] = useState<ExplorerView>('files');
  // 精读派来的问题：没有运行时放成建议，点了填进输入框等你发（不替你发起）
  const draftQ = question ?? null;

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusyAct(label); setActError(null);
    try { await fn(); } catch (e) { setActError(errText(e)); } finally { setBusyAct(null); }
  };
  const intervene = (kind: InterventionKind, extra?: { text?: string; routeId?: string }) => act(IV_KIND[kind], () => adapter.intervene(kind, extra));

  const shown = viewAt === null ? bus : bus.filter(x => Date.parse(x.at) <= viewAt);
  const working = snap?.members.filter(m => m.state === 'running').length ?? 0;
  const roots = rootsOf(snap?.tasks ?? []);
  const tasks = snap?.tasks.filter(t => !roots.has(t.id)) ?? [];
  const delivered = tasks.filter(t => t.state === 'delivered').length;

  // —— 对话框：澄清对话 + 计划卡 + 提问卡 + 干预回执 ——
  const events: DockEvent[] = useMemo(() => {
    const out: DockEvent[] = view.dock.map(d => d.kind === 'user' ? { id: d.id, kind: 'user', text: d.text, at: hhmm(d.at) } : d.kind === 'note' ? { id: d.id, kind: 'note', text: d.text, at: hhmm(d.at) } : { id: d.id, kind: 'agent', text: <Md text={d.text} />, at: hhmm(d.at) });
    if (!snap && !view.dock.length) out.push({ id: 'hello', kind: 'agent', at: '', text: <p>我是群研的负责人。说出你要研究的问题，我先和你把边界、质量判据、路线和编制谈清楚，出一份计划给你确认；<b>确认之前不建队、不检索</b>。</p> });
    for (const a of view.asks) out.push({ id: 'ask:' + a.id, kind: 'card', body: <AskCard ask={a} onAnswer={b => act('回答', () => adapter.answer(a.id, b))} /> });
    if (snap?.plan && run && (run.state === 'awaiting_confirm' || run.state === 'clarifying')) out.push({ id: 'plan:' + snap.plan.version, kind: 'card', body: <PlanCard plan={snap.plan} canConfirm={run.state === 'awaiting_confirm'} busy={busyAct === '确认计划'} onConfirm={l => act('确认计划', () => adapter.confirmPlan(snap.plan!.version, l))} /> });
    for (const iv of snap?.interventions ?? []) out.push({ id: 'iv:' + iv.id + iv.state, kind: 'note', at: hhmm(iv.at), text: `${IV_KIND[iv.kind]}${iv.text ? `「${iv.text}」` : ''} · ${IV_ZH[iv.state]}${iv.result ? `：${iv.result}` : ''}` });
    if (actError) out.push({ id: 'err', kind: 'note', at: '', text: `没有完成：${actError}` });
    return out;
  }, [view.dock, view.asks, snap, run, busyAct, actError, adapter]);

  const suggestions: Suggestion[] = !run ? (draftQ ? [{ id: 'q', label: '用精读派来的问题', fill: draftQ }] : [{ id: 'q', label: '例：多 Agent 数量增加是否一定提高研究质量？', fill: '多 Agent 数量增加是否一定提高研究质量？' }])
    : ended ? [{ id: 'n', label: '开一次新的群研', fill: '' }]
    : run.state === 'paused' ? [{ id: 'r', label: '继续', onClick: () => intervene('resume') }, { id: 'f', label: '结束研究', onClick: () => intervene('finish') }]
    : team ? [{ id: 'p', label: '全队暂停', onClick: () => intervene('pause') }, { id: 'f', label: '结束研究', onClick: () => intervene('finish') }] : [];
  const stage = !run ? 0 : run.state === 'clarifying' ? 0 : run.state === 'awaiting_confirm' ? 1 : ended || run.state === 'finishing' ? 3 : 2;
  const dock = <AgentDock name="负责人" target={run ? `${RUN_ZH[run.state]} · ${snap!.members.length} 名成员` : '还没有群研'} plan={{ stages: ['澄清', '确认计划', '研究', '收尾'], current: stage }}
    suggestions={suggestions} events={events} busy={(view.thinking && (!run || run.state === 'clarifying' || run.state === 'awaiting_confirm')) || !!busyAct}
    onSend={t => act('发送', () => adapter.send(t))} placeholder={!run || ended ? '说出要研究的问题' : run.state === 'clarifying' || run.state === 'awaiting_confirm' ? '回答负责人，或补充要求' : '对负责人说（会记一条 @lead 留言）'}
    footnote={run ? `费用只记不拦：${run.used.cost.known ? `约 ¥${(run.used.cost.value ?? 0).toFixed(2)}` : '用量未知'}（按峰值费率估算）` : undefined} />;

  const named = (snap?.members ?? []).map(m => ({ ...m, label: !m.label || (snap?.members ?? []).filter(x => x.label === m.label).length > 1 ? m.id : m.label }));
  const roster = named.slice().sort((a, b) => ORDER.indexOf(a.role) - ORDER.indexOf(b.role) || a.id.localeCompare(b.id));
  const sections: ExplorerSection[] = [{ id: 'agents', title: `成员 · ${roster.length}`, count: working, grow: true, body: <div className="sw-roster">
    {roster.length ? ORDER.filter(r => roster.some(m => m.role === r)).map(r => <div key={r} className="sw-roster-group"><span className="rh-micro">{ROLE[r].en} · {ROLE[r].zh}</span>
      {roster.filter(m => m.role === r).map(m => <button key={m.id} aria-current={drawer === m.id || undefined} data-live={m.state === 'running' || undefined} data-state={m.state}
        onClick={() => { setDrawer(d => d === m.id ? null : m.id); setSelMember(m.id); }} title={`${m.label} · ${m.model} · ${m.context === 'fresh' ? '全新上下文' : '继承上下文'}`}>
        <em>{m.label || m.id}</em><span>{m.state === 'running' && m.doing?.summary ? m.doing.summary : MEMBER_ZH[m.state]}</span><i /></button>)}</div>)
      : <p className="sw-empty-note">确认计划后，负责人才会建队。</p>}
  </div> }];

  const bar = <header className="dv-bar sw-bar" data-busy={run?.state === 'running' || undefined}>
    <div className="dv-bar-id"><b>SWARM</b><small>群研<br />{run ? `${run.members.used}/${run.members.max} 队员` : '未开始'}</small></div>
    <div className="sw-q"><small>QUESTION · 研究问题{snap?.plan ? ` · 计划 v${snap.plan.version}` : ''}</small><strong title={snap?.plan?.question ?? run?.question}>{snap?.plan?.question ?? run?.question ?? '还没有问题：在右边对负责人说'}</strong></div>
    {run && <div className="sw-nums">
      <span><b>{String(working).padStart(2, '0')}</b><small>工作中</small></span>
      <span><b>{run.round}<em>/{run.limits.rounds}</em></b><small>轮 · {run.phase === 'independent' ? '独立' : '交叉'}</small></span>
      <span><b>{dur(run.used.activeMs)}</b><small>/ {run.limits.minutes} 分钟</small></span>
      <span><b>{String(delivered).padStart(2, '0')}</b><small>/ {tasks.length} 已交付</small></span>
    </div>}
    {run && !ended && team && <div className="sw-ctl" role="group" aria-label="干预">
      {run.state === 'paused' ? <button className="rh-btn is-solid" disabled={!!busyAct} onClick={() => intervene('resume')}>继续</button> : <button className="rh-btn" disabled={!!busyAct} onClick={() => intervene('pause')}>暂停</button>}
      <button className="rh-btn" disabled={!!busyAct} onClick={() => intervene('finish')}>结束</button>
      {(['add_member', 'redirect'] as InterventionKind[]).map(k => <button key={k} className="rh-btn" disabled={!LIVE_INTERVENTIONS.includes(k)} title="第三期接入">{IV_KIND[k]}</button>)}
    </div>}
  </header>;

  const timebar = <TimeBar bus={bus} start={run?.startedAt ?? bus[0]?.at ?? null} end={run?.endedAt ?? null} viewAt={viewAt} onSeek={setViewAt} />;
  const body = loading && !snap ? <div className="sw-empty"><p>正在读这份档案的群研……</p></div>
    : loadError ? <div className="sw-empty"><p>{loadError}</p><button className="rh-btn" onClick={retry}>重试</button></div>
    : face === 'tree' ? <TreeView snap={snap} bus={bus} busy={!!busyAct} onMember={id => { setDrawer(id); setSelMember(id); }} onStopRoute={r => intervene('stop_route', { routeId: r })} />
    : face === 'bus' ? <Bus members={roster} bus={shown} reduced={reduced} live={viewAt === null} selMember={selMember} selMsg={selMsg} onMember={setSelMember} onMsg={setSelMsg} />
    : face === 'board' ? <Board posts={snap?.posts ?? []} members={roster} disabled={!run} onPost={t => act('留言', () => adapter.post(t))} />
    : <Synth view={view} />;

  return <BenchFrame code="RSCH" section="002" file={file} reduced={reduced} chrome={chrome} face={face} onFace={id => setFace(id as Face)} tools={modeSwitch}
    faces={[{ id: 'tree', label: '任务树', en: 'TASKS', badge: delivered }, { id: 'bus', label: '通信', en: 'BUS', badge: bus.length }, { id: 'board', label: '留言板', en: 'BOARD', badge: snap?.posts.length ?? 0 }, { id: 'synth', label: '汇总', en: 'SYNTHESIS' }]}
    strip={<>SWARM <i>·</i> {run ? RUN_ZH[run.state] : 'IDLE'} <i>·</i> {viewAt === null ? 'LIVE' : `REPLAY ${hhmm(new Date(viewAt).toISOString())}`}</>}
    shutterLines={f => [`> face · ${f.en.toLowerCase()}`, `> bus · ${bus.length} entries`, '> ready']}
    status={<><span><i className="en-sq" />群研</span>{run ? <>
      <span data-alert={run.state === 'waiting_user' || run.state === 'awaiting_confirm' || run.state === 'awaiting_review' || undefined}>{RUN_ZH[run.state]}</span>
      <span>队员 {run.members.used}/{run.members.max}</span><span>轮 {run.round}/{run.limits.rounds}</span><span>时长 {dur(run.used.activeMs)} / {run.limits.minutes}:00</span>
      <span>{run.used.cost.known ? `费用约 ¥${(run.used.cost.value ?? 0).toFixed(2)}` : '费用未知'}</span>
      <span data-conn={view.conn}>{{ live: '实时', reconnecting: '重连中', offline: '已断开', idle: ended ? '已结束' : '未连接' }[view.conn]}</span></> : <span>还没有群研</span>}</>}>
    <div className="sw rh" data-face={face}>
      <Explorer code="RSCH" open={xpOpen} view={xpView} onView={setXpView} onToggle={() => setXpOpen(v => !v)} title={`${working} 个工作中`} sections={sections} />
      <section className="sw-center" data-wb-panel>
        {bar}
        <div className="sw-body">
          {run?.stateReason && run.stateReason !== RUN_ZH[run.state] && <div className="sw-reason" data-state={run.state}><b>{RUN_ZH[run.state]}</b>{run.stateReason}{view.missed > 0 && <em>断开期间新增 {view.missed} 条通信</em>}</div>}
          {body}
          {drawer && snap && named.some(m => m.id === drawer) && <MemberDrawer adapter={adapter} member={named.find(m => m.id === drawer)!} tick={view.logTick} onClose={() => setDrawer(null)} />}
        </div>
        {timebar}
      </section>
      {face === 'bus' ? <MsgLog bus={shown} total={bus.length} selMember={selMember} selMsg={selMsg} onMsg={setSelMsg} onMember={setSelMember} /> : dock}
    </div>
  </BenchFrame>;
}

/* ———— 负责人回话：只认粗体、列表、换行三样，别的原样 ———— */
function Md({ text }: { text: string }) {
  const inline = (line: string) => line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => part.startsWith('**') && part.endsWith('**') ? <b key={i}>{part.slice(2, -2)}</b> : part.startsWith('`') && part.endsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : part);
  const blocks: ReactNode[] = []; let list: string[] = [];
  const flush = () => { if (list.length) blocks.push(<ul key={'u' + blocks.length}>{list.map((l, i) => <li key={i}>{inline(l)}</li>)}</ul>); list = []; };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const item = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.*)$/);
    if (item) { list.push(item[1]); continue; }
    flush();
    if (line.trim()) blocks.push(<p key={'p' + blocks.length}>{inline(line.replace(/^#+\s*/, ''))}</p>);
  }
  flush();
  return <div className="sw-md">{blocks}</div>;
}

/* ———— 计划卡 ———— */
function PlanCard({ plan, canConfirm, busy, onConfirm }: { plan: SwarmPlan; canConfirm: boolean; busy: boolean; onConfirm: (limits: { rounds: number; minutes: number }) => void }) {
  const [rounds, setRounds] = useState(plan.limits.rounds), [minutes, setMinutes] = useState(plan.limits.minutes);
  useEffect(() => { setRounds(plan.limits.rounds); setMinutes(plan.limits.minutes); }, [plan.version, plan.limits.rounds, plan.limits.minutes]);
  const people = plan.roster.reduce((n, r) => n + r.count, 0);
  return <div className="sw-plan">
    <span className="rh-micro">PLAN v{plan.version} · {canConfirm ? '等你确认，确认后才建队' : '澄清中的草案'}</span>
    <b>{plan.question}</b>
    <p className="sw-plan-scope">{plan.scope}</p>
    <h4>怎么算答得好</h4><ul>{plan.qualityCriteria.map(c => <li key={c}>{c}</li>)}</ul>
    <h4>路线 · {plan.routes.length}</h4>
    <ol className="sw-plan-routes">{plan.routes.map(r => <li key={r.id}><em>{r.id}</em><span><b>{r.title}</b><small>{r.idea}</small><i>不同在：{r.differsBy}</i></span></li>)}</ol>
    <h4>编制 · {people} 人</h4>
    <div className="sw-plan-roster">{plan.roster.map(r => <span key={r.role}>{ROLE[r.role].zh} × {r.count}<small>{r.model}</small></span>)}</div>
    {plan.diffFrom && <><h4>和 v{plan.diffFrom.version} 相比</h4><ul>{plan.diffFrom.changes.map(c => <li key={c}>{c}</li>)}</ul></>}
    <h4>额度</h4>
    <div className="sw-plan-limits">
      <label>轮数<input type="number" min={4} value={rounds} disabled={!canConfirm} onChange={e => setRounds(Math.max(4, Number(e.target.value) || 4))} /></label>
      <label>分钟<input type="number" min={30} step={5} value={minutes} disabled={!canConfirm} onChange={e => setMinutes(Math.max(30, Number(e.target.value) || 30))} /></label>
      <small>最少 4 轮 / 30 分钟；费用只记不拦</small>
    </div>
    {canConfirm && <button className="rh-btn is-solid" disabled={busy} onClick={() => onConfirm({ rounds, minutes })}>{busy ? '正在建队……' : `确认开跑 · ${people} 人`}</button>}
  </div>;
}

/* ———— 提问卡（同收件箱同一张） ———— */
function AskCard({ ask, onAnswer }: { ask: SwarmAsk; onAnswer: (b: { candidateId?: string; candidateIds?: string[]; text?: string }) => void }) {
  const [pick, setPick] = useState<string[]>([]), [text, setText] = useState('');
  const toggle = (id: string) => setPick(p => ask.multi ? (p.includes(id) ? p.filter(x => x !== id) : [...p, id]) : [id]);
  const ok = pick.length > 0 || text.trim().length > 0;
  return <div className="sw-ask">
    <span className="rh-micro">QUESTION · 负责人在问你（收件箱里也有这张）</span>
    <p>{ask.title}</p>
    {ask.candidates.length > 0 && <div className="sw-ask-opts">{ask.candidates.map(c => <button key={c.id} aria-pressed={pick.includes(c.id)} onClick={() => toggle(c.id)}>{c.title}</button>)}</div>}
    <textarea rows={2} value={text} onChange={e => setText(e.target.value)} placeholder="直接写你的回答（选了也可以补一句）" />
    <button className="rh-btn is-solid" disabled={!ok} onClick={() => onAnswer({ ...(pick.length ? ask.multi ? { candidateIds: pick } : { candidateId: pick[0] } : {}), ...(text.trim() ? { text: text.trim() } : {}) })}>提交回答</button>
  </div>;
}

/* ———— 时间轴：右端是实时；拖回去只读历史 ———— */
function TimeBar({ bus, start, end, viewAt, onSeek }: { bus: BusEntry[]; start: string | null; end: string | null; viewAt: number | null; onSeek: (t: number | null) => void }) {
  const track = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (end) return; const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, [end]);
  const t0 = start ? Date.parse(start) : null, t1 = end ? Date.parse(end) : now;
  const span = t0 === null ? 1 : Math.max(1, t1 - t0);
  const pos = (t: number) => t0 === null ? 0 : Math.max(0, Math.min(1, (t - t0) / span));
  const seek = (x: number) => { if (t0 === null) return; const r = track.current!.getBoundingClientRect(); const p = (x - r.left) / r.width; onSeek(p >= .995 ? null : t0 + Math.max(0, p) * span); };
  const cur = viewAt === null ? 1 : pos(viewAt);
  return <footer className="sw-time" data-replay={viewAt !== null || undefined}>
    <button className="sw-live" disabled={viewAt === null} onClick={() => onSeek(null)}>{viewAt === null ? '● 实时' : '回到实时'}</button>
    <div className="sw-track" ref={track} onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); seek(e.clientX); }} onPointerMove={e => { if (e.buttons) seek(e.clientX); }}>
      {bus.map(x => <i key={x.seq} data-type={x.type} style={{ left: `${pos(Date.parse(x.at)) * 100}%` }} />)}
      <span className="sw-fill" style={{ transform: `scaleX(${cur})` }} />
      <b style={{ left: `${cur * 100}%` }} />
    </div>
    <small>{viewAt === null ? (t0 === null ? '--:--' : dur(t1 - t0)) : `回放 ${dur(viewAt - (t0 ?? viewAt))}`}</small>
    {viewAt !== null && <span className="sw-replay-note">回放中，后台照跑</span>}
  </footer>;
}

/* ———— 02 通信：星座 + 光点 ———— */
function layout(members: SwarmMember[]) {
  const out: Record<string, [number, number]> = { board: [50, 76] };
  const lead = members.find(m => m.role === 'lead');
  if (lead) out[lead.id] = [50, 44];
  const ring = members.filter(m => m.role !== 'lead');
  ring.forEach((m, i) => { const a = -Math.PI / 2 - .8 * Math.PI + ((i + .5) / Math.max(ring.length, 1)) * 1.6 * Math.PI; /* 下方留给黑板 */ out[m.id] = [50 + Math.cos(a) * 36, 46 + Math.sin(a) * 34]; });
  return out;
}
function Bus({ members, bus, reduced, live, selMember, selMsg, onMember, onMsg }: { members: SwarmMember[]; bus: BusEntry[]; reduced: boolean; live: boolean; selMember: string | null; selMsg: number | null; onMember: (id: string | null) => void; onMsg: (seq: number | null) => void }) {
  const [proto, setProto] = useState(false);
  const pos = useMemo(() => layout(members), [members]);
  const arrived = useRef(new Map<number, number>());
  const [, tick] = useState(0);
  const first = useRef(true);
  useEffect(() => {
    const now = Date.now();
    for (const x of bus) if (!arrived.current.has(x.seq)) arrived.current.set(x.seq, first.current ? 0 : now);
    first.current = false;
    if (reduced || !live) return;
    let raf = 0; const stopAt = now + 1500;
    const loop = () => { tick(v => v + 1); if (Date.now() < stopAt) raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop); return () => cancelAnimationFrame(raf);
  }, [bus, reduced, live]);
  const now = Date.now();
  const at = (id: string | null): [number, number] => (id ? pos[id] : undefined) ?? (id === 'board' || id === 'all' ? pos.board : pos.lead ?? [50, 44]);
  const recent = bus.slice(-14);
  const flying = live ? bus.filter(x => now - (arrived.current.get(x.seq) ?? 0) < 1100) : [];
  const sel = bus.find(x => x.seq === selMsg);
  const touched = (id: string) => selMember === id || (sel && (sel.from === id || sel.to === id));
  const types = [...new Set(bus.map(x => x.type))];
  const name = (id: string | null) => id === 'user' ? '你' : id === 'board' ? '黑板' : id === 'all' ? '全体' : id === 'system' ? '系统' : (members.find(m => m.id === id)?.label || id) ?? '—';
  if (!members.length) return <div className="sw-empty"><p>还没有成员。确认计划后，负责人建队，通信会出现在这里。</p></div>;
  return <div className="sw-bus">
    <svg className="sw-edges" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      {recent.filter(x => x.to && x.to !== 'all').map(x => { const [x1, y1] = at(x.from), [x2, y2] = at(x.to); return <line key={x.seq} x1={x1} y1={y1} x2={x2} y2={y2} data-type={x.type} data-sel={x.seq === selMsg || (selMember && (x.from === selMember || x.to === selMember)) || undefined} />; })}
    </svg>
    {flying.map(x => { const p = Math.min(1, (now - (arrived.current.get(x.seq) ?? now)) / 1100), e = 1 - Math.pow(1 - p, 3), [x1, y1] = at(x.from), [x2, y2] = at(x.to);
      return <span key={x.seq} className="sw-packet" data-type={x.type} style={{ left: `${x1 + (x2 - x1) * e}%`, top: `${y1 + (y2 - y1) * e}%` }}>{MSG[x.type].glyph}</span>; })}
    <button className="sw-node is-board" style={{ left: `${pos.board[0]}%`, top: `${pos.board[1]}%` }} data-hot={flying.some(x => x.to === 'board') || undefined}><b>BOARD</b><small>研究黑板</small></button>
    {members.map(m => { const [x, y] = at(m.id);
      return <button key={m.id} className="sw-node" data-role={m.role} data-live={m.state === 'running' || undefined} data-state={m.state} data-sel={touched(m.id) || undefined} style={{ left: `${x}%`, top: `${y}%` }} onClick={() => onMember(selMember === m.id ? null : m.id)} title={`${m.label} · ${MEMBER_ZH[m.state]} · ${m.model}`}>
        <b>{m.role === 'lead' ? 'LEAD' : m.label || m.id}</b><small>{m.role === 'lead' ? '负责人' : MEMBER_ZH[m.state]}</small></button>; })}
    {sel && <div className="sw-inspect"><span className="rh-micro">#{sel.seq} · {hhmm(sel.at)}</span><b><em data-type={sel.type}>{MSG[sel.type].glyph}</em>{MSG[sel.type].zh}{sel.delivery && <small className="sw-dl" data-d={sel.delivery}>{DELIVERY_ZH[sel.delivery]}</small>}</b>
      <span className="sw-route">{name(sel.from)} → {name(sel.to)}</span><p className="sw-inspect-text">{sel.text}</p>{sel.refs.taskId && <small>关联任务 · {sel.refs.taskId}</small>}<i>{MSG[sel.type].desc}</i>
      <button className="rh-btn" onClick={() => onMsg(null)}>关闭</button></div>}
    <button className={`sw-proto-btn${proto ? ' is-on' : ''}`} onClick={() => setProto(v => !v)}>{proto ? '收起说明' : `消息类型 · ${types.length} 种`}</button>
    {proto && <div className="sw-proto"><span className="rh-micro">每条 = 发件人 · 收件人 · 类型 · 关联任务 · 内容 · 发送结果</span>
      {(Object.keys(MSG) as BusType[]).map(k => <div key={k}><em data-type={k}>{MSG[k].glyph}</em><b>{MSG[k].zh}</b><span>{MSG[k].desc}</span><small>{bus.filter(x => x.type === k).length}</small></div>)}
      <p>「发送结果」只说明进没进对方收件箱；对方有没有处理，看后续真实事件。</p></div>}
  </div>;
}
function MsgLog({ bus, total, selMember, selMsg, onMsg, onMember }: { bus: BusEntry[]; total: number; selMember: string | null; selMsg: number | null; onMsg: (seq: number) => void; onMember: (id: string | null) => void }) {
  const [filter, setFilter] = useState<BusType | null>(null);
  const types = [...new Set(bus.map(x => x.type))];
  const list = bus.filter(x => (!filter || x.type === filter) && (!selMember || x.from === selMember || x.to === selMember)).slice().reverse();
  const who = (id: string | null) => id === 'user' ? '你' : id === 'board' ? '黑板' : id === 'all' ? '全体' : id ?? '—';
  return <aside className="sw-log" data-wb-panel>
    <header><span className="rh-ph-no">B</span><span><b>消息流</b><small>BUS · {bus.length} / {total}</small></span>{selMember && <button className="rh-btn" onClick={() => onMember(null)}>只看 {selMember} ×</button>}</header>
    <div className="sw-filters">{types.map(k => <button key={k} aria-pressed={filter === k} onClick={() => setFilter(f => f === k ? null : k)}><em data-type={k}>{MSG[k].glyph}</em>{MSG[k].zh}</button>)}</div>
    <ol>{list.length ? list.map(x => <li key={x.seq} data-type={x.type} aria-current={x.seq === selMsg || undefined}>
      <button onClick={() => onMsg(x.seq)}><time>{hhmm(x.at)}</time><em data-type={x.type}>{MSG[x.type].glyph}</em>
        <span><b>{who(x.from)} → {who(x.to)}</b><small>{MSG[x.type].zh}{x.refs.taskId ? ` · ${x.refs.taskId}` : ''}{x.delivery ? ` · ${DELIVERY_ZH[x.delivery]}` : ''}</small><p>{x.text}</p></span></button></li>)
      : <li className="sw-none">还没有消息。</li>}</ol>
  </aside>;
}

/* ———— 01 任务树 ———— */
function TreeView({ snap, bus, busy, onMember, onStopRoute }: { snap: SwarmView['snap']; bus: BusEntry[]; busy: boolean; onMember: (id: string) => void; onStopRoute: (routeId: string) => void }) {
  const [sel, setSel] = useState<string | null>(null);
  if (!snap) return <div className="sw-empty"><p>这份档案还没有群研。在右边对负责人说出你的问题，先澄清、出计划，你确认后才建队。</p></div>;
  const rootIds = rootsOf(snap.tasks), roots = snap.tasks.filter(t => rootIds.has(t.id));
  const isRoot = (t: SwarmTask) => rootIds.has(t.id);
  const routeIds = new Set(snap.routes.map(r => r.id));
  const routeTasks = (r: SwarmRoute) => snap.tasks.filter(t => !isRoot(t) && (t.routeId === r.id || r.taskIds.includes(t.id)));
  const cross = snap.tasks.filter(t => !isRoot(t) && !(t.routeId && routeIds.has(t.routeId)));
  const active = ['running', 'near_limit', 'waiting_user', 'paused'].includes(snap.run.state) && snap.members.some(m => m.role !== 'lead');
  const task = snap.tasks.find(t => t.id === sel) ?? null;
  const thread = sel ? bus.filter(x => x.refs.taskId === sel || x.taskUpdates?.some(u => u.id === sel)) : [];
  const Row = ({ t }: { t: SwarmTask }) => <span data-s={t.state} aria-current={sel === t.id || undefined} onClick={e => { e.stopPropagation(); setSel(t.id); }}>
    <i /><span className="sw-kid-t">{t.title}{t.blockedBy && <small className="sw-blocked">被 {t.blockedBy.taskIds.join('、') || '其他任务'} 挡住：{t.blockedBy.reason}</small>}</span>
    <small>{t.owner && <button onClick={e => { e.stopPropagation(); onMember(t.owner!); }}>{t.owner}</button>}<em className="sw-st" data-s={t.state}>{TASK_ZH[t.state]}</em></small></span>;
  return <div className="sw-tree">
    <div className="sw-tree-map">
      <div className="sw-root"><span className="rh-micro">ROOT · 根问题 · 轮 {snap.run.round}/{snap.run.limits.rounds} · {snap.run.phase === 'independent' ? '独立探索' : '交叉借鉴'}</span><b>{snap.plan?.question ?? snap.run.question}</b>
        {roots.map(t => <i key={t.id}>{t.title} · {TASK_ZH[t.state]}</i>)}</div>
      {!snap.routes.length && !snap.tasks.length && <p className="sw-empty-note">{snap.plan ? '计划已出，确认后负责人会按路线派任务。' : '负责人还在澄清。'}</p>}
      <div className="sw-subs">
        {snap.routes.map(r => <div key={r.id} className="sw-sub" data-route={r.state}>
          <header><em>{r.id}</em><b>{r.title}</b><i data-route={r.state}>{ROUTE_ZH[r.state]}</i></header>
          <p className="sw-sub-idea">{r.idea}</p>
          {(r.gap || r.blockedReason) && <p className="sw-sub-gap">{r.blockedReason ?? ''}{r.gap ? `　缺口：${r.gap}` : ''}</p>}
          <div className="sw-kids">{routeTasks(r).map(t => <Row key={t.id} t={t} />)}{!routeTasks(r).length && <span className="sw-none">还没有任务</span>}</div>
          {active && r.state === 'active' && <button className="sw-stop" disabled={busy} onClick={() => onStopRoute(r.id)}>停止这条路线</button>}
        </div>)}
        {cross.length > 0 && <div className="sw-sub" data-route="cross"><header><em>✕✓</em><b>审查与汇总</b><i>跨路线</i></header><div className="sw-kids">{cross.map(t => <Row key={t.id} t={t} />)}</div></div>}
      </div>
    </div>
    <aside className="sw-thread"><header><span className="rh-ph-no">T</span><b>{task ? `${task.id} · ${task.title}` : '点一个任务看详情'}</b></header>
      {task && <dl className="sw-task-meta">
        <dt>状态</dt><dd>{TASK_ZH[task.state]}（任务板：{task.board}）</dd>
        <dt>负责</dt><dd>{task.owner ?? '没人领'}</dd>
        <dt>轮次</dt><dd>第 {task.round} 轮 · 计划 v{task.planVersion} · 版本 {task.revision}</dd>
        {task.dependsOn.length > 0 && <><dt>依赖</dt><dd>{task.dependsOn.join('、')}</dd></>}
        {task.blockedBy && <><dt>挡住</dt><dd>{task.blockedBy.reason}</dd></>}
        <dt>交付</dt><dd>{task.submissions.length ? `${task.submissions.length} 份` : '还没有'}</dd>
      </dl>}
      <ol>{task ? thread.length ? thread.map(x => <li key={x.seq} data-type={x.type}><em data-type={x.type}>{MSG[x.type].glyph}</em><span><b>{x.from} → {x.to ?? '—'}</b><p>{x.text}</p></span><time>{hhmm(x.at)}</time></li>) : <li className="sw-none">还没有关于这个任务的消息。</li> : null}</ol></aside>
  </div>;
}

/* ———— 03 留言板 ———— */
const COLS: { id: BoardPost['col']; zh: string; en: string }[] = [{ id: 'question', zh: '问题', en: 'QUESTIONS' }, { id: 'finding', zh: '发现', en: 'FINDINGS' }, { id: 'help', zh: '求助', en: 'HELP' }, { id: 'decision', zh: '决定', en: 'DECISIONS' }];
function Board({ posts, members, disabled, onPost }: { posts: BoardPost[]; members: SwarmMember[]; disabled: boolean; onPost: (t: string) => void }) {
  const [draft, setDraft] = useState('');
  const label = (id: string) => id === 'user' ? '你' : members.find(m => m.id === id)?.label || id;
  const ids = members.map(m => '@' + m.id).slice(0, 4).join(' / ');
  return <div className="sw-board">
    <form className="sw-post" onSubmit={e => { e.preventDefault(); if (draft.trim()) { onPost(draft.trim()); setDraft(''); } }}>
      <span className="rh-micro">发帖 · {ids ? `用 ${ids} 这样的写法指定队员` : '确认计划建队后可以 @ 队员'}；不 @ 就是公开问题</span>
      <div><input value={draft} disabled={disabled} onChange={e => setDraft(e.target.value)} placeholder="例如：@lead 只看相同总 token 预算下的比较" /><button className="rh-btn is-solid" disabled={disabled || !draft.trim()}>贴到留言板</button></div>
    </form>
    <div className="sw-cols">{COLS.map(c => { const list = posts.filter(p => p.col === c.id).slice().sort((a, b) => b.seq - a.seq);
      return <section key={c.id}><header><b>{c.zh}</b><small>{c.en} · {list.length}</small></header>
        <ol>{list.map(p => <li key={p.id} data-you={p.by === 'user' || undefined}><span><b>{label(p.by)}{p.to ? ` → ${label(p.to)}` : ''}</b><time>{hhmm(p.at)}</time></span><p>{p.text}</p>
          {(p.col === 'question' && p.to) && <small className="sw-ans" data-a={p.answered || undefined}>{p.replyTo ? `回答 ${p.replyTo}` : p.answered ? '已回答' : '待回答'}</small>}</li>)}
          {!list.length && <li className="sw-none">空</li>}</ol></section>; })}</div>
  </div>;
}

/* ———— 04 汇总 ———— */
function Synth({ view }: { view: SwarmView }) {
  const snap = view.snap;
  if (!snap) return <div className="sw-empty"><p>还没有群研，所以也没有汇总。</p></div>;
  const r = snap.report, run = snap.run, rootIds = rootsOf(snap.tasks), isRoot = (t: SwarmTask) => rootIds.has(t.id);
  const done = snap.tasks.filter(t => !isRoot(t) && (t.state === 'delivered' || t.state === 'sync_pending'));
  const open = snap.tasks.filter(t => !isRoot(t) && !['delivered', 'sync_pending', 'superseded'].includes(t.state));
  return <div className="sw-synth en-report">
    <article className="rh-read en-report-body">
      <span className="rh-micro">SYNTHESIS · {r ? `报告 v${r.version}` : '阶段结果'} · {RUN_ZH[run.state]}</span>
      <h2>{snap.plan?.question ?? run.question}</h2>
      {!r && <p className="sw-candidate">核实还没接通：下面全部是<b>候选</b>，不是结论，也不出正式报告。</p>}
      {run.stateReason && <p>{run.stateReason}</p>}
      {r?.answer && <><h3>当前最强的已核实结论</h3><p>{r.answer}</p></>}
      <h3>已交付 · {done.length}</h3>
      {done.length ? <ul>{done.map(t => <li key={t.id}><b>{t.title}</b>（{t.owner ?? '—'}{t.state === 'sync_pending' ? '，状态待同步' : ''}）</li>)}</ul> : <p>还没有交付。</p>}
      <h3>还没完成 · {open.length}</h3>
      {open.length ? <ul>{open.map(t => <li key={t.id}>{t.title} · {TASK_ZH[t.state]}{t.blockedBy ? `：${t.blockedBy.reason}` : ''}</li>)}</ul> : <p>没有。</p>}
      {snap.routes.some(x => x.gap || x.blockedReason) && <><h3>路线缺口</h3><ul>{snap.routes.filter(x => x.gap || x.blockedReason).map(x => <li key={x.id}>{x.id} {x.title}：{x.blockedReason ?? ''}{x.gap ? ` 缺口：${x.gap}` : ''}</li>)}</ul></>}
      {snap.plan && <><h3>按计划，怎么算答得好</h3><ul>{snap.plan.qualityCriteria.map(c => <li key={c}>{c}</li>)}</ul></>}
      <p className="sw-cost">用量：{run.used.rounds} 轮 · 活动 {dur(run.used.activeMs)} · {run.used.tokens === null ? 'token 未知' : `${run.used.tokens.toLocaleString()} token`} · {run.used.cost.known ? `约 ¥${(run.used.cost.value ?? 0).toFixed(2)}（峰值费率估算）` : '费用未知'}</p>
    </article>
  </div>;
}

/* ———— 队员抽屉：实际可见的工作记录 ———— */
function MemberDrawer({ adapter, member, tick, onClose }: { adapter: SwarmAdapter; member: SwarmMember; tick: number; onClose: () => void }) {
  const [items, setItems] = useState<MemberLogItem[] | null>(null), [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => { let alive = true; adapter.memberLog(member.id, 0).then(r => { if (alive) { setItems(r.items); setErr(null); } }).catch(e => alive && setErr(errText(e))); return () => { alive = false; }; }, [adapter, member.id, tick]);
  if (!member) return null;
  return <div className="sw-member" role="dialog" aria-label={`${member.label} 的工作记录`}>
    <header><span className="rh-micro">{ROLE[member.role].en}</span><b>{member.label}</b><small>{member.model} · {member.context === 'fresh' ? '全新上下文' : '继承上下文'} · {MEMBER_ZH[member.state]}</small><button className="rh-btn" onClick={onClose}>关闭</button></header>
    {member.state === 'running' && member.doing && <p className="sw-member-doing">正在：{member.doing.summary}</p>}
    {member.failReason && <p className="sw-member-doing" data-bad>失败原因：{member.failReason}</p>}
    <ol>{err ? <li className="sw-none">{err}</li> : !items ? <li className="sw-none">读取中……</li> : !items.length ? <li className="sw-none">还没有记录。</li>
      : items.map(x => <li key={x.seq} data-kind={x.kind} data-failed={x.tool?.state === 'failed' || undefined}><button onClick={() => setOpen(o => o === x.seq ? null : x.seq)}>
        <time>{hhmm(x.at) || `#${x.seq}`}</time><span><b>{x.tool ? x.tool.name : { input: '输入', tool: '工具', source: '来源', output: '产出', message_in: '收到', message_out: '发出', summary: '摘要' }[x.kind]}</b><p>{x.tool?.args ? x.tool.args.slice(0, 160) : x.text}</p></span></button>
        {open === x.seq && x.tool && <div className="sw-member-io">{x.tool.args && <pre><small>参数</small>{x.tool.args}</pre>}{x.tool.result && <pre><small>结果</small>{x.tool.result}</pre>}</div>}</li>)}</ol>
  </div>;
}
