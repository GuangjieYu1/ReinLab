# 前端数据契约：七台通用档案（地基第 4 项）

- 作者：Claude（前端 + 验收）；实施：DSH（服务端与侧边 Agent 工具）
- 依据：[02-foundation.md](02-foundation.md) 第 4 项（4.1～4.8，D1～D7），[WORKFLOW.md](../WORKFLOW.md)
- 日期：2026-10-30

**原则：** 只有一份数据（现有 `dossier` 表加字段，加上现有 `event`、`approval`、`run`）；页面和侧边 Agent 调同一组业务动作；操作记录由服务端在业务动作里写，前端**不另发日志**；不教模型做事。

---

## 1. 数据形状（TypeScript，前后端共用，放在 `packages/contracts/src/dossier.ts`）

```ts
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
```

## 2. 接口（REST，沿用现有 `/v1` 和鉴权）

所有写请求都带 `Idempotency-Key`。所有错误统一返回 `{ code, message }`，`message` 是给人看的话（见第 5 节）。

| 用途 | 请求 | 响应 / 说明 |
|---|---|---|
| **列表 / 搜索** | `GET /v1/dossiers?bench=research&q=BERT&view=active\|archived&cursor=` | `{ items: DossierSummary[], nextCursor }`。默认 `view=active`（不含归档和已删除），按 `lastActivityAt` 倒序。**由用户主动发起时加 `via=user`**（打开 Files、点搜索）：服务端顺带记一条轻量的 `search` 操作；后台刷新不带，不记。 |
| **详情** | `GET /v1/dossiers/:id` | `Dossier`。已删除：**410** `{ code:'DOSSIER_DELETED', tombstone: Tombstone }`，不带任何内容 |
| **打开** | `POST /v1/dossiers/:id/open` `{ via:'page'\|'agent' }` | `Dossier`。记录 `open` 操作，更新该台「上次打开」。**不启动模型、不重跑任务** |
| **续上次** | `GET /v1/benches/:bench/resume` | `{ dossier: Dossier \| null }`。上次打开的、未删除、未归档的档案；没有就 `null`，前端显示列表或空状态，不自动建档 |
| **记位置** | `PUT /v1/dossiers/:id/resume` `ResumePoint` | `204`。前端切工作面、翻到某层、某页时调用，防抖 2 秒。不算活动、不写操作记录 |
| **新建** | `POST /v1/dossiers` `{ bench, kind?, title?, intent? }` | `201 Dossier`。有 `title` 时 `nameSource='user'`；只有 `intent` 时由服务端给临时标题（`未命名研究 · 10月30日`），之后 Agent 或选论文时再补名。**不自动开始任务** |
| **修改** | `PATCH /v1/dossiers/:id` `{ baseVersion, title?, intent?, lifecycle?: 'active'\|'completed' }` | `Dossier`。改 `title` 即 `nameSource='user'`。版本不符：**409** `VERSION_CONFLICT`（带最新 `Dossier`） |
| **归档 / 取消归档** | `POST /v1/dossiers/:id/archive` / `POST /v1/dossiers/:id/unarchive` | 没有活跃工作：直接生效，返回 `Dossier`。**有活跃工作**（running / waiting）：返回 **202** `{ confirmation: Confirmation }`，等用户确认（见第 3 节） |
| **删除** | `POST /v1/dossiers/:id/delete` | 一律返回 **202** `{ confirmation: Confirmation }`，**一次明确确认后**才生效 |
| **成果列表** | `GET /v1/dossiers/:id/artifacts?kind=` | `{ items: Artifact[] }` |
| **已有课程（选择用）** | `GET /v1/courses?q=` | `{ items: { courseId, title, source:'local-openmaic'\|'native', sceneCount, progress: number \| null }[] }`：复用现有课程库，不重新生成 |
| **加入课程** | `POST /v1/dossiers/:id/artifacts` `{ kind:'course', courseId }` | `201 Artifact`。用户在页面点「加入」就算授权，不再另弹审批；同一课程重复加入时返回已有的那条关联 |
| **移除关联** | `DELETE /v1/dossiers/:id/artifacts/:artifactId` | `204`。只解除关联，**不删课程原件、不删文件**；之后旧引用返回 `Tombstone{state:'removed'}` |
| **活动提示** | `GET /v1/dossiers/:id/activity?after=` | `{ items: ActivityNote[], cursor }`（页面用来在 Agent 坞里显示一行提示） |
| **变化通知** | `GET /v1/stream?bench=` （SSE） | 事件见第 4 节 |

