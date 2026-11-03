# 13 · 研究台群研 · 前端契约

日期：2026-11-02。分支：`codex/swarm`。依据：[12-swarm.md](12-swarm.md)（用户已批准，冲突以它为准）、[11-swarm-ux.md](11-swarm-ux.md)。

沿用已有约定：路由在 `/backend` 同源前缀下、认 Cookie；写操作带 `X-ReinLab-CSRF: 1` 和 `Idempotency-Key`；错误 `{ code, message }`；审批走现有收件箱 `/v1/approvals`；资源地址服务端给 `/v1/...`、前端补 `/backend`。共用类型放 `packages/contracts/src/swarm.ts`，前后端都从这里引。

## 0. 分工

| 部分 | Claude（前端） | DSH（后端 / 插件 / 测试） |
|---|---|---|
| 四个面 | 任务树、通信、留言板、汇总改成吃 `SwarmSnapshot` + 事件；去掉定时剧本；样式与交互沿用现有 `swarm/` | 提供快照、时间线、事件流；所有字段由服务端算好（状态、阻塞原因、是否被挡住） |
| 开跑前 | 在 AgentDock 里和负责人澄清；计划卡（问题、路线、编制、轮数/时长）确认按钮 | 负责人会话、产出 `SwarmPlan`、确认后建队 |
| 队员 | 名册、状态、模型、全新/继承；点开看工作记录 | DSH 团队成员投影 + 会话可见记录（不含推理原文） |
| 干预 | @队员、改方向、加人、停路线、暂停/继续、结束、追加额度的入口和回执 | 干预落库、投递、审批卡、执行与回执事件 |
| 收件箱 | 新审批种类的卡面（加人、追加、分歧、扩大范围），提问卡沿用已有 `ask` | 卡片入 `/v1/approvals`，批准/回答后续接 |
| 委托 | 源台「交给群研」确认卡；源档案的结果卡与「采用 / 不采用」 | 委托合同、幂等建档开跑、结果卡回写与版本 |

前端只读服务端投影，**不在前端推断**结论状态、阻塞、轮次或费用。

## 1. 类型（`packages/contracts/src/swarm.ts`）

