// 研究台「群研」前后端共用类型（design/prd/13-swarm-contract.md §1）。
// 只放类型，不放运行时代码；前后端都从这里引，服务端算好状态，前端不自己推断。
//
// 费用：按峰值费率估算。用量未知就是 { value: null, known: false }，绝不记成 0。

export type Iso = string;

/** 人民币估算。`known:false` 表示用量未知，`value` 必须为 null，不是 0。 */
export type Cny = { value: number | null; known: boolean };

export type Bench =
  | "curriculum"
  | "engineering"
  | "data"
  | "design"
  | "research"
  | "exploration"
  | "automation";

// ── 运行 ──────────────────────────────────────────
export type SwarmRunState =
  | "clarifying" // 负责人在和用户澄清
  | "awaiting_confirm" // 计划已出，等用户确认（不计时）
  | "running"
  | "waiting_user" // 全队等用户（计时暂停）；只有部分路线等用户时仍是 running
  | "paused" // 用户暂停（计时暂停）
  | "near_limit" // 临近额度，展示追加建议，仍在跑
  | "finishing" // 停止新增任务、收尾中
  | "awaiting_review" // 报告前有分歧，等用户看一眼
  | "done"
  | "partial"
  | "unresolved"
  | "cancelled"
  | "failed";

/** 前 2 轮 independent，第 3 轮起 cross（12-swarm.md §3）。 */
export type SwarmPhase = "independent" | "cross";

export type SwarmEndReason =
  | "answered"
  | "all_blocked"
  | "user_finished"
  | "limit"
  | "cancelled"
  | "error";

export type SwarmRun = {
  id: string;
  dossierId: string;
  question: string;
  state: SwarmRunState;
  phase: SwarmPhase;
  /** 当前轮，从 1 起；未开跑为 0。 */
  round: number;
  planVersion: number;
  /** 用户确认的额度（最少 4 轮 / 30 分钟）。 */
  limits: { rounds: number; minutes: number };
  used: {
    rounds: number;
    activeMs: number;
    cost: Cny;
    tokens: number | null;
  };
  /** 累计创建（失败也占名额）。 */
  members: { used: number; max: 16 };
  /** 人话：为什么在这个状态（如「等你回答 Q-3」「到达 30 分钟」）。 */
  stateReason?: string;
  endReason?: SwarmEndReason;
  delegation?: { id: string; fromBench: Bench; fromDossierId: string } | null;
  startedAt: Iso | null;
  endedAt: Iso | null;
};

// ── 计划（开跑前确认 / 改方向时出新版本）────────────
export type SwarmRoutePlan = {
  id: string;
  title: string;
  idea: string;
  differsBy: string;
};

export type SwarmRosterEntry = {
  role: MemberRole;
  count: number;
  model: string;
  routeIds?: string[];
};

export type SwarmPlan = {
  version: number;
  question: string;
  /** 边界：包含什么、不包含什么。 */
  scope: string;
  /** 怎么判断答得好。 */
  qualityCriteria: string[];
  /** 不同路线；同义改写不能登记成新路线。 */
  routes: SwarmRoutePlan[];
  roster: SwarmRosterEntry[];
  limits: { rounds: number; minutes: number };
  /** 改方向时：只给新旧差异。 */
  diffFrom?: { version: number; changes: string[] };
  /** 首版、或扩大原问题范围时为 true。 */
  needsConfirm: boolean;
};

// ── 队员（DSH 团队成员投影）────────────────────────
export type MemberRole = "lead" | "researcher" | "critic" | "verifier";

export type SwarmMember = {
  /** DSH 成员名，不复用；负责人固定 'lead'。 */
  id: string;
  role: MemberRole;
  /** 显示名，如「研究员 02」。 */
  label: string;
  /** 逻辑小组 / 路线标签。 */
  tags: string[];
  model: string;
  context: "fresh" | "inherited";
  state: "creating" | "running" | "idle" | "interrupted" | "failed";
  /** 正在做什么（人话一行）。 */
  doing?: { taskId: string; summary: string } | null;
  sessionId: string;
  failReason?: string;
};

// ── 任务（DSH 任务板是唯一真源；研究含义另挂）──────
export type SwarmTaskState =
  | "open"
  | "doing"
  | "delivered"
  | "sync_pending" // 交付已存、任务状态待同步
  | "blocked"
  | "waiting_user"
  | "stopped"
  | "failed"
  | "superseded";