已有的 `/v1/kernel/*`、`/v1/approvals/*`、`/v1/reports`、精读的 `read-live` 都保留，档案 id 继续是同一个。

## 3. 确认动作（删除、归档活跃档案）：一张卡，页面和 Agent 共用

复用现有 `approval` 表和 `/v1/approvals/:id/decide`，不另做一套。

```ts
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
```

- 页面点删除，或 Agent 调删除工具，**都**走 `POST /v1/dossiers/:id/delete`；同一份档案同时只能有一张待确认卡（重复请求返回同一张）。
- 卡片在页面弹窗、收件箱、Agent 坞里都显示同一个 `id`，在任何一处决定，其他地方同步（第 4 节的 `confirmation.decided`）。
- 批准后：`deletion: 'stopping'`（复用第 2 项的取消流程，停掉运行、关掉待处理请求）→ 真正停下后 `deletion: 'deleted'`。拒绝：什么都不变。
- 归档活跃档案同理；没有活跃工作的归档、取消归档、改名、标完成、新建：**用户直接操作就算授权**，不再弹卡。
- Agent **自己提议**新建或修改（用户没明确要求）时，应该先在对话里问用户；这一点由模型自己判断，提示词只写底线，不写步骤。

## 4. 变化通知与刷新

`GET /v1/stream?bench=research` 是 SSE，事件如下（只发给本账户，只带 id 和最小字段，前端收到后再去拉详情）：

```ts
type StreamEvent =
  | { type: 'dossier.changed'; id: string; version: number; change: ActivityNote['action'] | 'work' | 'artifacts' }
  | { type: 'dossier.deleted'; id: string; tombstone: Tombstone }
  | { type: 'confirmation.created' | 'confirmation.decided'; confirmation: Confirmation }
  | { type: 'activity'; note: ActivityNote };
```

- **页面**：收到 `dossier.changed` 就重新拉列表或详情（按 `version` 去重）；`dossier.deleted` 时，如果正打开着这份档案，就切到「这份档案已删除」的提示和列表。SSE 断了自动重连；断线期间每 15 秒刷新一次列表（这种刷新不带 `via=user`）。
- **侧边 Agent 改了档案以后**：服务端照常发 `dossier.changed`，页面自动刷新，Agent 工具不需要通知前端。
- **页面改了档案以后**：同样的事件，加上一条 `activity`，Agent 坞里显示一行灰色小字「· 你把档案改名为《BERT 阅读笔记》」。**不是聊天气泡，不显示「你说」**。

## 5. 错误语义

| code | HTTP | 页面怎么显示 |
|---|---|---|
| `DOSSIER_NOT_FOUND` | 404 | 「找不到这份档案」，回列表 |
| `DOSSIER_DELETED` | 410 | 「这份档案已删除（10月30日）」，带 `tombstone.title`，不显示内容 |
| `ARTIFACT_REMOVED` | 410 | 「这项成果已从档案移除」 |
| `VERSION_CONFLICT` | 409 | 「别处刚改过这份档案」，用响应里的最新版本刷新，让用户再改一次 |
| `CONFIRMATION_PENDING` | 409 | 「已有一张删除确认在等你」，指向那张卡 |
| `DOSSIER_STOPPING` | 409 | 「正在停止这份档案的工作」，禁用操作 |
| `INVALID_INPUT` | 400 | 表单字段旁显示原因 |
| `FORBIDDEN` | 403 | 「没有权限」 |
| `COURSE_UNAVAILABLE` | 409 | 「课程文件不可访问」，照实说，不填示例 |

## 6. 命名规则（服务端执行）

