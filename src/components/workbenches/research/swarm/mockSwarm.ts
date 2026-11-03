// 群研 · 模拟适配器（CI 与 ?preview 用）：一份快照 + 一串事件按时间回放，和真实事件流同一种形状。
// 内容是示意，不代表真实研究结论；真实模式下由 src/data/swarm-live.ts 接后端。
import type {
  Review, Claim, ClaimDetail, Evidence, EvidenceDetail, SwarmReport, BoardPost, BusEntry, BusType, Intervention, SwarmAdapter, SwarmEvent, SwarmEventType, SwarmMember, SwarmPlan, SwarmRoute, SwarmRun, SwarmSnapshot, SwarmTask,
} from './swarmTypes';
import { applyEvent, createHub } from './swarmStore';

const Q = '多 Agent 数量增加是否一定提高研究质量？';
const T0 = Date.UTC(2026, 10, 3, 2, 0, 0);
const iso = (sec: number) => new Date(T0 + sec * 1000).toISOString();

const PLAN: SwarmPlan = {
  version: 1, question: Q, needsConfirm: true,
  scope: '只看 LLM 多智能体的实证研究：把 agent 数量、角色数或并行宽度当自变量的对照与消融。纯立场文章、非 LLM 的多智能体不算证据。',
  qualityCriteria: ['关键论断落到具体论文的表格或页码', '同时覆盖「加人有益」和「加人无益/有害」两类证据，并写清各自条件', '给出何时加、何时别加的条件性结论，列出证据缺口'],
  routes: [
    { id: 'r1', title: '规模扫描', idea: '找把 agent 数当超参扫描的论文，取每一档的指标点、拐点和饱和点。', differsBy: '以数量为横轴的定量曲线' },
    { id: 'r2', title: '机制与失败模式', idea: '错误传播、通信开销、同质化冗余：解释增益为何饱和或反转。', differsBy: '问机制，产出边界条件' },
    { id: 'r3', title: '结构对照', idea: '同样人数、不同编排（链 / 辩论 / 路由）的对照，检验「结构比数量更要紧」。', differsBy: '把数量放进任务与拓扑矩阵' },
  ],
  roster: [
    { role: 'lead', count: 1, model: 'deepseek-v4-flash' }, { role: 'researcher', count: 3, model: 'deepseek-v4-flash', routeIds: ['r1', 'r2', 'r3'] },
    { role: 'critic', count: 1, model: 'deepseek-v4-flash' }, { role: 'verifier', count: 1, model: 'deepseek-v4-flash' },
  ],
  limits: { rounds: 4, minutes: 30 },
};

const run = (patch: Partial<SwarmRun> = {}): SwarmRun => ({
  id: 'mock-run', dossierId: 'mock-dossier', question: Q, state: 'running', phase: 'independent', round: 1, planVersion: 1,
  limits: { rounds: 4, minutes: 30 }, used: { rounds: 0, activeMs: 0, cost: { value: 0.02, known: true }, tokens: 9000 },
  members: { used: 0, max: 16 }, startedAt: iso(0), endedAt: null, ...patch,
});
const member = (id: string, role: SwarmMember['role'], label: string, state: SwarmMember['state'] = 'creating'): SwarmMember =>
  ({ id, role, label, tags: [], model: 'deepseek-v4-flash', context: 'fresh', state, sessionId: 's-' + id });
const task = (id: string, patch: Partial<SwarmTask>): SwarmTask => ({
  id, revision: 1, parentId: 'task-1', kind: 'research', title: '', routeId: null, round: 1, planVersion: 1, contractVersion: 1,
  owner: null, board: 'pending', state: 'open', dependsOn: [], submissions: [], updatedAt: iso(0), ...patch,
});
const route = (r: SwarmPlan['routes'][number], taskIds: string[], patch: Partial<SwarmRoute> = {}): SwarmRoute =>
  ({ id: r.id, title: r.title, idea: r.idea, approachFamily: r.differsBy, tags: [], state: 'active', taskIds, memberIds: [], ...patch });