```ts
type Iso = string;
type Cny = { value: number | null; known: boolean };   // 用量未知 → { value: null, known: false }，不记 0；按峰值费率估

// ── 运行 ──
type SwarmRunState =
  | 'clarifying'        // 负责人在和用户澄清
  | 'awaiting_confirm'  // 计划已出，等用户确认（不计时）
  | 'running'
  | 'waiting_user'      // 全队等用户（计时暂停）；只有部分路线等用户时仍是 running
  | 'paused'            // 用户暂停（计时暂停）
  | 'near_limit'        // 临近额度，展示追加建议，仍在跑
  | 'finishing'         // 停止新增任务、收尾中
  | 'awaiting_review'   // 报告前有分歧，等用户看一眼
  | 'done' | 'partial' | 'unresolved' | 'cancelled' | 'failed';
type SwarmPhase = 'independent' | 'cross';     // 前 2 轮 independent，第 3 轮起 cross

type SwarmRun = {
  id: string; dossierId: string; question: string;
  state: SwarmRunState; phase: SwarmPhase;
  round: number;                 // 当前轮，从 1 起；未开跑为 0
  planVersion: number;
  limits: { rounds: number; minutes: number };          // 用户确认的额度（最少 4 轮 / 30 分钟）
  used: { rounds: number; activeMs: number; cost: Cny; tokens: number | null };
  members: { used: number; max: 16 };                   // 累计创建（失败也占名额）
  stateReason?: string;          // 人话：为什么在这个状态（如「等你回答 Q-3」「到达 30 分钟」）
  endReason?: 'answered' | 'all_blocked' | 'user_finished' | 'limit' | 'cancelled' | 'error';
  delegation?: { id: string; fromBench: Bench; fromDossierId: string } | null;
  startedAt: Iso | null; endedAt: Iso | null;
};
type Bench = 'curriculum' | 'engineering' | 'data' | 'design' | 'research' | 'exploration' | 'automation';

// ── 计划（开跑前确认 / 改方向时出新版本）──
type SwarmPlan = {
  version: number; question: string;
  scope: string;                 // 边界：包含什么、不包含什么
  qualityCriteria: string[];     // 怎么判断答得好
  routes: { id: string; title: string; idea: string; differsBy: string }[];  // 不同路线
  roster: { role: MemberRole; count: number; model: string; routeIds?: string[] }[];
  limits: { rounds: number; minutes: number };
  diffFrom?: { version: number; changes: string[] };    // 改方向时：只给新旧差异
  needsConfirm: boolean;         // 首版、或扩大原问题范围时为 true
};

// ── 队员（DSH 团队成员投影）──
type MemberRole = 'lead' | 'researcher' | 'critic' | 'verifier';
type SwarmMember = {
  id: string;                    // DSH 成员名，不复用；负责人固定 'lead'
  role: MemberRole; label: string;          // 显示名，如「研究员 02」
  tags: string[];                // 逻辑小组 / 路线标签
  model: string;
  context: 'fresh' | 'inherited';
  state: 'creating' | 'running' | 'idle' | 'interrupted' | 'failed';
  doing?: { taskId: string; summary: string } | null;   // 正在做什么（人话一行）
  sessionId: string;
  failReason?: string;
};

// ── 任务（DSH 任务板是唯一真源；研究含义另挂）──
type SwarmTask = {
  id: string; revision: number;            // DSH task id / 版本
  parentId: string | null;                 // 树形：根问题 → 路线 → 任务
  kind: 'root' | 'route' | 'research' | 'review' | 'verify' | 'synthesis' | 'other';
  title: string;
  routeId: string | null; round: number; planVersion: number; contractVersion: number | null;
  owner: string | null;                    // 成员 id
  board: 'pending' | 'in_progress' | 'completed';   // DSH 原生状态，原样
  state:                                   // 服务端合成的研究状态（界面用这个）
    | 'open' | 'doing' | 'delivered' | 'sync_pending'   // 交付已存、任务状态待同步
    | 'blocked' | 'waiting_user' | 'stopped' | 'failed' | 'superseded';
  dependsOn: string[];
  blockedBy?: { taskIds: string[]; reason: string } | null;    // 被挡住及原因
  submissions: string[];                   // submission_id
  updatedAt: Iso;
};

// ── 路线 ──
type SwarmRoute = {
  id: string; title: string; idea: string; approachFamily: string; tags: string[];
  state: 'active' | 'blocked' | 'stopped' | 'reopened' | 'merged';
  gap?: string;                  // 当前缺口
  blockedReason?: string; reopenReason?: string;
  taskIds: string[]; memberIds: string[];
};

// ── 黑板对象 ──
type ClaimStatus = 'candidate' | 'awaiting_refute' | 'awaiting_verify' | 'verified' | 'disputed' | 'falsified' | 'insufficient';
type Claim = {
  id: string; version: number; text: string; conditions: string[];
  basis: 'checked_fact' | 'source_claim' | 'inference' | 'observation';
  status: ClaimStatus; statusReason?: string;   // 证伪原因 / 证据不足的缺口
  evidenceIds: string[]; author: string; taskId: string; routeId: string | null;
  submissionId: string; round: number;
  reviews: string[];             // review ids
  refuteRounds: number;          // ≤ 2
  visibility: 'lead_reviewers' | 'route' | 'all';   // 独立阶段不对其他路线开放
  negative?: { searched: string; scope: string; notFound: string } | null;  // 负结果
};
type Evidence = {
  id: string;
  source: { kind: 'paper' | 'web' | 'code' | 'data' | 'proof' | 'other'; title: string; ref: string;   // DOI / URL / 资产 ID
            assetId?: string; version?: string };
  locator: { page?: number; section?: string; lines?: string; quote?: string } | null;
  access: 'full_text' | 'abstract_only' | 'unavailable';
  how: string;                   // 怎么拿到的（检索 / 下载 / 实测）
  readHref?: string;             // 能跳精读的页码锚点（/v1/... 由前端补前缀）
};
type Review = {
  id: string; claimId: string; claimVersion: number;
  kind: 'refute' | 'need_evidence' | 'verify' | 'downgrade';
  by: string; reason: string; evidenceIds: string[];
  verdict: 'upheld' | 'rejected' | 'verified' | 'not_verifiable' | 'pending';
  round: number; taskId: string;
};
type BoardPost = {               // 留言板四栏
  id: string; col: 'question' | 'finding' | 'help' | 'decision';
  by: string | 'user'; text: string; at: Iso; seq: number;
  to?: string | null;            // 提问指定接收者；null = 公开
  replyTo?: string;              // 回答配对
  answered?: boolean;
  refs: { claimId?: string; taskId?: string; routeId?: string; approvalId?: string };
  scope?: { planVersion: number };          // 决定的适用范围
};

// ── 通信时间线（服务端拼）──
type BusType =
  | 'broadcast' | 'claim' | 'ask' | 'deliver' | 'help' | 'handoff' | 'refute'   // 现有 7 种
  | 'verify' | 'message' | 'interrupt' | 'conflict' | 'user' | 'system';       // 新增
type BusEntry = {
  seq: number;                   // 全局事件序号：排序和因果只看它，不看时间戳
  at: Iso;
  type: BusType;
  from: string | 'user' | 'system';
  to: string | 'board' | 'all' | null;
  text: string;                  // 人话一行
  delivery?: 'sent' | 'received' | 'failed' | 'unknown';    // 发送结果（message_id 只代表接收成功）
  refs: { taskId?: string; claimId?: string; postId?: string; questionId?: string;
          reviewId?: string; interventionId?: string; sessionSeq?: { sessionId: string; seq: number } };
  taskUpdates?: { id: string; state: SwarmTask['state'] }[];   // 这条导致的任务变化（任务树高亮用）
};

// ── 汇总（随时可看阶段结果）──
type SwarmReport = {
  version: number; state: 'stage' | 'awaiting_review' | 'final' | 'partial' | 'unresolved';
  answer: string | null;          // 最强已核实结论；没有就 null
  verified: string[];             // 只放 status=verified 且核实绑定当前版本的 claim id
  limits: string[]; disputed: string[]; unverified: string[]; negative: string[];
  gaps: string[];                 // 精确剩余缺口
  sources: string[];              // evidence ids
  nextSuggestion?: { rounds: number; minutes: number; why: string } | null;   // 到限时的追加建议
  updatedAt: Iso;
};

// ── 用户干预 ──
type InterventionKind = 'mention' | 'redirect' | 'add_member' | 'stop_route' | 'pause' | 'resume' | 'finish' | 'extend';
type Intervention = {
  id: string; kind: InterventionKind; text?: string;
  target?: { memberId?: string; routeId?: string };
  state: 'received' | 'pending_approval' | 'delivered' | 'applied' | 'replied' | 'rejected' | 'failed';
  approvalId?: string;            // 需要审批时
  result?: string;                // 人话回执
  at: Iso;
};

// ── 快照（重连先取它）──
type SwarmSnapshot = {
  run: SwarmRun; plan: SwarmPlan | null;
  members: SwarmMember[]; tasks: SwarmTask[]; routes: SwarmRoute[];
  posts: BoardPost[]; claims: Claim[]; evidence: Evidence[]; reviews: Review[];
  interventions: Intervention[]; report: SwarmReport | null;
  pendingApprovals: string[];     // 本 run 待处理的收件箱卡 id
  cursor: number;                 // 快照对应的最后事件 seq
};
```

