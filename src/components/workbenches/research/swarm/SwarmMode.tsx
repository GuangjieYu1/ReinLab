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
  type SwarmMember, type SwarmCardView, type Claim, type ClaimDetail, type EvidenceDetail, type Evidence, type SwarmPlan, type SwarmRoute, type SwarmRunState, type SwarmTask, type SwarmTaskState, type SwarmView,
} from './swarmTypes';
import { SWARM_CARD, SwarmCardBody, cardAnswers, type SwarmCardAnswers } from '../../../inbox/SwarmCard';
import { IdRef, RichBlocks, type IdLookup } from '../../richText';
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
const CLAIM_ZH: Record<Claim['status'], string> = { candidate: '候选', awaiting_refute: '待反驳', awaiting_verify: '待核实', verified: '已核实', disputed: '有争议', falsified: '已证伪', insufficient: '证据不足' };
const BASIS_ZH: Record<Claim['basis'], string> = { checked_fact: '核对过的事实', source_claim: '来源的说法', inference: '推断', observation: '实测' };
const REVIEW_KIND_ZH = { refute: '反驳', need_evidence: '要求补证据', verify: '独立核实', downgrade: '降级' } as const;
const VERDICT_ZH = { upheld: '反驳成立', rejected: '反驳不成立', verified: '核实通过', not_verifiable: '核不了', pending: '待定' } as const;
const ACCESS_ZH: Record<Evidence['access'], string> = { full_text: '读了全文', abstract_only: '只有摘要', unavailable: '打不开' };
const DISC_ZH: Record<NonNullable<Evidence['discovery']>, string> = { search: '搜出来的', citation: '顺着引用找到', 'known-url': '已知网址直接抓' };
const SOURCE_ZH: Record<Evidence['source']['kind'], string> = { paper: '论文', web: '网页', code: '代码', data: '数据', proof: '证明', other: '其他' };
/** 来源能直接打开的就给链接：arXiv 号、DOI、网址。 */
const sourceHref = (ref: string) => { const r = ref.trim(); const ax = r.match(/^arxiv:\s*(\S+)/i); if (ax) return `https://arxiv.org/abs/${ax[1]}`; if (/^10\.\d{4,}\//.test(r)) return `https://doi.org/${r}`; const doi = r.match(/^doi:\s*(\S+)/i); if (doi) return `https://doi.org/${doi[1]}`; return /^https?:\/\//.test(r) ? r : null; };
const IV_ZH = { received: '已接收', pending_approval: '等你批准', delivered: '已投递', applied: '已执行', replied: '已回复', rejected: '被拒绝', failed: '没有完成' } as const;
const IV_KIND: Record<InterventionKind, string> = { mention: '@队员', redirect: '改方向', add_member: '加人', stop_route: '停止路线', pause: '暂停', resume: '继续', finish: '结束研究', extend: '追加额度' };

const hhmm = (iso: string | undefined) => { const d = new Date(iso ?? ''); if (Number.isNaN(d.getTime())) return ''; return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`; };
const dur = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
/** 精读档案在研究台的精读模式打开。 */
const readHref = (dossierId: string) => `/?preview=workbench&studio=research&file=0&dossier=${encodeURIComponent(dossierId)}`;
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
  const [detail, setDetail] = useState<{ kind: 'claim' | 'evidence'; id: string }[]>([]);   // 结论 / 证据抽屉，可以一层层点进去再返回
  const openDetail = (kind: 'claim' | 'evidence', id: string) => { setDrawer(null); setDetail(d => [...d, { kind, id }]); };
  const [selMsg, setSelMsg] = useState<number | null>(null);
  const [viewAt, setViewAt] = useState<number | null>(null);   // 回放：只看这个时刻之前的通信
  const [busyAct, setBusyAct] = useState<string | null>(null);
  const [ctl, setCtl] = useState<'add_member' | 'redirect' | 'extend' | null>(null);   // 顶栏干预的小表单
  const [actError, setActError] = useState<string | null>(null);
  const [xpOpen, setXpOpen] = useState(true), [xpView, setXpView] = useState<ExplorerView>('files');
  // 精读派来的问题：没有运行时放成建议，点了填进输入框等你发（不替你发起）
  const draftQ = question ?? null;

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusyAct(label); setActError(null);
    try { await fn(); } catch (e) { setActError(errText(e)); } finally { setBusyAct(null); }
  };
  const intervene = (kind: InterventionKind, extra?: Parameters<SwarmAdapter['intervene']>[1]) => act(IV_KIND[kind], () => adapter.intervene(kind, extra));

  const shown = viewAt === null ? bus : bus.filter(x => Date.parse(x.at) <= viewAt);
  const working = snap?.members.filter(m => m.state === 'running').length ?? 0;
  const roots = rootsOf(snap?.tasks ?? []);
  const tasks = snap?.tasks.filter(t => !roots.has(t.id)) ?? [];
  const delivered = tasks.filter(t => t.state === 'delivered').length;

  // —— 对话框：澄清对话 + 计划卡 + 提问卡 + 干预回执 ——
  const events: DockEvent[] = useMemo(() => {
    // 开跑后负责人对你说的话：服务端记成 lead → user 的交付（开跑前的回话取自内核事件，见 swarm-live）
    const started = run?.startedAt;
    const leadSaid = started ? view.bus.filter(x => x.type === 'deliver' && x.from === 'lead' && x.to === 'user' && x.at >= started).map(x => ({ id: 'b' + x.seq, kind: 'agent' as const, text: x.text, at: x.at })) : [];
    const out: DockEvent[] = [...view.dock, ...leadSaid].sort((a, b) => a.at.localeCompare(b.at)).map(d => d.kind === 'user' ? { id: d.id, kind: 'user', text: d.text, at: hhmm(d.at) } : d.kind === 'note' ? { id: d.id, kind: 'note', text: d.text, at: hhmm(d.at) } : { id: d.id, kind: 'agent', text: <Md text={d.text} />, at: hhmm(d.at) });
    if (!snap && !view.dock.length) out.push({ id: 'hello', kind: 'agent', at: '', text: <p>我是群研的负责人。说出你要研究的问题，我先和你把边界、质量判据、路线和编制谈清楚，出一份计划给你确认；<b>确认之前不建队、不检索</b>。</p> });
    for (const c of view.cards) out.push({ id: 'card:' + c.id, kind: 'card', body: <DockSwarmCard card={c} busy={!!busyAct} onDecide={(d, ans) => act(SWARM_CARD[c.kind].tag, () => adapter.decideCard(c.id, d, ans))} /> });
    if (snap?.plan?.diffFrom && run && run.state !== 'awaiting_confirm' && run.state !== 'clarifying') out.push({ id: 'diff:' + snap.plan.version, kind: 'card', body: <div className="sw-plan sw-diff"><span className="rh-micro">PLAN v{snap.plan.version} · 改方向后的新计划（已自动继续）</span><h4>和 v{snap.plan.diffFrom.version} 相比</h4><ul>{snap.plan.diffFrom.changes.map(x => <li key={x}>{x}</li>)}</ul></div> });
    // 负责人一次问了几个问题：合成一张，逐题选，全部答完一起交（服务端也是答完最后一题才续接）
    if (view.asks.length) out.push({ id: 'asks:' + view.asks.map(a => a.id).join(','), kind: 'card', body: <AskCards asks={view.asks} onSubmit={all => act('回答', async () => { for (const [id, b] of all) await adapter.answer(id, b); })} /> });
    if (snap?.plan && run && (run.state === 'awaiting_confirm' || run.state === 'clarifying')) out.push({ id: 'plan:' + snap.plan.version, kind: 'card', body: <PlanCard plan={snap.plan} canConfirm={run.state === 'awaiting_confirm'} busy={busyAct === '确认计划' || busyAct === '改编制'} onConfirm={l => act('确认计划', () => adapter.confirmPlan(snap.plan!.version, l))}
      onReplan={text => act('改编制', () => adapter.send(text))} /> });
    for (const iv of snap?.interventions ?? []) out.push({ id: 'iv:' + iv.id + iv.state, kind: 'note', at: hhmm(iv.at), text: `${IV_KIND[iv.kind]}${iv.text ? `「${iv.text}」` : ''} · ${IV_ZH[iv.state]}${iv.result ? `：${iv.result}` : ''}` });
    if (actError) out.push({ id: 'err', kind: 'note', at: '', text: `没有完成：${actError}` });
    return out;
  }, [view.dock, view.bus, view.asks, view.cards, snap, run, busyAct, actError, adapter]);

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
      {(['add_member', 'redirect', 'extend'] as const).map(k => <button key={k} className="rh-btn" aria-pressed={ctl === k} disabled={!!busyAct || !LIVE_INTERVENTIONS.includes(k)} onClick={() => setCtl(c => c === k ? null : k)}>{IV_KIND[k]}</button>)}
    </div>}
  </header>;

  const timebar = <TimeBar bus={bus} start={run?.startedAt ?? bus[0]?.at ?? null} end={run?.endedAt ?? null} viewAt={viewAt} onSeek={setViewAt} />;
  const body = loading && !snap ? <div className="sw-empty"><p>正在读这份档案的群研……</p></div>
    : loadError ? <div className="sw-empty"><p>{loadError}</p><button className="rh-btn" onClick={retry}>重试</button></div>
    : face === 'tree' ? <TreeView snap={snap} bus={bus} busy={!!busyAct} onMember={id => { setDrawer(id); setSelMember(id); }} onStopRoute={r => intervene('stop_route', { routeId: r })} />
    : face === 'bus' ? <Bus members={roster} bus={shown} reduced={reduced} live={viewAt === null} selMember={selMember} selMsg={selMsg} onMember={setSelMember} onMsg={setSelMsg} />
    : face === 'board' ? <Board posts={snap?.posts ?? []} claims={snap?.claims ?? []} members={roster} disabled={!run} onClaim={id => openDetail('claim', id)} onPost={t => act('留言', () => adapter.post(t))} />
    : <Synth view={view} members={roster} onClaim={id => openDetail('claim', id)} onEvidence={id => openDetail('evidence', id)} />;

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
          {ctl && run && !ended && <CtlForm kind={ctl} routes={snap?.routes ?? []} run={run} busy={!!busyAct} onCancel={() => setCtl(null)}
            onSubmit={extra => { setCtl(null); void intervene(ctl, extra); }} />}
          {run?.stateReason && run.stateReason !== RUN_ZH[run.state] && <div className="sw-reason" data-state={run.state}><b>{RUN_ZH[run.state]}</b>{run.stateReason}{view.missed > 0 && <em>断开期间新增 {view.missed} 条通信</em>}</div>}
          {body}
          {detail.length > 0 && snap && <DetailDrawer key={detail.length + detail[detail.length - 1].id} adapter={adapter} item={detail[detail.length - 1]} depth={detail.length} members={roster}
            onBack={() => setDetail(d => d.slice(0, -1))} onClose={() => setDetail([])} onOpen={openDetail} onMember={id => { setDetail([]); setDrawer(id); setSelMember(id); }} />}
          {drawer && snap && named.some(m => m.id === drawer) && <MemberDrawer adapter={adapter} member={named.find(m => m.id === drawer)!} tick={view.logTick} onClose={() => setDrawer(null)}
            onMention={run && !ended && team ? text => intervene('mention', { memberId: drawer, text }) : undefined} />}
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

/* ———— 顶栏干预的小表单：加人 / 改方向 / 追加额度（后两者批准都走收件箱卡） ———— */
function CtlForm({ kind, routes, run, busy, onCancel, onSubmit }: {
  kind: 'add_member' | 'redirect' | 'extend'; routes: SwarmRoute[]; run: NonNullable<SwarmView['snap']>['run']; busy: boolean;
  onCancel: () => void; onSubmit: (extra: Parameters<SwarmAdapter['intervene']>[1]) => void;
}) {
  const [role, setRole] = useState<'researcher' | 'critic' | 'verifier'>('researcher'), [route, setRoute] = useState('');
  const [text, setText] = useState(''), [rounds, setRounds] = useState(2), [minutes, setMinutes] = useState(15);
  const left = run.members.max - run.members.used;
  return <form className="sw-ctl-form" onSubmit={e => { e.preventDefault();
    onSubmit(kind === 'add_member' ? { role, ...(route ? { routeId: route } : {}) } : kind === 'redirect' ? { text: text.trim() } : { limits: { rounds, minutes } }); }}>
    {kind === 'add_member' && <><b>加一个人</b>
      <label>角色<select value={role} onChange={e => setRole(e.target.value as typeof role)}><option value="researcher">研究员</option><option value="critic">反驳</option><option value="verifier">核实</option></select></label>
      <label>路线<select value={route} onChange={e => setRoute(e.target.value)}><option value="">由负责人安排</option>{routes.filter(r => r.state !== 'merged').map(r => <option key={r.id} value={r.id}>{r.id} {r.title}</option>)}</select></label>
      <small>还能加 {left} 人；要你在卡上批准后才建</small></>}
    {kind === 'redirect' && <><b>改方向</b>
      <input value={text} onChange={e => setText(e.target.value)} placeholder="例如：只看相同总 token 预算下的比较" autoFocus />
      <small>受影响的任务会停下、已有证据保留；负责人出新版本计划后自动继续，问题本身变了才要你再确认</small></>}
    {kind === 'extend' && <><b>追加额度</b>
      <label>轮数<input type="number" min={1} value={rounds} onChange={e => setRounds(Math.max(1, Number(e.target.value) || 1))} /></label>
      <label>分钟<input type="number" min={5} step={5} value={minutes} onChange={e => setMinutes(Math.max(5, Number(e.target.value) || 5))} /></label>
      <small>现在 {run.used.rounds}/{run.limits.rounds} 轮 · {dur(run.used.activeMs)}/{run.limits.minutes} 分钟；会出一张卡等你批准</small></>}
    <span className="sw-ctl-form-act"><button type="button" className="rh-btn" onClick={onCancel}>取消</button><button className="rh-btn is-solid" disabled={busy || (kind === 'redirect' && !text.trim())}>{kind === 'add_member' ? '提出加人' : kind === 'redirect' ? '改方向' : '提出追加'}</button></span>
  </form>;
}

/* ———— 群研卡（与收件箱同一张）———— */
function DockSwarmCard({ card, busy, onDecide }: { card: SwarmCardView; busy: boolean; onDecide: (d: 'approve' | 'reject', answers?: Record<string, unknown>) => void }) {
  const [ans, setAns] = useState<SwarmCardAnswers>({});
  const meta = SWARM_CARD[card.kind];
  return <div className="sw-ask sw-card">
    <span className="rh-micro">{meta.name} · 等你决定（收件箱里也有这张）</span>
    <b>{card.title}</b>
    <SwarmCardBody kind={card.kind} data={card.data} answers={ans} setAnswers={setAns} locked={busy} />
    <p className="sw-card-why">{meta.why}</p>
    <span className="sw-card-act"><button className="rh-btn" disabled={busy} onClick={() => onDecide('reject')}>{meta.reject}</button><button className="rh-btn is-solid" disabled={busy} onClick={() => onDecide('approve', cardAnswers(card.kind, card.data, ans))}>{meta.approve}</button></span>
  </div>;
}

/* ———— 计划卡 ———— */
function PlanCard({ plan, canConfirm, busy, onConfirm, onReplan }: { plan: SwarmPlan; canConfirm: boolean; busy: boolean; onConfirm: (limits: { rounds: number; minutes: number }) => void; onReplan: (text: string) => void }) {
  const [rounds, setRounds] = useState(plan.limits.rounds), [minutes, setMinutes] = useState(plan.limits.minutes);
  // 编制：负责人固定 1 人，其余角色可以加减；改了人数要让负责人按新编制重交计划（路线和分工跟着变）
  // 同一角色可能按路线分成多行（研究员 r1、r2…各 1 人），要加起来
  const sumRoles = (rs: typeof plan.roster) => rs.reduce<Partial<Record<MemberRole, number>>>((m, r) => ({ ...m, [r.role]: (m[r.role] ?? 0) + r.count }), {});
  const base = sumRoles(plan.roster);
  const [roster, setRoster] = useState<Partial<Record<MemberRole, number>>>(base);
  useEffect(() => { setRounds(plan.limits.rounds); setMinutes(plan.limits.minutes); setRoster(sumRoles(plan.roster)); }, [plan.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const roles: MemberRole[] = ['researcher', 'critic', 'verifier'];
  const people = 1 + roles.reduce((n, r) => n + (roster[r] ?? 0), 0);
  const changed = roles.some(r => (roster[r] ?? 0) !== (base[r] ?? 0));
  const bump = (r: MemberRole, d: number) => setRoster(m => { const next = Math.max(r === 'researcher' ? 1 : 0, (m[r] ?? 0) + d); return 1 + roles.reduce((n, x) => n + (x === r ? next : (m[x] ?? 0)), 0) > 16 ? m : { ...m, [r]: next }; });
  const replanText = () => `编制改成：负责人 1、${roles.map(r => `${ROLE[r].zh} ${roster[r] ?? 0}`).join('、')}（共 ${people} 人）；额度 ${rounds} 轮 / ${minutes} 分钟。路线和分工按这个编制调整，其余不变，重新交计划。`;
  return <div className="sw-plan">
    <span className="rh-micro">PLAN v{plan.version} · {canConfirm ? '等你确认，确认后才建队' : '澄清中的草案'}</span>
    <b>{plan.question}</b>
    <p className="sw-plan-scope">{plan.scope}</p>
    <h4>怎么算答得好</h4><ul>{plan.qualityCriteria.map(c => <li key={c}>{c}</li>)}</ul>
    <h4>路线 · {plan.routes.length}</h4>
    <ol className="sw-plan-routes">{plan.routes.map(r => <li key={r.id}><em>{r.id}</em><span><b>{r.title}</b><small>{r.idea}</small><i>不同在：{r.differsBy}</i></span></li>)}</ol>
    <h4>编制 · {people} 人{changed ? '（改过）' : ''}</h4>
    <div className="sw-plan-roster">
      <span>负责人 × 1<small>{plan.roster.find(r => r.role === 'lead')?.model ?? '默认'}</small></span>
      {roles.map(r => <span key={r} className="sw-plan-count" data-changed={(roster[r] ?? 0) !== (base[r] ?? 0) || undefined}>
        <em>{ROLE[r].zh}</em>
        <span className="sw-stepper"><button type="button" disabled={!canConfirm || (roster[r] ?? 0) <= (r === 'researcher' ? 1 : 0)} onClick={() => bump(r, -1)} aria-label={`少一名${ROLE[r].zh}`}>−</button><b>{roster[r] ?? 0}</b><button type="button" disabled={!canConfirm || people >= 16} onClick={() => bump(r, 1)} aria-label={`多一名${ROLE[r].zh}`}>＋</button></span>
        <small>{plan.roster.find(x => x.role === r)?.model ?? '默认'}</small></span>)}
    </div>
    {plan.diffFrom && <><h4>和 v{plan.diffFrom.version} 相比</h4><ul>{plan.diffFrom.changes.map(c => <li key={c}>{c}</li>)}</ul></>}
    <h4>额度</h4>
    <div className="sw-plan-limits">
      <label>轮数<input type="number" min={4} value={rounds} disabled={!canConfirm} onChange={e => setRounds(Math.max(4, Number(e.target.value) || 4))} /></label>
      <label>分钟<input type="number" min={30} step={5} value={minutes} disabled={!canConfirm} onChange={e => setMinutes(Math.max(30, Number(e.target.value) || 30))} /></label>
      <small>最少 4 轮 / 30 分钟。费用只记不拦，按峰值费率估算，跑的时候底部一直显示</small>
    </div>
    {canConfirm && (changed
      ? <><button className="rh-btn is-solid" disabled={busy} onClick={() => onReplan(replanText())}>{busy ? '已发给负责人……' : `按这个编制重交计划 · ${people} 人`}</button>
          <small className="sw-ask-hint">人数一变，路线和分工要跟着调，所以先让负责人重交一版，你再确认</small></>
      : <button className="rh-btn is-solid" disabled={busy} onClick={() => onConfirm({ rounds, minutes })}>{busy ? '正在建队……' : `确认开跑 · ${people} 人`}</button>)}
  </div>;
}

/* ———— 提问卡（同收件箱同一张） ———— */
type AskAnswer = { candidateId?: string; candidateIds?: string[]; text?: string };
function AskCards({ asks, onSubmit }: { asks: SwarmAsk[]; onSubmit: (all: [string, AskAnswer][]) => void }) {
  const [at, setAt] = useState(0);
  const [picks, setPicks] = useState<Record<string, string[]>>({}), [texts, setTexts] = useState<Record<string, string>>({});
  const ask = asks[Math.min(at, asks.length - 1)];
  const pick = picks[ask.id] ?? [], text = texts[ask.id] ?? '';
  const answered = (a: SwarmAsk) => (picks[a.id] ?? []).length > 0 || (texts[a.id] ?? '').trim().length > 0;
  const toggle = (id: string) => setPicks(m => ({ ...m, [ask.id]: ask.multi ? (pick.includes(id) ? pick.filter(x => x !== id) : [...pick, id]) : [id] }));
  const body = (a: SwarmAsk): AskAnswer => { const p = picks[a.id] ?? [], t = (texts[a.id] ?? '').trim();
    return { ...(p.length ? a.multi ? { candidateIds: p } : { candidateId: p[0] } : {}), ...(t ? { text: t } : {}) }; };
  const last = at >= asks.length - 1, all = asks.every(answered);
  return <div className="sw-ask">
    <span className="rh-micro">QUESTION · 负责人在问你{asks.length > 1 ? ` · 第 ${at + 1} / ${asks.length} 个，全部答完再一起交` : ''}（收件箱里也有）</span>
    {asks.length > 1 && <div className="sw-ask-steps">{asks.map((a, i) => <button key={a.id} aria-current={i === at || undefined} data-done={answered(a) || undefined} onClick={() => setAt(i)}>{i + 1}</button>)}</div>}
    <p>{ask.title}</p>
    {ask.candidates.length > 0 && <div className="sw-ask-opts">{ask.candidates.map(c => <button key={c.id} aria-pressed={pick.includes(c.id)} onClick={() => toggle(c.id)}>{c.title}</button>)}</div>}
    {ask.candidates.length > 0 && <small className="sw-ask-hint">{ask.multi ? '可多选' : '单选'}；也可以直接写</small>}
    <textarea rows={2} value={text} onChange={e => setTexts(m => ({ ...m, [ask.id]: e.target.value }))} placeholder="直接写你的回答（选了也可以补一句）" />
    <span className="sw-card-act">
      {at > 0 && <button className="rh-btn" onClick={() => setAt(at - 1)}>上一个</button>}
      {!last ? <button className="rh-btn is-solid" disabled={!answered(ask)} onClick={() => setAt(at + 1)}>下一个</button>
        : <button className="rh-btn is-solid" disabled={!all} onClick={() => onSubmit(asks.map(a => [a.id, body(a)]))}>{asks.length > 1 ? `提交全部 ${asks.length} 个回答` : '提交回答'}</button>}
    </span>
    {last && !all && asks.length > 1 && <small className="sw-ask-hint">还有没答的：第 {asks.map((a, i) => answered(a) ? null : i + 1).filter(Boolean).join('、')} 个</small>}
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
  const out: Record<string, [number, number]> = { board: [50, 78], user: [9, 86] };
  const lead = members.find(m => m.role === 'lead');
  if (lead) out[lead.id] = [50, 44];
  const ring = members.filter(m => m.role !== 'lead');
  ring.forEach((m, i) => { const a = -Math.PI / 2 - .8 * Math.PI + ((i + .5) / Math.max(ring.length, 1)) * 1.6 * Math.PI; /* 下方留给黑板 */ out[m.id] = [50 + Math.cos(a) * 36, 46 + Math.sin(a) * 34]; });
  return out;
}
function Bus({ members, bus, reduced, live, selMember, selMsg, onMember, onMsg }: { members: SwarmMember[]; bus: BusEntry[]; reduced: boolean; live: boolean; selMember: string | null; selMsg: number | null; onMember: (id: string | null) => void; onMsg: (seq: number | null) => void }) {
  const [proto, setProto] = useState(false);
  const pos = useMemo(() => layout(members), [members]);
  // 连线用像素画（百分比拉伸会把箭头压扁）：跟着容器尺寸走
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  useEffect(() => { const el = box.current; if (!el) return; const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height })); ro.observe(el); return () => ro.disconnect(); }, []);
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
  const px = (id: string | null): [number, number] => { const [x, y] = at(id); return [x * size.w / 100, y * size.h / 100]; };
  // 按「谁 → 谁」聚合：线越粗来回越多；最近 8 条在流动，方向朝收件人
  const recentSeqs = new Set(bus.slice(-8).map(x => x.seq));
  const edges = useMemo(() => {
    const m = new Map<string, { key: string; from: string; to: string; count: number; type: BusType; last: number; recent: boolean; sel: boolean }>();
    for (const x of bus) {
      if (!x.to || x.to === 'all' || x.from === 'system' || x.from === x.to) continue;
      const to = x.to === 'board' ? 'board' : x.to, key = `${x.from}>${to}`;
      const e = m.get(key) ?? { key, from: x.from, to, count: 0, type: x.type, last: 0, recent: false, sel: false };
      e.count++; e.type = x.type; e.last = x.seq; if (recentSeqs.has(x.seq)) e.recent = true; if (x.seq === selMsg) e.sel = true;
      if (selMember && (x.from === selMember || x.to === selMember)) e.sel = true;
      m.set(key, e);
    }
    return [...m.values()].sort((a, b) => a.last - b.last);
  }, [bus, selMsg, selMember]); // eslint-disable-line react-hooks/exhaustive-deps
  const flying = live ? bus.filter(x => now - (arrived.current.get(x.seq) ?? 0) < 1100) : [];
  const sel = bus.find(x => x.seq === selMsg);
  const touched = (id: string) => selMember === id || (sel && (sel.from === id || sel.to === id));
  const types = [...new Set(bus.map(x => x.type))];
  const name = (id: string | null) => id === 'user' ? '你' : id === 'board' ? '黑板' : id === 'all' ? '全体' : id === 'system' ? '系统' : (members.find(m => m.id === id)?.label || id) ?? '—';
  if (!members.length) return <div className="sw-empty"><p>还没有成员。确认计划后，负责人建队，通信会出现在这里。</p></div>;
  return <div className="sw-bus" ref={box}>
    <svg className="sw-edges" width={size.w} height={size.h} viewBox={`0 0 ${size.w} ${size.h}`} aria-hidden="true">
      <defs>{(['ink', 'refute', 'warm', 'sel'] as const).map(k => <marker key={k} id={`sw-arrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0,1 L10,5 L0,9 z" className={`sw-arrowhead is-${k}`} /></marker>)}</defs>
      {edges.map(e => { const [x1, y1] = px(e.from), [x2, y2] = px(e.to);
        const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
        // 起止各让开节点半个身位；向法线方向弯一点，A→B 与 B→A 分成两条弧
        const sx = x1 + ux * 30, sy = y1 + uy * 22, ex = x2 - ux * 34, ey = y2 - uy * 26;
        const bend = Math.min(46, len * .16), cx = (sx + ex) / 2 - uy * bend, cy = (sy + ey) / 2 + ux * bend;
        const mx = .25 * sx + .5 * cx + .25 * ex, my = .25 * sy + .5 * cy + .25 * ey;
        const tone = e.sel ? 'sel' : e.type === 'refute' ? 'refute' : e.type === 'help' || e.from === 'user' ? 'warm' : 'ink';
        return <g key={e.key} className="sw-edge" data-tone={tone} data-recent={e.recent || undefined} data-sel={e.sel || undefined}>
          <path d={`M${sx},${sy} Q${cx},${cy} ${ex},${ey}`} strokeWidth={Math.min(5, 1.2 + Math.log2(e.count + 1))} markerEnd={`url(#sw-arrow-${tone})`} />
          {e.count > 1 && <g className="sw-edge-n" transform={`translate(${mx},${my})`}><rect x={-11} y={-8} width={22} height={16} /><text y={4}>{e.count}</text></g>}
        </g>; })}
    </svg>
    {flying.map(x => { const p = Math.min(1, (now - (arrived.current.get(x.seq) ?? now)) / 1100), e = 1 - Math.pow(1 - p, 3), [x1, y1] = at(x.from), [x2, y2] = at(x.to);
      return <span key={x.seq} className="sw-packet" data-type={x.type} style={{ left: `${x1 + (x2 - x1) * e}%`, top: `${y1 + (y2 - y1) * e}%` }}>{MSG[x.type].glyph}</span>; })}
    {bus.some(x => x.from === 'user') && <span className="sw-node is-you" style={{ left: `${pos.user[0]}%`, top: `${pos.user[1]}%` }}><b>你</b></span>}
    <span className="sw-bus-legend">箭头指向收件人 · 线越粗来回越多 · 流动的是最近 8 条 · <i className="is-refute" />反驳 <i className="is-warm" />求助 / 你</span>
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
function Board({ posts, claims, members, disabled, onPost, onClaim }: { posts: BoardPost[]; claims: Claim[]; members: SwarmMember[]; disabled: boolean; onPost: (t: string) => void; onClaim: (id: string) => void }) {
  const [draft, setDraft] = useState('');
  const label = (id: string) => id === 'user' ? '你' : members.find(m => m.id === id)?.label || id;
  const ids = members.map(m => '@' + m.id).slice(0, 4).join(' / ');
  return <div className="sw-board">
    <form className="sw-post" onSubmit={e => { e.preventDefault(); if (draft.trim()) { onPost(draft.trim()); setDraft(''); } }}>
      <span className="rh-micro">发帖 · {ids ? `用 ${ids} 这样的写法指定队员` : '确认计划建队后可以 @ 队员'}；不 @ 就是公开问题</span>
      <div><input value={draft} disabled={disabled} onChange={e => setDraft(e.target.value)} placeholder="例如：@lead 只看相同总 token 预算下的比较" /><button className="rh-btn is-solid" disabled={disabled || !draft.trim()}>贴到留言板</button></div>
    </form>
    <div className="sw-cols">{COLS.map(c => { if (c.id === 'finding') return <section key={c.id}><header><b>{c.zh}</b><small>{c.en} · {claims.length}</small></header>
        <ol>{claims.slice().reverse().map(x => <li key={x.id} className="sw-claim" data-status={x.status}><button onClick={() => onClaim(x.id)}>
          <span><b>{label(x.author)}</b><small className="sw-cs" data-s={x.status}>{CLAIM_ZH[x.status]}</small></span>
          <p>{x.text}</p>
          <small className="sw-claim-meta">{x.negative ? '负结果 · ' : ''}{BASIS_ZH[x.basis]}{x.routeId ? ` · ${x.routeId}` : ''} · 第 {x.round} 轮 · 证据 {x.evidenceIds.length}{x.reviews.length ? ` · 审查 ${x.reviews.length}` : ''}</small></button></li>)}
          {!claims.length && <li className="sw-none">还没有结论。研究员交上来的候选结论会出现在这里。</li>}</ol></section>;
      const list = posts.filter(p => p.col === c.id).slice().sort((a, b) => b.seq - a.seq);
      return <section key={c.id}><header><b>{c.zh}</b><small>{c.en} · {list.length}</small></header>
        <ol>{list.map(p => <li key={p.id} data-you={p.by === 'user' || undefined}><span><b>{label(p.by)}{p.to ? ` → ${label(p.to)}` : ''}</b><time>{hhmm(p.at)}</time></span><p>{p.text}</p>
          {(p.col === 'question' && p.to) && <small className="sw-ans" data-a={p.answered || undefined}>{p.replyTo ? `回答 ${p.replyTo}` : p.answered ? '已回答' : '待回答'}</small>}</li>)}
          {!list.length && <li className="sw-none">空</li>}</ol></section>; })}</div>
  </div>;
}

/* ———— 04 汇总 ———— */
/** 一条结论的「标题」：取第一句（到第一个句号/冒号/分号，最多 60 字），全文折叠在下面。 */
function headline(text: string) {
  const t = text.replace(/\*\*/g, '').replace(/^【[^】]{1,12}】\s*/, '').replace(/\s+/g, ' ').trim();
  const cut = t.slice(0, 64).search(/[。；;：:？?！!]/);
  const head = cut >= 12 ? t.slice(0, cut) : t.length > 60 ? t.slice(0, 58) + '…' : t;
  return { head, more: t.length > head.length + 2 };
}

function Synth({ view, members, onClaim, onEvidence }: { view: SwarmView; members: SwarmMember[]; onClaim: (id: string) => void; onEvidence: (id: string) => void }) {
  const snap = view.snap;
  const scroller = useRef<HTMLDivElement>(null);
  if (!snap) return <div className="sw-empty"><p>还没有群研，所以也没有汇总。</p></div>;
  const r = snap.report, run = snap.run;
  const byId = new Map(snap.claims.map(c => [c.id, c])), ev = new Map(snap.evidence.map(e => [e.id, e]));
  const label = (id: string) => members.find(m => m.id === id)?.label || id;
  const routeTitle = (id: string | null) => (id && snap.routes.find(x => x.id === id)?.title) || (id ? `路线 ${id}` : '未归路线');
  // 负责人最后对你说的那段总结：往往最好读，但里面可能有没核实的内容，下面的分区以系统判定为准
  const started = run.startedAt;
  const leadNote = [...view.bus].reverse().find(x => x.type === 'deliver' && x.from === 'lead' && x.to === 'user' && (!started || x.at >= started))?.text ?? null;
  const verified = (r?.verified ?? snap.claims.filter(c => c.status === 'verified').map(c => c.id)).map(id => byId.get(id)).filter(Boolean) as Claim[];
  const disputed = (r?.disputed ?? []).map(id => byId.get(id)).filter(Boolean) as Claim[];
  const candidates = (r?.unverified ?? snap.claims.filter(c => !['verified', 'disputed', 'falsified'].includes(c.status)).map(c => c.id)).map(id => byId.get(id)).filter(Boolean) as Claim[];
  const negative = (r?.negative ?? []).map(id => byId.get(id)).filter(Boolean) as Claim[];
  const gaps = r?.gaps ?? [], limits = r?.limits ?? [], sources = (r?.sources ?? []).map(id => ev.get(id)).filter(Boolean) as Evidence[];
  const groups = [...new Set(candidates.map(c => c.routeId))];
  const STATE = { stage: '阶段结果', awaiting_review: '报告前有分歧，等你看', final: '正式报告', partial: '正式报告（部分完成）', unresolved: '没有可靠答案' } as const;
  const narrative = r?.narrative?.trim() || null;
  const dc = r?.discoveryCounts ?? null, dcTotal = dc ? dc.search + dc.knownUrl + dc.citation + dc.unknown : 0;
  // 成稿里引用的 id → 可点的小标签：结论标序号和状态，证据标来源，点开走同一个抽屉
  const claimNo = new Map(snap.claims.map((c, i) => [c.id, i + 1]));
  const full = (id: string) => byId.has(id) || ev.has(id) ? id
    : (snap.claims.find(c => c.id.startsWith(id))?.id ?? snap.evidence.find(e => e.id.startsWith(id))?.id ?? id);
  const idRef: IdLookup = raw => {
    const id = full(raw);
    const c = byId.get(id); if (c) return { label: `结论 ${claimNo.get(id)} · ${CLAIM_ZH[c.status]}`, title: c.text.slice(0, 160), open: () => onClaim(id) };
    const e = ev.get(id); if (e) return { label: `证据 · ${e.source.title.slice(0, 18)}${e.source.title.length > 18 ? '…' : ''}`, title: `${e.source.title} ${e.source.ref}`, open: () => onEvidence(id) };
    return null;
  };
  const sections = [
    ...(narrative ? [{ id: 'narrative', zh: '成稿', n: null }] : []),
    { id: 'answer', zh: '结论', n: null },
    { id: 'verified', zh: '已核实', n: verified.length },
    { id: 'disputed', zh: '有争议', n: disputed.length },
    { id: 'candidates', zh: '候选', n: candidates.length },
    { id: 'negative', zh: '负结果', n: negative.length },
    { id: 'gaps', zh: '缺口', n: gaps.length },
    { id: 'sources', zh: '来源', n: sources.length },
  ].filter(x => x.n === null || x.n > 0);
  const go = (id: string) => scroller.current?.querySelector(`#syn-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const Item = ({ c, open }: { c: Claim; open?: boolean }) => { const h = headline(c.text);
    return <li className="syn-claim" data-status={c.status}>
      <details open={open}><summary><b>{h.head}</b><em className="sw-cs" data-s={c.status}>{CLAIM_ZH[c.status]}</em></summary>
        {h.more && <p className="syn-full">{c.text}</p>}
        <div className="syn-meta"><span>{routeTitle(c.routeId)}</span><span>{BASIS_ZH[c.basis]}</span><span>{label(c.author)}</span><span>证据 {c.evidenceIds.length}</span>{c.reviews.length > 0 && <span>审查 {c.reviews.length}</span>}
          <button className="sw-link" onClick={() => onClaim(c.id)}>看证据与审查 →</button></div>
      </details></li>; };
  return <div className="sw-synth syn" ref={scroller}>
    <nav className="syn-index"><span className="rh-micro">目录</span>{sections.map(x => <button key={x.id} onClick={() => go(x.id)}>{x.zh}{x.n !== null && <small>{x.n}</small>}</button>)}</nav>
    <article className="syn-body">
      <header className="syn-head">
        <span className="rh-micro">{r ? STATE[r.state] : '阶段结果'} · {RUN_ZH[run.state]}</span>
        <h2>{snap.plan?.question ?? run.question}</h2>
        <div className="syn-stats">
          <span><b>{verified.length}</b>已核实</span><span><b>{disputed.length}</b>有争议</span><span><b>{candidates.length}</b>候选</span><span><b>{negative.length}</b>负结果</span>
          <span><b>{run.used.rounds}</b>轮</span><span><b>{dur(run.used.activeMs)}</b>活动</span><span><b>{run.used.cost.known ? `¥${(run.used.cost.value ?? 0).toFixed(2)}` : '未知'}</b>费用</span>
        </div>
      </header>

      {narrative && <section id="syn-narrative" className="syn-sec syn-narrative">
        <h3>成稿 <small>负责人写的全局报告 · 里面的标签点开看原结论和证据</small></h3>
        <IdRef.Provider value={idRef}><div className="sw-md syn-prose"><RichBlocks text={narrative} /></div></IdRef.Provider>
      </section>}

      <section id="syn-answer" className="syn-sec">
        <h3>结论</h3>
        {r?.answer ? <div className="syn-answer"><span className="rh-micro">最强的已核实结论</span><p>{r.answer}</p></div>
          : <p className="syn-note">{verified.length ? '下面是通过独立核实的结论。' : '还没有结论通过独立核实；下面的都只是候选。'}</p>}
        {leadNote && <details className="syn-lead" open><summary>负责人的总结<small>其中没核实的内容，以下面分区为准</small></summary><Md text={leadNote} /></details>}
      </section>

      {verified.length > 0 && <section id="syn-verified" className="syn-sec"><h3>已核实 <small>{verified.length}</small></h3>
        <ol className="syn-list">{verified.map((c, i) => <Item key={c.id} c={c} open={i < 3} />)}</ol></section>}
      {disputed.length > 0 && <section id="syn-disputed" className="syn-sec"><h3>有争议 <small>{disputed.length} · 被反驳后仍有分歧，不能当定论</small></h3>
        <ol className="syn-list">{disputed.map(c => <Item key={c.id} c={c} />)}</ol></section>}
      {candidates.length > 0 && <section id="syn-candidates" className="syn-sec"><h3>候选 <small>{candidates.length} · 还没核实，按路线分</small></h3>
        {groups.map(g => { const list = candidates.filter(c => c.routeId === g);
          return <details key={String(g)} className="syn-group"><summary>{routeTitle(g)}<small>{list.length} 条</small></summary><ol className="syn-list">{list.map(c => <Item key={c.id} c={c} />)}</ol></details>; })}</section>}
      {negative.length > 0 && <section id="syn-negative" className="syn-sec"><h3>负结果 <small>{negative.length} · 找过但没找到</small></h3>
        <ol className="syn-list">{negative.map(c => <Item key={c.id} c={c} />)}</ol></section>}
      {(gaps.length > 0 || limits.length > 0) && <section id="syn-gaps" className="syn-sec"><h3>缺口与局限</h3>
        {gaps.length > 0 && <ul className="syn-bullets">{gaps.map(g => { const h = headline(g); return <li key={g}>{h.more ? <details className="syn-gap"><summary>{h.head}</summary><p>{g}</p></details> : g}</li>; })}</ul>}
        {limits.length > 0 && <details className="syn-group"><summary>局限<small>{limits.length} 条</small></summary><ul className="syn-bullets">{limits.map(g => <li key={g}>{g}</li>)}</ul></details>}</section>}
      {sources.length > 0 && <section id="syn-sources" className="syn-sec"><h3>来源 <small>{sources.length}</small></h3>
        {dc && <p className="syn-disc">全部 {dcTotal} 条证据是怎么找到的：{(['search', 'citation', 'knownUrl', 'unknown'] as const).filter(k => dc[k] > 0).map(k => <span key={k} data-k={k}><b>{dc[k]}</b>{({ search: '搜出来的', citation: '顺着引用找到', knownUrl: '已知网址直接抓', unknown: '没记来路' })[k]}</span>)}
          <small>{dcTotal ? `发现类（搜索 + 引用）占 ${dc.search + dc.citation} / ${dcTotal}；下面只列报告引用的 ${sources.length} 条` : ''}</small></p>}
        {DISC_GROUPS.map(g => { const list = sources.filter(e => (e.discovery ?? null) === g.k); return list.length > 0 && <details key={String(g.k)} className="syn-group"><summary>{g.zh}<small>{list.length} 条</small></summary>
          <ol className="sw-rep-sources">{list.map(e => <li key={e.id}><button onClick={() => onEvidence(e.id)}><b>{e.source.title}</b><small>{e.source.ref}{e.locator?.section ? ` · ${e.locator.section}` : ''}</small></button></li>)}</ol></details>; })}</section>}

      <section className="syn-sec syn-next"><h3>下一步</h3>
        {r?.nextSuggestion ? <p>负责人建议再追加 <b>{r.nextSuggestion.rounds} 轮 / {r.nextSuggestion.minutes} 分钟</b>：{r.nextSuggestion.why}</p> : <p>{run.stateReason ?? '—'}</p>}
      </section>
    </article>
  </div>;
}

const DISC_GROUPS: { k: Evidence['discovery'] | null; zh: string }[] = [
  { k: 'search', zh: '搜出来的' }, { k: 'citation', zh: '顺着引用找到的' }, { k: 'known-url', zh: '已知网址直接抓的' }, { k: null, zh: '没记来路的' },
];

/* ———— 结论 / 证据抽屉：从结论追到证据、任务、队员；从证据看谁引用了它 ———— */
function DetailDrawer({ adapter, item, depth, members, onBack, onClose, onOpen, onMember }: {
  adapter: SwarmAdapter; item: { kind: 'claim' | 'evidence'; id: string }; depth: number; members: SwarmMember[];
  onBack: () => void; onClose: () => void; onOpen: (kind: 'claim' | 'evidence', id: string) => void; onMember: (id: string) => void;
}) {
  const [data, setData] = useState<ClaimDetail | EvidenceDetail | null>(null), [err, setErr] = useState<string | null>(null);
  useEffect(() => { let alive = true; (item.kind === 'claim' ? adapter.claim(item.id) : adapter.evidence(item.id)).then(d => alive && setData(d)).catch(e => alive && setErr(errText(e))); return () => { alive = false; }; }, [adapter, item.kind, item.id]);
  const label = (id: string) => members.find(m => m.id === id)?.label || id;
  // 用精读细看：同一版本 + 同一证据只开一次，再点接着原来那份
  const [reads, setReads] = useState<Record<string, { readDossierId: string }>>({}), [reading, setReading] = useState<string | null>(null), [readErr, setReadErr] = useState<string | null>(null);
  const openRead = async (evidenceId: string) => {
    setReading(evidenceId); setReadErr(null);
    try { const r = await adapter.readEvidence(item.id, evidenceId); setReads(m => ({ ...m, [evidenceId]: { readDossierId: r.readDossierId } })); window.open(readHref(r.readDossierId), '_blank'); }
    catch (e) { setReadErr(errText(e)); } finally { setReading(null); }
  };
  const head = <header><span className="rh-micro">{item.kind === 'claim' ? 'CLAIM · 结论' : 'EVIDENCE · 证据'}</span>
    <b>{item.kind === 'claim' ? '这条结论从哪来' : '这条证据'}</b><small>{depth > 1 ? '可以返回上一层' : '点证据、任务或队员继续追'}</small>
    <span className="sw-detail-act">{depth > 1 && <button className="rh-btn" onClick={onBack}>返回</button>}<button className="rh-btn" onClick={onClose}>关闭</button></span></header>;
  if (err) return <div className="sw-member sw-detail" role="dialog">{head}<p className="sw-member-doing" data-bad>{err}</p></div>;
  if (!data) return <div className="sw-member sw-detail" role="dialog">{head}<p className="sw-none">读取中……</p></div>;
  if ('claim' in data) {
    const c = data.claim;
    // 只认结论自己引用的那几条（后端在引用为空时会把整块黑板的证据都带回来）
    const cited = data.evidence.filter(e => c.evidenceIds.includes(e.id));
    return <div className="sw-member sw-detail" role="dialog" aria-label="结论详情">{head}
      <div className="sw-detail-body">
        <div className="sw-detail-tags"><em className="sw-cs" data-s={c.status}>{CLAIM_ZH[c.status]}</em><span>{BASIS_ZH[c.basis]}</span><span>v{c.version}</span><span>第 {c.round} 轮</span>{c.routeId && <span>路线 {c.routeId}</span>}</div>
        <p className="sw-detail-text">{c.text}</p>
        {c.statusReason && <p className="sw-detail-note">{c.statusReason}</p>}
        {c.conditions.length > 0 && <><h4>适用条件</h4><ul>{c.conditions.map(x => <li key={x}>{x}</li>)}</ul></>}
        {c.negative && <><h4>负结果</h4><dl className="sw-task-meta"><dt>找过</dt><dd>{c.negative.searched}</dd><dt>范围</dt><dd>{c.negative.scope}</dd><dt>没找到</dt><dd>{c.negative.notFound}</dd></dl></>}
        <h4>证据 · {cited.length}</h4>
        {cited.length ? <ol className="sw-ev-list">{cited.map(e => { const read = reads[e.id] ?? data.reads?.find(r => r.evidenceId === e.id);
          return <li key={e.id}><button onClick={() => onOpen('evidence', e.id)}><EvidenceLine e={e} /></button>
            <span className="sw-read">{read ? <a href={readHref(read.readDossierId)}>打开精读 ↗</a> : <button className="sw-link" disabled={reading === e.id} onClick={() => void openRead(e.id)}>{reading === e.id ? '正在开精读……' : '用精读细看这条'}</button>}</span></li>; })}</ol>
          : <p className="sw-none">没有引用证据{c.negative ? '（负结果）' : ''}。</p>}
        {readErr && <p className="sw-member-doing" data-bad>{readErr}</p>}
        <h4>来自</h4>
        <dl className="sw-task-meta">
          <dt>队员</dt><dd>{data.member ? <button className="sw-link" onClick={() => onMember(data.member!.id)}>{data.member.label || label(data.member.id)}</button> : label(c.author)}</dd>
          <dt>任务</dt><dd>{data.task ? `${data.task.id} · ${data.task.title}（${TASK_ZH[data.task.state]}）` : '没挂任务'}</dd>
          <dt>可见</dt><dd>{{ lead_reviewers: '负责人和审查方（独立阶段）', route: '本路线', all: '全队' }[c.visibility]}</dd>
        </dl>
        <h4>审查 · {data.reviews.length}</h4>
        {data.reviews.length ? <ol className="sw-reviews">{data.reviews.map(v => <li key={v.id} data-kind={v.kind} data-verdict={v.verdict} data-stale={v.claimVersion !== c.version || undefined}>
          <span><b>{REVIEW_KIND_ZH[v.kind]}</b><em>{VERDICT_ZH[v.verdict]}</em><small>{label(v.by)} · 针对 v{v.claimVersion}{v.claimVersion !== c.version ? '（旧版本）' : ''} · 第 {v.round} 轮</small>{v.readCompleteness && <i className="sw-readfull" data-full={v.readCompleteness === 'full' || undefined}>{v.readCompleteness === 'full' ? '读全了原文' : '只读了部分'}</i>}</span>
          <p>{v.reason}</p>
          {v.evidenceIds.length > 0 && <span className="sw-review-ev">{v.evidenceIds.map((id, i) => <button key={id} className="sw-link" onClick={() => onOpen('evidence', id)}>核到的证据 {i + 1}</button>)}</span>}
        </li>)}</ol> : <p className="sw-none">还没有人审查这条结论。</p>}
      </div></div>;
  }
  const e = data.evidence, href = sourceHref(e.source.ref);
  return <div className="sw-member sw-detail" role="dialog" aria-label="证据详情">{head}
    <div className="sw-detail-body">
      <div className="sw-detail-tags"><span>{SOURCE_ZH[e.source.kind]}</span><span>{ACCESS_ZH[e.access]}</span>{e.discovery && <span data-disc={e.discovery}>{DISC_ZH[e.discovery]}</span>}{e.source.version && <span>{e.source.version}</span>}</div>
      <p className="sw-detail-text"><b>{e.source.title}</b></p>
      <p className="sw-detail-ref">{href ? <a href={href} target="_blank" rel="noreferrer">{e.source.ref} ↗</a> : e.source.ref}</p>
      {e.locator && <><h4>位置</h4><p>{[e.locator.section, e.locator.page ? `第 ${e.locator.page} 页` : '', e.locator.lines].filter(Boolean).join(' · ') || '—'}</p>{e.locator.quote && <blockquote className="sw-quote">{e.locator.quote}</blockquote>}</>}
      <h4>怎么拿到的</h4><p>{e.how}</p>
      <h4>引用它的结论 · {data.referencedBy.length}</h4>
      <ol className="sw-ev-list">{data.referencedBy.map(x => <li key={x.claimId + x.claimVersion}><button onClick={() => onOpen('claim', x.claimId)}><p>{x.text}</p><small>v{x.claimVersion}</small></button></li>)}</ol>
    </div></div>;
}
function EvidenceLine({ e }: { e: Evidence }) {
  return <span className="sw-ev"><b>{e.source.title}</b><small>{e.source.ref}{e.locator?.section ? ` · ${e.locator.section}` : ''}{e.locator?.page ? ` · 第 ${e.locator.page} 页` : ''}</small>{e.locator?.quote && <q>{e.locator.quote}</q>}</span>;
}

/* ———— 队员抽屉：实际可见的工作记录 ———— */
function MemberDrawer({ adapter, member, tick, onClose, onMention }: { adapter: SwarmAdapter; member: SwarmMember; tick: number; onClose: () => void; onMention?: (text: string) => void }) {
  const [say, setSay] = useState('');
  const [items, setItems] = useState<MemberLogItem[] | null>(null), [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => { let alive = true; adapter.memberLog(member.id, 0).then(r => { if (alive) { setItems(r.items); setErr(null); } }).catch(e => alive && setErr(errText(e))); return () => { alive = false; }; }, [adapter, member.id, tick]);
  if (!member) return null;
  return <div className="sw-member" role="dialog" aria-label={`${member.label} 的工作记录`}>
    <header><span className="rh-micro">{ROLE[member.role].en}</span><b>{member.label}</b><small>{member.model} · {member.context === 'fresh' ? '全新上下文' : '继承上下文'} · {MEMBER_ZH[member.state]}</small><button className="rh-btn" onClick={onClose}>关闭</button></header>
    {member.state === 'running' && member.doing && <p className="sw-member-doing">正在：{member.doing.summary}</p>}
    {member.failReason && <p className="sw-member-doing" data-bad>失败原因：{member.failReason}</p>}
    {onMention && <form className="sw-mention" onSubmit={e => { e.preventDefault(); if (say.trim()) { onMention(say.trim()); setSay(''); } }}>
      <input value={say} onChange={e => setSay(e.target.value)} placeholder={`对 ${member.label} 说（定向投递，不会告诉其他路线）`} /><button className="rh-btn is-solid" disabled={!say.trim()}>发给 ta</button></form>}
    <ol>{err ? <li className="sw-none">{err}</li> : !items ? <li className="sw-none">读取中……</li> : !items.length ? <li className="sw-none">还没有记录。</li>
      : items.map(x => <li key={x.seq} data-kind={x.kind} data-failed={x.tool?.state === 'failed' || undefined}><button onClick={() => setOpen(o => o === x.seq ? null : x.seq)}>
        <time>{hhmm(x.at) || `#${x.seq}`}</time><span><b>{x.tool ? x.tool.name : { input: '输入', tool: '工具', source: '来源', output: '产出', message_in: '收到', message_out: '发出', summary: '摘要' }[x.kind]}</b><p>{x.tool?.args ? x.tool.args.slice(0, 160) : x.text}</p></span></button>
        {open === x.seq && x.tool && <div className="sw-member-io">{x.tool.args && <pre><small>参数</small>{x.tool.args}</pre>}{x.tool.result && <pre><small>结果</small>{x.tool.result}</pre>}</div>}</li>)}</ol>
  </div>;
}