export type SwarmTask = {
  id: string;
  /** DSH task 版本。 */
  revision: number;
  /** 树形：根问题 → 路线 → 任务。 */
  parentId: string | null;
  kind: "root" | "route" | "research" | "review" | "verify" | "synthesis" | "other";
  title: string;
  routeId: string | null;
  round: number;
  planVersion: number;
  contractVersion: number | null;
  /** 成员 id。 */
  owner: string | null;
  /** DSH 原生状态，原样。 */
  board: "pending" | "in_progress" | "completed";
  /** 服务端合成的研究状态（界面用这个）。 */
  state: SwarmTaskState;
  dependsOn: string[];
  /** 被挡住及原因。 */
  blockedBy?: { taskIds: string[]; reason: string } | null;
  /** submission_id */
  submissions: string[];
  updatedAt: Iso;
};

// ── 路线 ──────────────────────────────────────────
export type SwarmRouteState = "active" | "blocked" | "stopped" | "reopened" | "merged";

export type SwarmRoute = {
  id: string;
  title: string;
  idea: string;
  approachFamily: string;
  tags: string[];
  state: SwarmRouteState;
  /** 当前缺口。 */
  gap?: string;
  blockedReason?: string;
  reopenReason?: string;
  taskIds: string[];
  memberIds: string[];
};

// ── 黑板对象（MVP-2 起才有内容；MVP-1 返回空数组）──
export type ClaimStatus =
  | "candidate"
  | "awaiting_refute"
  | "awaiting_verify"
  | "verified"
  | "disputed"
  | "falsified"
  | "insufficient";

export type Claim = {
  id: string;
  version: number;
  text: string;
  conditions: string[];
  basis: "checked_fact" | "source_claim" | "inference" | "observation";
  status: ClaimStatus;
  statusReason?: string;
  evidenceIds: string[];
  author: string;
  taskId: string;
  routeId: string | null;
  submissionId: string;
  round: number;
  reviews: string[];
  /** ≤ 2 */
  refuteRounds: number;
  /** 独立阶段不对其他路线开放。 */
  visibility: "lead_reviewers" | "route" | "all";
  /** 负结果 */
  negative?: { searched: string; scope: string; notFound: string } | null;
};

/** 证据是怎么找到的：搜出来的 / 早就知道的网址 / 顺着别的资料里的引用找过去的。 */
export type EvidenceDiscovery = "search" | "known-url" | "citation";

export type Evidence = {
  id: string;
  source: {
    kind: "paper" | "web" | "code" | "data" | "proof" | "other";
    title: string;
    /** DOI / URL / 资产 ID */
    ref: string;
    assetId?: string;
    version?: string;
  };
  locator: { page?: number; section?: string; lines?: string; quote?: string } | null;
  access: "full_text" | "abstract_only" | "unavailable";
  /** 来路（18 广度返工）；老数据没有这个字段就缺省。 */
  discovery?: EvidenceDiscovery;
  /** 怎么拿到的（检索 / 下载 / 实测）。 */
  how: string;
  /** 能跳精读的页码锚点（/v1/... 由前端补前缀）。 */
  readHref?: string;
};

export type Review = {
  id: string;
  claimId: string;
  claimVersion: number;
  kind: "refute" | "need_evidence" | "verify" | "downgrade";
  by: string;
  reason: string;
  evidenceIds: string[];
  verdict: "upheld" | "rejected" | "verified" | "not_verifiable" | "pending";
  round: number;
  taskId: string;
  /** 核实者自报读没读全原文（17 返工）。否定式结论判 verified 必须是 full。旧记录没有。 */
  readCompleteness?: "full" | "partial" | null;
};

// ── 留言板四栏 ────────────────────────────────────
export type BoardPost = {
  id: string;
  col: "question" | "finding" | "help" | "decision";
  by: string | "user";
  text: string;
  at: Iso;
  seq: number;
  /** 提问指定接收者；null = 公开。 */
  to?: string | null;
  /** 回答配对。 */
  replyTo?: string;
  answered?: boolean;
  refs: {
    claimId?: string;
    taskId?: string;
    routeId?: string;
    approvalId?: string;
  };
  /** 决定的适用范围。 */
  scope?: { planVersion: number };
};

// ── 通信时间线（服务端拼）──────────────────────────
export type BusType =
  | "broadcast"
  | "claim"
  | "ask"
  | "deliver"
  | "help"
  | "handoff"
  | "refute" // 现有 7 种
  | "verify"
  | "message"
  | "interrupt"
  | "conflict"
  | "user"
  | "system"; // 新增