## 2. 接口

| 方法 | 路由 | 说明 | 阶段 |
|---|---|---|---|
| 发起 | `POST /v1/kernel/runs { dossierId, mode:'swarm', query }` | 起负责人会话进入 `clarifying`；同档案已有未结束 run 时返回它（不新开） | 1 |
| 澄清 | 沿用精读：对话发给同一 session；负责人提问走 `clarify_question` 提问卡 | 澄清对话在 AgentDock，不进通信面 | 1 |
| 列表 | `GET /v1/swarm/dossiers/:id/runs` | 本档案的群研运行，新的在前 | 1 |
| 快照 | `GET /v1/swarm/runs/:id` → `SwarmSnapshot` | 打开、刷新、重连都先取它 | 1 |
| 确认计划 | `POST /v1/swarm/runs/:id/plan/confirm { planVersion, limits? }` | 用户可改轮数/时长（不低于 4 轮 / 30 分钟）；版本不符 409 `PLAN_STALE` 并带最新计划 | 1 |
| 时间线 | `GET /v1/swarm/runs/:id/timeline?after=seq&limit=200` → `{ entries: BusEntry[], next: number \| null }` | 历史分页；回放只读这里，不触发模型 | 1（2 补黑板类） |
| 事件流 | `GET /v1/swarm/runs/:id/stream?after=seq`（SSE） | 见第 3 节；断线后带最后 seq 重连 | 1 |
| 队员记录 | `GET /v1/swarm/runs/:id/members/:memberId/log?after=seq` → `{ items: MemberLogItem[], next }` | 输入、工具调用与结果摘要、打开的来源、输出、内核公开的摘要；不含推理原文 | 1 |
| 对象详情 | `GET /v1/swarm/runs/:id/claims/:claimId?version=` / `evidence/:id` | 从结论追到证据、任务、队员 | 2 |
| 留言 | `POST /v1/swarm/runs/:id/posts { col:'question', text, to? }` | 用户在留言板发言；带 `@队员` 时同时生成一条 `mention` 干预 | 1 |
| 干预 | `POST /v1/swarm/runs/:id/interventions { kind, text?, target?, limits? }` → `Intervention` | 立即返回 `received`；后续状态走事件 | 1（stop/pause/finish）· 3（其余） |
| 汇总 | `GET /v1/swarm/runs/:id/report?version=` → `SwarmReport` | 运行中也能取阶段结果 | 2 |
| 精读关联 | `POST /v1/swarm/runs/:id/claims/:claimId/read { evidenceId }` → `{ readDossierId, href }` | 用同一材料版本和定位建/续精读 | 3 |
| 委托 | 第 6 节 | | 3 |

