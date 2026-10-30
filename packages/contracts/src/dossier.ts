// 七台通用档案的前后端共用类型。权威说明：design/prd/03-dossier-contract.md（改这里要同步改文档）。
// DSH 可以在旁边补 zod 校验，但字段以这里为准。

export type BenchId = 'curriculum' | 'research' | 'engineering' | 'creative' | 'automation' | 'data' | 'exploration';

/** 档案生命周期。删除不在这里，用 deletion 单独表示。 */
export type Lifecycle = 'active' | 'completed' | 'archived';
/** 删除标记：none 正常；stopping 已确认删除、正在停止活跃工作；deleted 已删除（逻辑删除）。 */
export type Deletion = 'none' | 'stopping' | 'deleted';
/** 标题来源。user 一旦出现，自动命名永不覆盖。 */
export type NameSource = 'user' | 'paper' | 'intent' | 'placeholder';
/** 研究台区分：reading = 从一篇论文开始的独立精读；topic = 课题（可含多次精读）。其他台固定 'workspace'。 */
export type DossierKind = 'reading' | 'topic' | 'workspace' | 'learning';

/** 档案里正在发生的工作（来自 run，只读），不改变 Lifecycle。 */
export type WorkState =
  | { state: 'idle' }
  | { state: 'running'; runId: string; step?: string }
  | { state: 'waiting'; runId: string; requestId: string; question: string }   // 等审批或回答
  | { state: 'failed'; runId: string; reason: string };

export type ResumePoint = {
  face: string;            // 工作面 id，比如 research 的 'explain' | 'lab' | 'repro' | 'check'
  anchor?: string;         // 内容位置，比如讲解层 id、页码锚点 'paper:<asset>#page=5'、课程场景 id
  mode?: string;           // 台内模式，比如 research 的 'read' | 'swarm' | 'auto'
};

export type DossierSummary = {
  id: string; bench: BenchId; kind: DossierKind;
  title: string; nameSource: NameSource;
  intent: string | null;                 // 任务意图 / 简介
  lifecycle: Lifecycle; deletion: Deletion;
  createdAt: string; updatedAt: string;
  lastActivityAt: string;                // 最近有意义活动（排序用；轮询、打开不算）
  progress: string | null;               // 一句话进展，来自真实任务和成果（如「已读 7 层讲解、2 张发现卡」），没有就 null
  work: WorkState;
  pending: number;                       // 待你处理的请求数
  artifacts: { total: number; byKind: Partial<Record<ArtifactKind, number>> };
  version: number;                       // 乐观并发版本，每次生效的修改 +1
};

export type Dossier = DossierSummary & {
  resume: ResumePoint | null;            // 这个账户在这份档案上次的位置
  runs: { id: string; role: string; state: string; startedAt: string; endedAt: string | null; title: string }[]; // 最近 20 条
};

export type ArtifactKind = 'paper' | 'layer' | 'finding' | 'quiz' | 'course_plan' | 'course' | 'file';
/** 论文出处：来源地址和 DOI 都可能没有，照实留 null，不编造。 */
export type Provenance = { source: string | null; doi: string | null };
export type Artifact = {
  id: string; dossierId: string; kind: ArtifactKind;
  title: string; runId: string | null;   // 导入的可以没有来源任务
  version: number; createdAt: string;
  status: 'available' | 'missing';       // 文件/课程不可访问时 missing，照实说，不填示例
  open: OpenTarget;
  provenance?: Provenance;               // 只有 paper 带：阅读区显示出处用
};

/** 打开入口：前端据此路由，不拼 URL。 */
export type OpenTarget =
  | { to: 'dossier'; dossierId: string; resume?: ResumePoint }            // 打开档案某个位置（讲解层、页码）
  | { to: 'course'; courseId: string }                                    // 原生课程播放器，进度沿用 courseProgress
  | { to: 'file'; path: string }                                          // 工作区文件预览
  | { to: 'none'; reason: string };                                       // 打不开时的原因

/** 已删除 / 已移除的旧引用：明确状态，不带正文。 */
export type Tombstone = { id: string; kind: 'dossier' | ArtifactKind; state: 'deleted' | 'removed'; title: string; at: string };

/** 操作提示（页面和 Agent 坞都能显示的一行「谁做了什么」）。不是聊天消息。 */
export type ActivityNote = {
  id: string; at: string; dossierId: string;
  actor: 'user' | 'agent' | 'system'; via: 'page' | 'agent';
  action: 'create' | 'rename' | 'edit_intent' | 'complete' | 'archive' | 'unarchive' | 'delete' | 'attach' | 'detach' | 'open' | 'search';
  text: string;                          // 人话，如「你把《新的精读》改名为《BERT 阅读笔记》」
};

export type Confirmation = {
  id: string;                         // = approval id
  kind: 'dossier.delete' | 'dossier.archive';
  target: { id: string; title: string; bench: BenchId };
  impact: {                           // 用人话展示
    activeRuns: number;               // 会被停止的运行
    pendingRequests: number;          // 会被关闭的待处理请求
    artifacts: number;                // 不再能从档案访问的成果数（课程原件、文件不删）
    note: string;                     // 「删除后列表、搜索和续上次都看不到这份档案；原始文件和外部课程不会被删除。不是永久擦除。」
  };
  state: 'pending' | 'approved' | 'rejected' | 'expired';
};

export type StreamEvent =
  | { type: 'dossier.changed'; id: string; version: number; change: ActivityNote['action'] | 'work' | 'artifacts' }
  | { type: 'dossier.deleted'; id: string; tombstone: Tombstone }
  | { type: 'confirmation.created' | 'confirmation.decided'; confirmation: Confirmation }
  | { type: 'activity'; note: ActivityNote };