/** 剧本：[秒, 类型, 数据]。bus 的 seq 由回放时补。 */
type Step = [number, SwarmEventType, unknown];
const bus = (from: string, to: BusEntry['to'], type: BusType, text: string, refs: BusEntry['refs'] = {}, extra: Partial<BusEntry> = {}) =>
  ({ from, to, type, text, refs, ...extra }) as Omit<BusEntry, 'seq' | 'at'>;

const R1 = 'researcher-01', R2 = 'researcher-02', R3 = 'researcher-03', C = 'critic-01', V = 'verifier-01';
function script(): Step[] {
  const s: Step[] = [];
  const at = (t: number, type: SwarmEventType, data: unknown) => s.push([t, type, data]);
  at(0, 'run', run({ members: { used: 0, max: 16 }, stateReason: '计划已确认，负责人在建队。' }));
  at(0.6, 'task', task('task-1', { parentId: null, kind: 'root', title: '根任务：汇总与交付', routeId: null, owner: 'lead', board: 'in_progress', state: 'doing' }));
  at(0.8, 'bus', bus('lead', 'board', 'broadcast', '决定：比较维度统一为「人数 × 指标 × 成本」，各路线先独立做两轮。', { taskId: 'task-1' }));
  [[R1, 1.2], [R2, 1.6], [R3, 2.0], [C, 2.4], [V, 2.8]].forEach(([id, t], i) => {
    const role = i < 3 ? 'researcher' : i === 3 ? 'critic' : 'verifier';
    const label = i < 3 ? `研究员 0${i + 1}` : i === 3 ? '反驳 01' : '核实 01';
    at(t as number, 'member', member(id as string, role as SwarmMember['role'], label));
    at((t as number) + 0.8, 'member', { ...member(id as string, role as SwarmMember['role'], label, 'idle') });
    at((t as number) + 0.9, 'run', run({ members: { used: i + 1, max: 16 } }));
  });
  PLAN.routes.forEach((r, i) => {
    const id = `task-${i + 2}`, who = [R1, R2, R3][i], t = 4 + i * 0.6;
    at(t, 'task', task(id, { title: `${r.id}｜${r.title}`, routeId: r.id }));
    at(t + 0.1, 'route', route(r, [id], { memberIds: [who] }));
    at(t + 0.2, 'bus', bus('lead', 'board', 'broadcast', `新任务：${r.id}｜${r.title}`, { taskId: id }));
    at(t + 1.5, 'task', task(id, { revision: 2, title: `${r.id}｜${r.title}`, routeId: r.id, owner: who, board: 'in_progress', state: 'doing' }));
    at(t + 1.5, 'bus', bus(who, 'lead', 'claim', `我来做 ${r.id}。`, { taskId: id }, { delivery: 'sent', taskUpdates: [{ id, state: 'doing' }] }));
    at(t + 1.6, 'member', { ...member(who, 'researcher', `研究员 0${i + 1}`, 'running'), doing: { taskId: id, summary: '检索论文' } });
  });
  at(5, 'task', task('task-5', { kind: 'review', title: '反驳：可比性与算力混淆', routeId: null, dependsOn: ['task-2', 'task-3', 'task-4'], state: 'blocked', blockedBy: { taskIds: ['task-2', 'task-3', 'task-4'], reason: '三条路线的交付还没到' } }));
  at(5.2, 'task', task('task-6', { kind: 'verify', title: '核实：页码与摘句复验', routeId: null, dependsOn: ['task-5'], state: 'blocked', blockedBy: { taskIds: ['task-5'], reason: '要先有反驳意见' } }));
  at(9, 'bus', bus(R2, 'lead', 'ask', '「同质化冗余」要不要算进失败模式？还是只算错误传播？', { taskId: 'task-3', questionId: 'q-1' }, { delivery: 'sent' }));
  at(9.2, 'post', { id: 'p-1', col: 'question', by: R2, text: '「同质化冗余」要不要算进失败模式？', at: iso(9.2), seq: 0, to: 'lead', refs: { taskId: 'task-3' } } satisfies BoardPost);
  at(11, 'bus', bus('lead', R2, 'message', '算。它是投票不去相关的来源，单独列一类。', { taskId: 'task-3', questionId: 'q-1' }, { delivery: 'sent' }));
  at(11.1, 'post', { id: 'p-2', col: 'question', by: 'lead', text: '算，单独列一类。', at: iso(11.1), seq: 0, to: R2, replyTo: 'p-1', refs: { taskId: 'task-3' } } satisfies BoardPost);
  at(11.2, 'post', { id: 'p-1', col: 'question', by: R2, text: '「同质化冗余」要不要算进失败模式？', at: iso(9.2), seq: 0, to: 'lead', answered: true, refs: { taskId: 'task-3' } } satisfies BoardPost);
  at(14, 'bus', bus(R3, 'board', 'help', '找到的拓扑对照多半人数不一样，同人数不同结构的很少，求线索。', { taskId: 'task-4' }));
  at(14.1, 'post', { id: 'p-3', col: 'help', by: R3, text: '同人数、不同结构的对照很少，求线索。', at: iso(14.1), seq: 0, refs: { taskId: 'task-4', routeId: 'r3' } } satisfies BoardPost);
  at(17, 'task', task('task-2', { revision: 3, title: 'r1｜规模扫描', routeId: 'r1', owner: R1, board: 'completed', state: 'delivered', submissions: ['sub-1'] }));
  at(17, 'bus', bus(R1, 'lead', 'deliver', '交付 r1：五篇论文的人数—指标曲线，三篇在 4–8 人后饱和（候选，待核实）。', { taskId: 'task-2' }, { delivery: 'sent', taskUpdates: [{ id: 'task-2', state: 'delivered' }] }));
  at(17.1, 'post', { id: 'p-4', col: 'finding', by: R1, text: '多数曲线在 4–8 人后饱和，成本仍线性上升（候选）。', at: iso(17.1), seq: 0, refs: { taskId: 'task-2', routeId: 'r1' } } satisfies BoardPost);
  at(16.9, 'evidence', EV1); at(16.9, 'evidence', EV2);
  at(17.0, 'claim', claim('c-1', R1, 'task-2', 'r1', 'MoA 的 agent 数消融：收益几乎全在 1→2 个（+11 分），再加 4 个只再得 +2.5 分。', 'checked_fact', ['e-1'], ['AlpacaEval 2.0 LC', '2 层 MoA']));
  at(17.05, 'claim', claim('c-2', R1, 'task-2', 'r1', '投票式加采样在多数任务上随人数单调变好，但增益随难度变化。', 'source_claim', ['e-2', 'e-1'], ['采样 + 多数投票']));
  at(17.1, 'report', report(['c-1', 'c-2'], [], ['e-1', 'e-2']));
  at(17.2, 'member', { ...member(R1, 'researcher', '研究员 01', 'idle') });
  at(20, 'task', task('task-3', { revision: 3, title: 'r2｜机制与失败模式', routeId: 'r2', owner: R2, board: 'completed', state: 'sync_pending', submissions: ['sub-2'] }));
  at(20, 'bus', bus(R2, 'lead', 'deliver', '交付 r2：错误级联、通信挤占上下文、同质化三类失败条件。', { taskId: 'task-3' }, { delivery: 'unknown' }));
  at(21.5, 'task', task('task-3', { revision: 4, title: 'r2｜机制与失败模式', routeId: 'r2', owner: R2, board: 'completed', state: 'delivered', submissions: ['sub-2'] }));
  at(21.5, 'claim', { ...claim('c-3', R2, 'task-3', 'r2', '没有找到「同 token 预算下多 agent 稳定优于单 agent 多次采样」的对照实验。', 'observation', [], []), negative: { searched: 'arXiv、OpenAlex：equal compute / token budget multi-agent', scope: '2023–2026 LLM 多智能体', notFound: '同预算头对头对照' } });
  at(21.55, 'report', report(['c-1', 'c-2', 'c-3'], ['c-3'], ['e-1', 'e-2'], ['缺同 token 预算下的头对头对照']));
  at(21.6, 'member', { ...member(R2, 'researcher', '研究员 02', 'idle') });
  at(24, 'route', route(PLAN.routes[2], ['task-4'], { state: 'blocked', memberIds: [R3], gap: '缺同人数、不同结构的对照实验', blockedReason: '卡在和原题一样难的缺口上，等有新机制再开' }));
  at(24, 'task', task('task-4', { revision: 3, title: 'r3｜结构对照', routeId: 'r3', owner: R3, board: 'completed', state: 'delivered', submissions: ['sub-3'] }));
  at(24.1, 'bus', bus('lead', 'board', 'broadcast', '决定：r3 标阻塞，保留已找到的两篇，第 3 轮再看是否有新机制。', { taskId: 'task-4' }));
  at(24.2, 'post', { id: 'p-5', col: 'decision', by: 'lead', text: 'r3 标阻塞：缺同人数不同结构的对照。保留已有证据。', at: iso(24.2), seq: 0, refs: { routeId: 'r3' }, scope: { planVersion: 1 } } satisfies BoardPost);
  at(24.3, 'member', { ...member(R3, 'researcher', '研究员 03', 'idle') });
  at(25, 'task', task('task-5', { revision: 2, kind: 'review', title: '反驳：可比性与算力混淆', owner: C, board: 'in_progress', state: 'doing', dependsOn: ['task-2', 'task-3', 'task-4'] }));
  at(25.1, 'member', { ...member(C, 'critic', '反驳 01', 'running'), doing: { taskId: 'task-5', summary: '对照原文表格' } });
  at(25.2, 'run', run({ round: 2, used: { rounds: 1, activeMs: 25000, cost: { value: 0.31, known: true }, tokens: 120000 }, members: { used: 5, max: 16 } }));
  at(27, 'review', { id: 'rv-1', claimId: 'c-1', claimVersion: 1, kind: 'verify', by: V, reason: '回到 MoA 原文 Table 4 逐格核对，四档数字一致。', evidenceIds: ['e-1'], verdict: 'verified', round: 2, taskId: 'task-6' } satisfies Review);
  at(27.05, 'claim', { ...claim('c-1', R1, 'task-2', 'r1', 'MoA 的 agent 数消融：收益几乎全在 1→2 个（+11 分），再加 4 个只再得 +2.5 分。', 'checked_fact', ['e-1'], ['AlpacaEval 2.0 LC', '2 层 MoA']), status: 'verified', reviews: ['rv-1'] } satisfies Claim);
  at(29.05, 'review', { id: 'rv-2', claimId: 'c-2', claimVersion: 1, kind: 'refute', by: C, reason: '「单调变好」只在同一算力口径下成立；原文 §5.1 没有控制总 token，不能外推成普遍结论。', evidenceIds: ['e-2'], verdict: 'upheld', round: 2, taskId: 'task-5' } satisfies Review);
  at(29.1, 'claim', { ...claim('c-2', R1, 'task-2', 'r1', '投票式加采样在多数任务上随人数单调变好，但增益随难度变化。', 'source_claim', ['e-2', 'e-1'], ['采样 + 多数投票']), status: 'disputed', reviews: ['rv-2'] } satisfies Claim);
  at(29.15, 'report', { ...report(['c-3'], ['c-3'], ['e-1', 'e-2'], ['缺同 token 预算下的头对头对照']), verified: ['c-1'], disputed: ['c-2'], answer: 'MoA 的 agent 数消融：收益几乎全在 1→2 个（+11 分），再加 4 个只再得 +2.5 分。' });
  at(29, 'bus', bus(C, R1, 'refute', 'r1 的饱和点把总 token 也翻倍了：同预算下比较时增益可能消失，要补同预算对照。', { taskId: 'task-5' }, { delivery: 'sent' }));
  at(31, 'bus', bus('lead', C, 'interrupt', '先停一下这条，等 r1 补同预算数据再继续。', { taskId: 'task-5' }));
  at(31.1, 'member', { ...member(C, 'critic', '反驳 01', 'interrupted'), doing: null });
  at(34, 'run', run({ round: 2, used: { rounds: 1, activeMs: 34000, cost: { value: null, known: false }, tokens: null }, members: { used: 5, max: 16 }, stateReason: '第 2 轮：独立探索中' }));
  return s.sort((a, b) => a[0] - b[0]);
}