```ts
type MemberLogItem = {
  seq: number; at: Iso;
  kind: 'input' | 'tool' | 'source' | 'output' | 'message_in' | 'message_out' | 'summary';
  text: string;                               // 人话
  tool?: { name: string; state: 'running' | 'done' | 'failed'; args?: string; result?: string };  // 截断后的摘要
  evidenceId?: string; taskId?: string;
};
```

## 3. 事件（`/v1/swarm/runs/:id/stream`）

每条：`{ seq, at, runId, dossierId, type, data }`。`seq` 全局递增，前端按 seq 去重；收到 seq 不连续时重取快照。

| `type` | `data` | 前端动作 |
|---|---|---|
| `run` | `SwarmRun` | 顶栏、状态条、计时 |
| `plan` | `SwarmPlan` | 计划卡 / 改方向的差异卡 |
| `member` | `SwarmMember` | 名册、星座节点 |
| `task` | `SwarmTask` | 任务树（按 revision 取新） |
| `route` | `SwarmRoute` | 任务树路线行、阻塞标记 |
| `bus` | `BusEntry` | 通信：光点 + 消息流 |
| `post` | `BoardPost` | 留言板 |
| `claim` / `evidence` / `review` | 对应对象 | 留言板「发现」、汇总、结论详情 |
| `intervention` | `Intervention` | 干预回执（对话框和留言板同一条） |
| `report` | `SwarmReport` | 汇总面 |
| `approval` | `{ id, kind, state }` | 收件箱入口数字；页面上同一张卡的就地按钮 |
| `usage` | `SwarmRun['used']` | 用量（只显示，不拦截） |

心跳每 15 秒一条 `: ping`。账户不匹配的事件绝不下发（一个账户一个内核实例）。

## 4. 页面状态

### 4.1 运行状态 → 界面