export type BusEntry = {
  /** 全局事件序号：排序和因果只看它，不看时间戳。 */
  seq: number;
  at: Iso;
  type: BusType;
  from: string | "user" | "system";
  to: string | "board" | "all" | null;
  /** 人话一行。 */
  text: string;
  /** 发送结果（message_id 只代表接收成功）。 */
  delivery?: "sent" | "received" | "failed" | "unknown";
  refs: {
    taskId?: string;
    claimId?: string;
    postId?: string;
    questionId?: string;
    reviewId?: string;
    interventionId?: string;
    sessionSeq?: { sessionId: string; seq: number };
  };
  /** 这条导致的任务变化（任务树高亮用）。 */
  taskUpdates?: { id: string; state: SwarmTaskState }[];
};

// ── 汇总（MVP-2 起；MVP-1 为 null）─────────────────
export type SwarmReport = {
  version: number;
  state: "stage" | "awaiting_review" | "final" | "partial" | "unresolved";
  /** 最强已核实结论；没有就 null。 */
  answer: string | null;
  /** 只放 status=verified 且核实绑定当前版本的 claim id。 */
  verified: string[];
  limits: string[];
  disputed: string[];
  unverified: string[];
  negative: string[];
  /** 精确剩余缺口。 */
  gaps: string[];
  sources: string[];
  /**
   * 按来路统计的证据数（18 广度返工）：search 搜出来的、knownUrl 直接抓已知网址、
   * citation 顺着引用找的、unknown 没判出来源。页面显示「发现类 search / 共 M」。
   */
  discoveryCounts?: {
    search: number;
    knownUrl: number;
    citation: number;
    unknown: number;
  } | null;
  /** 覆盖情况（D2）：报告里也带一份，正式报告本身能看出广度。 */
  coverage?: SwarmCoverage | null;
  /** 到限时的追加建议。 */
  nextSuggestion?: { rounds: number; minutes: number; why: string } | null;
  /**
   * 成稿（17 返工）：负责人写的一份贯穿全局的报告（markdown）。
   * 引用只能指黑板上的结论/证据 id；没核实的要在文中标出来。还没写就是 null。
   */
  narrative?: string | null;
  updatedAt: Iso;
};

// ── 用户干预 ──────────────────────────────────────
export type InterventionKind =
  | "mention"
  | "redirect"
  | "add_member"
  | "stop_route"
  | "pause"
  | "resume"
  | "finish"
  | "extend";

export type Intervention = {
  id: string;
  kind: InterventionKind;
  text?: string;
  target?: { memberId?: string; routeId?: string };
  state:
    | "received"
    | "pending_approval"
    | "delivered"
    | "applied"
    | "replied"
    | "rejected"
    | "failed";
  /** 需要审批时。 */
  approvalId?: string;
  /** 人话回执。 */
  result?: string;
  at: Iso;
};

/** 覆盖情况（18 广度返工 D2）：不看工具也能看到的「谁已查证、谁提到没查」。 */
export type SwarmCoverage = {
  checkedTotal: number;
  mentionedTotal: number;
  axes: Array<{
    routeId: string;
    title: string;
    checked: string[];
    mentioned: string[];
  }>;
  /** 一句话说明（可以整句显示在页面上）。 */
  note: string;
};

// ── 快照（重连先取它）──────────────────────────────
export type SwarmSnapshot = {
  run: SwarmRun;
  plan: SwarmPlan | null;
  members: SwarmMember[];
  tasks: SwarmTask[];
  routes: SwarmRoute[];
  posts: BoardPost[];
  claims: Claim[];
  evidence: Evidence[];
  reviews: Review[];
  interventions: Intervention[];
  report: SwarmReport | null;
  /** 覆盖情况：每次快照现算，不用负责人调工具（D2）。 */
  coverage?: SwarmCoverage | null;
  /** 本 run 待处理的收件箱卡 id。 */
  pendingApprovals: string[];
  /** 快照对应的最后事件 seq。 */
  cursor: number;
};

/** 队员工作记录的一条（`GET /v1/swarm/runs/:id/members/:memberId/log`）。 */
export type MemberLogItem = {
  seq: number;
  at: Iso;
  kind: "input" | "tool" | "source" | "output" | "message_in" | "message_out" | "summary";
  /** 人话。 */
  text: string;
  /** 截断后的摘要。 */
  tool?: {
    name: string;
    state: "running" | "done" | "failed";
    args?: string;
    result?: string;
  };
  evidenceId?: string;
  taskId?: string;
};

/** 事件流一帧（`GET /v1/swarm/runs/:id/stream`）。 */
export type SwarmEventType =
  | "run"
  | "plan"
  | "member"
  | "task"
  | "route"
  | "bus"
  | "post"
  | "claim"
  | "evidence"
  | "review"
  | "intervention"
  | "report"
  | "approval"
  | "usage"
  | "member_log";

export type SwarmEvent = {
  seq: number;
  at: Iso;
  runId: string;
  dossierId: string;
  type: SwarmEventType;
  data: unknown;
};