const EV1: Evidence = { id: 'e-1', source: { kind: 'paper', title: 'Mixture-of-Agents Enhances Large Language Model Capabilities', ref: 'arXiv:2406.04692', version: 'v1' }, locator: { section: 'Table 4', quote: 'n=1 47.8%; n=2 58.8%; n=3 58.0%; n=6 61.3%' }, access: 'full_text', how: 'arXiv HTML 全文' };
const EV2: Evidence = { id: 'e-2', source: { kind: 'paper', title: 'More Agents Is All You Need', ref: 'arXiv:2402.05120', version: 'v2' }, locator: { section: '§5.1 Generalizability', quote: 'our method generally enhances performance across all tasks and LLMs by increasing the ensemble size.' }, access: 'full_text', how: 'arXiv HTML 全文' };
function claim(id: string, author: string, taskId: string, routeId: string, text: string, basis: Claim['basis'], evidenceIds: string[], conditions: string[]): Claim {
  return { id, version: 1, text, conditions, basis, status: 'candidate', evidenceIds, author, taskId, routeId, submissionId: 'sub-' + id, round: 1, reviews: [], refuteRounds: 0, visibility: 'lead_reviewers', negative: null };
}
function report(unverified: string[], negative: string[], sources: string[], gaps: string[] = []): SwarmReport {
  return { version: 1, state: 'stage', answer: null, verified: [], limits: ['核实还没接通：以下全部是候选'], disputed: [], unverified, negative, gaps, sources, updatedAt: new Date().toISOString() };
}