| 状态 | 顶栏 / 状态条 | AgentDock | 可用干预 |
|---|---|---|---|
| clarifying | 「澄清中」 | 和负责人对话，提问卡就地回答 | 结束 |
| awaiting_confirm | 「等你确认计划」 | 计划卡：问题、边界、质量判据、路线、编制×模型、轮数/时长（可调高） | 确认 / 改 / 结束 |
| running | 轮次 n/N、阶段（独立/交叉）、活动时长、累计队员 x/16 | 负责人动态 | 全部 |
| waiting_user | 「等你回答」+ 跳转到那张卡；计时停 | 卡片就地 | 回答 / 暂停 / 结束 |
| paused | 「已暂停」；计时停 | | 继续 / 结束 |
| near_limit | 「快到额度」+ 新发现、剩余缺口、建议追加多少 | 追加卡 | 追加 / 收尾 |
| finishing | 「收尾中」 | | — |
| awaiting_review | 「报告前有分歧」+ 跳到分歧卡 | | 看分歧并决定 |
| done / partial / unresolved / cancelled / failed | 结束原因说人话；partial、unresolved 明说「部分完成 / 没有可靠答案」 | | 精读关联、交给其他台 |

### 4.2 四个面

- **任务树**：根问题 → 路线 → 任务；每行显示负责人、轮次、研究状态。`blockedBy` 显示「被 X 挡住：原因」；`sync_pending` 显示「交付已存、状态待同步」；`superseded` 灰掉并标「计划 v→v′ 改掉」；路线 `blocked` 显示缺口和「需要新机制才重开」。
- **通信**：星座节点改为真实成员（数量可变，最多 1+16），按 role 分区；光点由 `bus` 事件驱动；消息流按 seq 排；新增类型的图标：`verify ✓`、`message →`、`interrupt ‖`、`conflict ≠`、`user ●`、`system ·`。`delivery=failed` 红色显示。协议说明里的「广播」改为「发到黑板的决定，成员按需读」。时间轴：右端是「实时」，拖回去只读历史（标「回放中，后台照跑」），点「回到实时」恢复。
- **留言板**：四栏照旧；问题显示提问人→接收人和是否已答（配对 `replyTo`）；发现 = claim，带状态徽标（候选/待反驳/待核实/已核实/有争议/已证伪/证据不足）；点开展开证据定位、反驳与核实记录、来自哪个任务和队员。用户发言和 @ 走第 2 节。
- **汇总**：运行中显示「阶段结果」；正文只放已核实；局限、争议、未核实、负结果、剩余缺口各一区；每条可跳证据位置（有 `readHref` 时跳精读）。`MVP-1/2` 时正文区显示「核实未接通，以下全部是候选」，不出正式报告。

### 4.3 队员

名册（Explorer 左栏）按 role 分组：名字、模型、全新/继承、状态（创建中/运行中/空闲/被打断/失败）、`doing` 一行。点开右侧抽屉看 `MemberLogItem`，实时追加；被打断显示是谁打断、任务归属是否还在。

### 4.4 干预回执

对话框发的话默认给负责人（`mention` target=lead）；`@队员` 给指定队员。回执按 `Intervention.state` 显示：已接收 → 已投递 → 已回复/已执行；需审批时显示「等你在收件箱批准」并带跳转。**进收件箱不等于已执行**。改方向成功后在计划卡下显示差异和受影响任务（停止、保留证据、新任务）。

## 5. 收件箱新卡

全部走 `/v1/approvals`，`source` 带 `{ dossierId, runId, bench:'research' }`；页面和收件箱是同一张卡，谁处理都行，重复提交返回同一回执。

| `kind` | 何时 | 卡面要的字段（放 `effects[0]`） | 回答方式 |
|---|---|---|---|
| `question` | 研究中必须由人回答 | 沿用 `question: { multi, candidates }`，`taskIds`、`routeId` | 已有 `answer` |
| `swarm_add_member` | 中途加人 | `{ role, routeId, model, count, membersAfter, max:16 }` | 批准 / 驳回 |
| `swarm_extend` | 临近额度 | `{ findings: string[], gaps: string[], suggest: { rounds, minutes }, used }` | 批准（可改数值，`answers` 里给）/ 收尾 |
| `swarm_scope` | 改方向扩大原问题范围 | `{ from: planVersion, to: planVersion, changes: string[] }` | 批准 / 驳回 |
| `swarm_divergence` | 报告前仍有分歧 | `{ claims: { id, text, sides: string[] }[] }` | 选「按有争议写入」/「再查一轮」/ 自由回答 |
| `delegation_result` | 委托结果回到源档案（第 6 节） | 见下 | 采用 / 不采用 |

## 6. 跨台委托（MVP-3）