| 场景 | 规则 |
|---|---|
| 新建时给了 `title` 或用户改名 | `nameSource='user'`，此后自动命名一律不覆盖 |
| 只给了 `intent` | 临时标题；Agent 可以用档案工具改名（`nameSource='intent'`），不为了列表专门调模型 |
| `kind='reading'` 选定论文 | 如果 `nameSource` 是 `placeholder` 或 `intent`，就换成论文标题（`'paper'`） |
| `kind='topic'` 里再读论文 | 不改档案标题；这次阅读的 run 标题用论文名 |
| 已有的「新的精读」 | 一次性迁移：有已选论文就补成论文名；没有就保持原样 |

## 7. 侧边 Agent 的档案工具（DSH 实现，和页面调同一组服务函数）

`dossier_list`、`dossier_get`、`dossier_create`、`dossier_update`、`dossier_archive`、`dossier_unarchive`、`dossier_delete`（返回 `Confirmation`，不直接删）、`dossier_attach_course`、`dossier_detach`。

- 结果里带 `open: OpenTarget`，Agent 坞据此渲染可点击的档案卡。
- 查询结果有多个匹配时，原样返回候选，由模型自己决定怎么问用户。
- Agent **不能用 shell 绕过**：档案目录对容器只读，增删改只能走这些工具。
- 七台还没有专业 Agent 时，侧边坞接一个只带档案工具的最小会话（数据台的分析仍然归 Data Formulator）。

## 8. 操作记录与 Agent 上下文（DSH 实现；前端只负责显示）

- 每个业务动作在**同一个事务**里写一条 `event`：`kind='user_op'`，`action`，`actor`（user / agent），`via`（page / agent），`target`（稳定 id），`before` / `after`（只放标题、意图、状态这类短字段，不放正文），`version`，`ok`。失败或拒绝写 `ok=false`，不写成功。
- `open` / `search` 只记一条轻量操作（时间 + 对象 / 查询词），后台刷新不记。
- **上下文投递**：受影响的会话下一次模型调用（包括等待后续接、重启后恢复）之前，服务端按游标把这份档案的新操作转成简短事实，放进系统侧上下文，例如「用户将《新的精读》改名为《BERT 阅读笔记》」「用户移除了材料《论文草稿.pdf》，该材料已不可读取」。**不以用户消息的身份出现，不附加「请调用某工具」，不为了投递单独唤醒模型。**
- 删除档案后，它的会话不再恢复；只向原来引用过它的会话提供一条最小的删除事实。
- 工具读到旧引用时，返回 `Tombstone`，不返回空结果，也不返回正文。

## 9. 前端（Claude 负责）

- **数据适配**：新增 `DossierAdapter`（mock + live），接口与上面一一对应；Files、续上次、成果、确认弹窗都只通过它取数。
- **地址**：工作台从 `?file=0..3` 改成 `?dossier=<id>&face=&anchor=`。旧链接没有 `dossier` 时走续上次。
- **入口 Files**（`EntryComparison` / `FilePreview`）：显示真实列表，带「新建」「搜索」「查看归档」，空状态下有新建入口。
- **档案详情和操作**：工作台头部的档案下拉改成真实列表；增加改名、编辑意图、标完成、归档、删除（弹出确认卡）。
- **成果面板**：在资源管理器里列出成果；课程类成果显示「打开课程」，进入现有原生课程播放器，进度沿用 `courseProgress`；学习台有「加入已有课程」。
- **Agent 坞**：新增 `note` 类事件，显示操作提示（灰色一行）；档案工具结果渲染成可点击的档案卡。
- 没有专业 Agent 的台，Files 是真的，但工作区里的示例内容保留「演示数据」标记（`backendMode.ts`），不当成档案的成果。

## 10. 双方责任

| 事项 | DSH | Claude |
|---|---|---|
| `dossier` 表加字段（`kind`、`intent`、`name_source`、`lifecycle`、`deletion`、`deleted_at`、`version`、`last_activity_at`、`progress`）、`dossier_resume`、`dossier_artifact` 关联、一次性补名迁移 | ✓ | |
| 第 2 节接口、第 3 节确认（复用 approval 与第 2 项取消）、第 4 节 SSE、第 5 节错误码 | ✓ | |
| 第 7 节 Agent 档案工具、第 8 节操作记录与上下文投递 | ✓ | |
| 契约类型放到 `packages/contracts/src/dossier.ts` | ✓（按本文原样） | 审 |
| 第 9 节全部页面与适配器（mock 先行） | | ✓ |
| 真实页面验收 D1～D7 | | ✓ |