function initial(): SwarmSnapshot {
  return {
    run: run({ state: 'awaiting_confirm', round: 0, startedAt: null, stateReason: '等你确认计划' }), plan: PLAN,
    members: [{ ...member('lead', 'lead', '负责人', 'running') }], tasks: [], routes: [], posts: [], claims: [], evidence: [], reviews: [],
    interventions: [], report: null, pendingApprovals: [], cursor: 0,
  };
}

export function mockSwarmAdapter(): SwarmAdapter {
  const hub = createHub();
  let seq = 0, timers: ReturnType<typeof setTimeout>[] = [];
  const emit = (type: SwarmEventType, data: unknown, atSec?: number) => {
    seq++;
    const at = atSec === undefined ? new Date().toISOString() : iso(atSec);
    const payload = type === 'bus' ? { ...(data as object), seq, at } : type === 'post' ? { ...(data as object), seq } : data;
    hub.set(v => applyEvent(v, { seq, at, runId: 'mock-run', dossierId: 'mock-dossier', type, data: payload } as SwarmEvent));
  };
  const play = () => {
    const start = Date.now();
    for (const [t, type, data] of script()) timers.push(setTimeout(() => emit(type, type === 'run' ? { ...(data as SwarmRun), startedAt: new Date(start).toISOString(), used: { ...(data as SwarmRun).used, activeMs: Date.now() - start } } : data, undefined), t * 1000));
  };
  const say = (kind: 'user' | 'agent' | 'note', text: string) => hub.set(v => ({ ...v, dock: [...v.dock, { id: 'd' + v.dock.length, kind, text, at: new Date().toISOString() }] }));
  const intervention = (kind: Intervention['kind'], text?: string): Intervention => ({ id: 'iv-' + Date.now(), kind, text, state: 'received', at: new Date().toISOString() });

  return {
    async load() {
      timers.forEach(clearTimeout); timers = [];
      hub.set(v => ({ ...v, snap: initial(), bus: [], conn: 'live', dock: [
        { id: 'd0', kind: 'user', text: Q, at: iso(0) },
        { id: 'd1', kind: 'agent', text: '我把边界、质量判据和三条路线整理成了计划，默认 1+3+1+1、4 轮 / 30 分钟。看一下再确认，确认后才建队。', at: iso(1) },
      ] }));
      if (new URLSearchParams(location.search).get('swarm') === 'running') { hub.set(v => v.snap ? { ...v, snap: { ...v.snap, run: run() } } : v); play(); }
    },
    subscribe: (on) => hub.subscribe(on),
    async timeline() { return { entries: hub.get().bus, next: null }; },
    async memberLog(memberId) {
      return { items: [
        { seq: 1, at: iso(5), kind: 'input', text: '收到任务合同：只做本路线，不读其他路线的产出。' },
        { seq: 2, at: iso(6), kind: 'tool', text: '调用 papers_search', tool: { name: 'papers_search', state: 'done', args: '{"query":"number of agents ablation"}', result: '12 篇候选' } },
        { seq: 3, at: iso(9), kind: 'source', text: '打开 More Agents Is All You Need，第 5 页表 2' },
        { seq: 4, at: iso(12), kind: 'output', text: `${memberId} 写入自己的子目录：findings.md` },
      ], next: null };
    },
    async send(text) {
      say('user', text);
      const st = hub.get().snap?.run.state;
      if (st === 'awaiting_confirm') { setTimeout(() => say('agent', '收到，我会在确认前按你的意思改计划。'), 600); return; }
      emit('post', { id: 'p-u' + Date.now(), col: 'question', by: 'user', text: `@lead ${text}`, at: new Date().toISOString(), to: 'lead', refs: {} });
      emit('intervention', { ...intervention('mention', text), state: 'delivered', target: { memberId: 'lead' } });
    },
    async answer() { /* 模拟版没有提问卡 */ },
    async post(text) {
      const p: BoardPost = { id: 'p-u' + Date.now(), col: 'question', by: 'user', text, at: new Date().toISOString(), seq: 0, to: text.match(/@(\S+)/)?.[1] ?? null, refs: {} };
      emit('post', p);
      return p;
    },
    async intervene(kind, extra = {}) {
      const iv = intervention(kind, extra.text);
      emit('intervention', iv);
      const cur = hub.get().snap!.run;
      setTimeout(() => {
        if (kind === 'pause') { timers.forEach(clearTimeout); timers = []; emit('run', { ...cur, state: 'paused', stateReason: '你暂停了，计时停住。' }); emit('intervention', { ...iv, state: 'applied', result: '已暂停：停止派发并打断正在做的队员。' }); }
        if (kind === 'resume') { emit('run', { ...cur, state: 'running', stateReason: '已继续' }); emit('intervention', { ...iv, state: 'applied', result: '已继续，先核对现状再往下走。' }); }
        if (kind === 'finish') { timers.forEach(clearTimeout); timers = []; emit('run', { ...cur, state: 'partial', endReason: 'user_finished', endedAt: new Date().toISOString(), stateReason: '你结束了这次群研；已交付的产出保留，但没有经过核实的结论。' }); emit('intervention', { ...iv, state: 'applied', result: '已停止新增工作，保存已有结论和未完成项。' }); hub.set(v => ({ ...v, conn: 'idle' })); }
        if (kind === 'stop_route') emit('intervention', { ...iv, state: 'applied', result: '已停止这条路线，产出保留。' });
      }, 500);
      return iv;
    },
    async confirmPlan() {
      say('note', '你确认了计划 v1，开跑。');
      play();
    },
    async report() { return hub.get().snap?.report ?? null; },
    async claim(claimId): Promise<ClaimDetail> {
      const snap = hub.get().snap!, c = snap.claims.find(x => x.id === claimId);
      if (!c) throw Error('这条结论不存在。');
      const t = snap.tasks.find(x => x.id === c.taskId), m = snap.members.find(x => x.id === c.author);
      return { claim: c, evidence: snap.evidence.filter(e => c.evidenceIds.includes(e.id)), reviews: snap.reviews.filter(r => r.claimId === c.id), task: t ? { id: t.id, title: t.title, state: t.state, routeId: t.routeId } : null, member: m ? { id: m.id, label: m.label, role: m.role } : null };
    },
    async evidence(evidenceId): Promise<EvidenceDetail> {
      const snap = hub.get().snap!, e = snap.evidence.find(x => x.id === evidenceId);
      if (!e) throw Error('这条证据不存在。');
      return { evidence: e, referencedBy: snap.claims.filter(c => c.evidenceIds.includes(e.id)).map(c => ({ claimId: c.id, claimVersion: c.version, text: c.text })) };
    },
  };
}