| 方法 | 路由 | 说明 |
|---|---|---|
| 发起 | `POST /v1/delegations { fromBench, fromDossierId, toBench:'research', mode:'swarm', question, background, materials: { ref, version }[], expected, constraints }` → `{ id, state:'awaiting_confirm', planPreview? }` | 源台「交给群研」按钮调用；按 Idempotency-Key 幂等 |
| 确认 | `POST /v1/delegations/:id/confirm` → `{ researchDossierId, runId }` | 建研究档案并开跑；澄清可和确认合成一次，但计划不确认不开跑 |
| 查看 | `GET /v1/delegations/:id` | 状态、结果版本 |
| 决定 | `POST /v1/delegations/:id/decide { resultVersion, decision:'adopt' \| 'dismiss' }` | 采用只是在源档案记一笔并挂引用，不覆盖源内容 |

```ts
type DelegationResult = {
  delegationId: string; version: number;            // 重复回调更新同一卡，版本递增
  researchDossierId: string; runId: string;
  outcome: 'done' | 'partial' | 'unresolved';
  claims: { id: string; text: string; status: ClaimStatus }[];
  evidence: { id: string; title: string; locator: string }[];
  artifacts: { id: string; version: string; title: string }[];
  limits: string[]; openQuestions: string[];
  href: string;                                     // 完整过程（群研页）
};
```
源档案显示一张结果卡（前端做卡面，放在源台的活动 / 收件箱里），「采用」「不采用」「看完整过程」。首个源台由 DSH 选最容易接的那个，前端跟着接。

## 7. 断线与恢复（前端行为）

1. 打开或重连：`GET /runs/:id` 拿快照与 `cursor` → 订阅 `stream?after=cursor`。
2. 事件 seq 跳号、或 SSE 断开超过 30 秒：重取快照，丢掉本地增量。
3. 浏览器断开只是不看，后台照跑、照计时；页面回来后状态条显示「断开期间新增 n 条」。
4. 进程重启后服务端恢复的 run：快照里 `stateReason` 写「已从中断恢复」；同一 submission 不重复出现（前端按 id 去重兜底）。
5. 时间轴回放只用 `timeline`，不发任何写请求。

## 8. 前端改动清单（Claude）

- `swarmTypes.ts`：`SwarmAdapter { load, subscribe, timeline, memberLog, send, post, intervene, confirmPlan, report }`，从 `packages/contracts` 引类型。
- `mockSwarm.ts`：把现有剧本改写成 `SwarmSnapshot` + 事件回放（CI 用、`?preview` 用）；`src/data/swarm-live.ts`：接第 2、3 节。
- `SwarmMode.tsx`：数据改走 adapter；名册、星座、任务树、留言板、汇总按第 4 节改；样式沿用 `swarm.css`，只补新状态的徽标。
- 收件箱：第 5 节新卡面；源台结果卡（先做首个源台）。

## 9. 按阶段，前端什么时候能验

| 阶段 | 后端交付后，Claude 在真实页面上看什么 |
|---|---|
| MVP-1 | 发起 → 澄清 → 计划卡确认 → 名册出现 1+3 名真实成员（模型、全新上下文）→ 任务树归属和依赖真实变化 → 通信面有真实消息 → 暂停 / 结束生效、计时正确 → 刷新后状态还在 |
| MVP-2 | 留言板出现真实候选结论，能追到任务、队员、原始证据；断线重连不丢不重；汇总标「全部是候选」 |
| MVP-3 | PRD 第 10 节首例全流程：改方向、@队员、加人审批、反驳与核实、分歧卡、到限追加、正式汇总、精读关联、一个源台的委托→结果卡→采用 |

## 10. 留给 DSH 的问题

- DSH `0.2.1-rc.4` 团队插件的成员会话事件能否按成员 session 拿到「发消息」工具调用和返回？拿不到时 `bus` 里 `delivery` 先标 `unknown`，告诉我。
- 负责人的「改方向」如果 DSH 中断后任务归属不释放，`SwarmTask.state` 用 `stopped` 还是保留 `doing` 直到负责人处理？按你实现的真实情况定，回执里写一句。
- 活动时长按服务端时钟累计，前端只显示 `used.activeMs`，不自己数秒。