## 11. 验收映射（D1～D7）

| 验收 | 用到的契约 |
|---|---|
| D1 七台新建，关闭再开 | `POST /v1/dossiers`、列表、`GET /:id`、`resume`；没有专业 Agent 的台保留演示标记 |
| D2 模糊意图 → 选论文 → 手动改名；课题里再读 | 第 6 节命名；`PATCH title` → `nameSource='user'` |
| D3 搜索、打开、改目标 / 标题、归档 / 取消归档、续上次 | 列表 `q` + `via=user`、`open`、`PATCH`、`archive` / `unarchive`、`/benches/:bench/resume`；打开不发起 run |
| D4 Agent 新建 / 查询 / 改名 / 删除；页面删另一个 | 第 7 节工具与页面调同一组接口；`delete` → 一张 `Confirmation`；拒绝不删；确认后 410 |
| D5 已有课程加入学习档案 → 打开 → 关掉再开 | `GET /v1/courses`、`POST artifacts {kind:'course'}`、`OpenTarget{to:'course'}`、`courseProgress` |
| D6 打开有运行 / 待处理 / 成果的档案 | `work`、`pending`、`artifacts`；档案的 `lifecycle` 不被 run 终态改写 |
| D7 Agent 先了解档案，用户在页面改名 / 删除 / 移除，然后继续对话 | 第 8 节操作记录 + 下次调用前投递；`Tombstone`；Agent 坞只显示 `note`，没有伪造的用户气泡 |

---

## 12. 前端已实现（Claude，分支 `claude/dossier-fe`）· DSH 接线须知

- **类型**：`packages/contracts/src/dossier.ts` 已经按第 1 节建好（纯 TS 类型）。DSH 可以在旁边补 zod 校验，字段名不要改。
- **live 适配器**：`src/data/dossier-live.ts` 已经按第 2～4 节写好路由和请求形状（统一用 `research-live.ts` 新增的 `request(method, path, body)`，错误按 `{ code, message }` 解析）。DSH 实现服务端时，以这个文件里的路径和请求体为准；有出入请提出来。
- **精读按档案打开**：`ResearchStudioData` 现在调用 `createLiveReadAdapter(dossier.id)`，只读打开的这份档案，不再自己挑「最近一份」。请顺带修改 `read-live.ts`：
  - `newReading()` 改为调用 `POST /v1/dossiers { bench:'research', kind:'reading' }`（**不要写死标题「新的精读」**，由服务端给临时标题），然后切换到这份新档案。现在界面上的「＋ 新建精读」走的就是它。
  - 把这份档案的操作记录（第 8 节，`kind='user_op'`）映射成 `ReadEvent { type:'note', id, text }`。界面会把它显示成一行灰字，**不是用户气泡**。
- **续上次**：`ReadMode` 切换工作面 2 秒后调用 `PUT /v1/dossiers/:id/resume { face, mode:'read' }`；重新打开时，从 `Dossier.resume.face` 恢复。
- **入口 Files**：每个台显示最近 4 份真实档案；不足 4 份的槽位显示「＋ 新建档案」，点「继续工作」进入工作台，再由 `?new=1` 新建。
- **工作台**：地址里带 `?dossier=<id>`；没有就走续上次；live 下仍然没有，就显示空状态，不自动建档。没接专业能力的台（`backendMode.ts` 里的 `LIVE_BENCHES` 以外）显示档案本身，不显示示例内容。
- **课程**：`OpenTarget{to:'course'}` 在原生课程播放器里打开，OpenMAIC 地址取本机设置（`reinlab-openmaic-origin-v1`）、`VITE_OPENMAIC_ORIGIN`，或默认的 `http://127.0.0.1:3000`；`GET /v1/courses` 由服务端从本地 OpenMAIC 读取。
