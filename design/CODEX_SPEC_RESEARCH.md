# 实现规格 · 研究台（给 Codex）

版本 1.0 · 2026-10-19 · 依据 [PRD_RESEARCH_BENCH.md](PRD_RESEARCH_BENCH.md)
验收方：Claude，按 [ACCEPTANCE_RESEARCH.md](ACCEPTANCE_RESEARCH.md) 执行最终验收

> 这份文档是**实现合同**。PRD 说「做什么」，这里说「怎么做、做到什么程度、交什么证据」。遇到这里没写到、或者和现实对不上的地方：
> - **不要猜**，在 `docs/questions.md` 里记一条，写明你的推荐做法和理由，然后按推荐做法继续。
> - 标为 **SPIKE** 的事项必须先验证并写结论，再做依赖它的任务。

---

## 0. 工作规则

1. **不修改 OpenScience 源码。** 它是上游依赖（`@synsci/openscience`、`@synsci/sdk`、`@synsci/plugin`，版本锁定 `2.0.150`）。所有扩展只走 SDK、agent 定义、插件、MCP。如果确实需要改上游，写进 `docs/questions.md`，由用户决定。
2. **版本锁定。** OpenScience 运行时、SDK、插件包三者版本必须一致。升级是单独的任务，必须带契约测试。
3. **前端保持现状。** `src/components/workbenches/research/**` 的界面、交互与莱茵风格不改。只把数据源从示例数据换成后端，并保留示例模式（见第 11 节）。
4. **我们自己的界面不使用 WebGL。** OpenMAIC 组件在沙盒 iframe 里运行，不受此限。
5. **界面文字一律中文**，术语与前端保持一致。错误信息对用户要可读，并带错误码。
6. **每个任务都要有测试**（第 12 节），并在 `evidence/` 下留证据（第 14 节）。没有证据的任务在验收时视为未完成。
7. **Git：** 一个任务一个分支、一个 PR，标题以任务编号开头（如 `P1-07 控制面账本`）。不要直接推 `main`。
8. **不得为了让测试通过而降低校验**：不得关闭 RLS、放宽 iframe 沙盒、跳过引用核对、或把真实调用换成假数据。验收会专门检查这几条。

---

## 1. 仓库结构

在现有 ReinLab 仓库（Vite + React 前端在根目录）内新增工作区。使用 **pnpm workspaces**；后端运行在 **Node 22**。插件运行在 OpenScience（Bun）进程内，所以必须兼容 Bun。

```
/                         现有前端（不移动）
packages/
  contracts/              共享类型与 zod schema（前后端都用）
services/
  control/                控制面：HTTP API、SSE、账本、门禁、预算、记忆、委托、群研服务、翻译层
    src/
      api/                路由（Hono）
      ledger/             账本
      gates/              门禁状态机
      budget/
      memory/
      delegation/
      swarm/              群研服务（黑板、消息、调度）
      bridge/openscience/ 翻译层（唯一可以 import @synsci/sdk 的目录）
      provisioner/        账户容器管理（Fly Machines）
      anim/               互动动画提供方（OpenMAIC 适配）
  worker/                 Hatchet worker：长流程
plugins/
  reinlab-os-plugin/      OpenScience 插件：结构化卡片工具、记忆工具、群研工具、权限钩子
infra/
  supabase/migrations/    SQL 迁移（含 RLS）
  fly/                    control / worker / account 三类机器的 Dockerfile 与 fly.toml
  docker-compose.dev.yml  本地：Postgres + Hatchet lite + OpenScience
e2e/                      Playwright 端到端（实连后端）
evidence/                 验收证据（见第 14 节）
docs/questions.md         待用户决定的问题
```

**依赖边界（CI 用 lint 规则强制）：**
- 只有 `services/control/src/bridge/openscience/**` 可以 import `@synsci/sdk`。
- `packages/contracts` 不依赖任何服务端包。
- 前端只依赖 `packages/contracts` 和自己的 API 客户端。

---

## 2. 技术选型（已定，不要替换）

| 层 | 选型 |
|---|---|
| HTTP | Hono（Node 22），zod 校验 |
| 数据库 | Supabase Postgres（东京）+ RLS + pgvector；本地用 Supabase CLI 起的 Postgres |
| 身份 | Supabase Auth（JWT）。控制面校验 JWT，并把 `account_id` 写入数据库会话变量供 RLS 使用 |
| 长流程 | Hatchet（TypeScript SDK）。具体 API 以锁定版本的官方文档为准；要用到的能力：持久化任务、等待事件 / 信号、重试、并发上限 |
| 对象存储 | Supabase Storage（S3 兼容），按 `account_id/` 分前缀 |
| 密钥 | Supabase Vault 存加密后的凭据；应用层用 AES-GCM 信封加密（数据密钥由 Vault 管理） |
| 账户容器 | Fly.io Machines（东京 nrt），每账户一台常驻机器 + 一块卷（`/data`） |
| GPU | Modal（经 OpenScience 已有的计算任务能力） |
| 测试 | Vitest（单元 / 集成）、Playwright（端到端） |

---

## 3. 环境变量

```
# control / worker
DATABASE_URL=                     # Supabase Postgres（service role 只给迁移使用）
DATABASE_URL_APP=                 # 应用连接（受 RLS 约束的角色）
SUPABASE_URL= SUPABASE_JWT_SECRET= SUPABASE_SERVICE_ROLE_KEY=
STORAGE_BUCKET=reinlab
HATCHET_CLIENT_TOKEN= HATCHET_CLIENT_TLS_STRATEGY=
FLY_API_TOKEN= FLY_APP_ACCOUNTS=reinlab-accounts FLY_REGION=nrt
ACCOUNT_IMAGE=registry.fly.io/reinlab-accounts:<tag>
INTERNAL_SIGNING_KEY=             # 控制面签发运行令牌 / 容器内部调用的 HMAC 密钥
OPENMAIC_BASE_URL= OPENMAIC_TOKEN=
MODEL_PRICING_SOURCE=models.dev   # 费用估算用的价目表

# account machine（由 provisioner 注入，每账户不同）
OPENSCIENCE_AUTH_TOKEN=           # 只有控制面知道
OPENSCIENCE_DATA_DIR=/data/os-data
OPENSCIENCE_CONFIG_DIR=/data/os-config
REINLAB_CONTROL_URL=              # 插件回调控制面的内网地址
REINLAB_ACCOUNT_ID=
REINLAB_CONTAINER_SECRET=         # 插件调用控制面内部 API 的凭证
```

---

## 4. 数据库（`infra/supabase/migrations`）

所有业务表都有 `account_id uuid not null`，并启用 RLS。应用连接每个请求先执行：

```sql
select set_config('app.account_id', $1, true)
```

策略统一为 `account_id = current_setting('app.account_id')::uuid`。

### 4.1 底座表

```sql
create extension if not exists vector;

create table account (id uuid primary key, created_at timestamptz default now(), display_name text,
  monthly_budget_cny numeric(12,2) not null default 300);

create table dossier (id uuid primary key default gen_random_uuid(), account_id uuid not null references account(id),
  bench text not null check (bench in ('research','curriculum','engineering','creative','automation','exploration','data')),
  title text not null, workspace_path text not null, created_at timestamptz default now(), archived_at timestamptz);

create table role_def (id text primary key, bench text not null, prompt_ref text not null,
  model_tier text not null check (model_tier in ('cheap','mid','strong','embed')),
  tool_grants jsonb not null, read_scope jsonb not null, write_targets jsonb not null, steps int);
-- role_def 是全局表（不分账户），由迁移种子写入，不开放写接口

create table thread (id uuid primary key default gen_random_uuid(), account_id uuid not null, dossier_id uuid not null references dossier(id),
  role_id text not null references role_def(id), os_session_id text, summary text default '', created_at timestamptz default now());

create table run (id uuid primary key default gen_random_uuid(), account_id uuid not null, dossier_id uuid not null references dossier(id),
  parent_run_id uuid references run(id), role_id text not null references role_def(id), mode text not null,
  os_session_id text, os_run_id text, request_id text not null unique,
  state text not null check (state in ('queued','running','waiting','paused_budget','completed','failed','cancelled','interrupted')),
  budget_cny numeric(12,2) not null, spent_cny numeric(12,4) not null default 0,
  quota_runs int not null default 0, gpu_seconds int not null default 0,
  created_at timestamptz default now(), ended_at timestamptz);

create table event (seq bigserial primary key, account_id uuid not null, dossier_id uuid not null, run_id uuid references run(id),
  at timestamptz not null default now(), role_id text, kind text not null, action text, risk text check (risk in ('read','write','danger')),
  input_ref text, output_ref text, cost_cny numeric(12,6), quota int, gpu_seconds int, credential_kind text,
  payload jsonb not null default '{}', dedupe_key text unique);
-- event 只追加：给应用角色撤销 UPDATE / DELETE 权限（迁移里写 revoke）

create table artifact (id uuid primary key default gen_random_uuid(), account_id uuid not null, run_id uuid references run(id),
  dossier_id uuid not null, kind text not null, path text not null, sha256 text not null, version int not null default 1,
  supersedes uuid references artifact(id), created_at timestamptz default now());

create table gate (id uuid primary key default gen_random_uuid(), account_id uuid not null, dossier_id uuid not null,
  subject text not null, state text not null check (state in ('locked','ready','running','review','discuss','approved')),
  updated_at timestamptz default now(), unique (dossier_id, subject));

create table approval (id uuid primary key default gen_random_uuid(), account_id uuid not null, run_id uuid not null references run(id),
  os_request_id text, kind text not null check (kind in ('permission','question','gate','budget','compute','anim')),
  title text not null, effects jsonb not null, risk text not null, state text not null default 'pending'
  check (state in ('pending','approved','rejected','expired','indeterminate')), decided_at timestamptz, decided_scope text);

create table memory_item (id uuid primary key default gen_random_uuid(), account_id uuid not null,
  layer text not null check (layer in ('L1','L2','L3','L4')), dossier_id uuid, thread_id uuid,
  key text not null, value jsonb not null, evidence jsonb not null default '[]', supersedes uuid references memory_item(id),
  revoked_at timestamptz, embedding vector(1536), created_at timestamptz default now());

create table promotion (id uuid primary key default gen_random_uuid(), account_id uuid not null, from_run uuid references run(id),
  target_layer text not null check (target_layer in ('L3.profile','L3.preference','L3.procedure','L4.knowledge')),
  items jsonb not null, reason text not null, status text not null default 'pending'
  check (status in ('pending','approved','edited','rejected','kept_local','expired')),
  created_at timestamptz default now(), expires_at timestamptz not null);

create table delegation (id uuid primary key default gen_random_uuid(), account_id uuid not null,
  from_dossier uuid not null, from_run uuid, to_bench text not null, to_dossier uuid, to_run uuid,
  request jsonb not null, budget_cny numeric(12,2) not null, state text not null, result_ref text, created_at timestamptz default now());

create table credential (id uuid primary key default gen_random_uuid(), account_id uuid not null,
  kind text not null check (kind in ('api_key','subscription_oauth','external_runtime','self_hosted')),
  provider text not null, fingerprint text not null, vault_secret_id uuid not null, created_at timestamptz default now());

create table account_machine (account_id uuid primary key, fly_machine_id text, fly_volume_id text,
  state text not null, os_version text, last_health_at timestamptz);
```

### 4.2 研究台表

即 PRD 附录 B，字段补全后：

```sql
create table swarm_run (id uuid primary key default gen_random_uuid(), account_id uuid not null, dossier_id uuid not null,
  run_id uuid not null references run(id), question text not null, roster jsonb not null, max_active int not null default 8,
  state text not null check (state in ('proposed','running','paused_budget','concluding','done','failed','cancelled')));
create table swarm_agent (id text not null, swarm_run_id uuid not null references swarm_run(id), account_id uuid not null,
  role text not null, model text not null, os_session_id text, state text not null
  check (state in ('idle','working','waiting','done','failed')), primary key (swarm_run_id, id));
create table swarm_task (id text not null, swarm_run_id uuid not null, account_id uuid not null, parent_id text, title text not null,
  kind text not null, status text not null check (status in ('open','doing','done','failed','limit')), claimed_by text,
  primary key (swarm_run_id, id));
create table swarm_board_item (id uuid primary key default gen_random_uuid(), swarm_run_id uuid not null, account_id uuid not null,
  t_ms bigint not null, col text not null check (col in ('question','finding','help','decision')), by_agent text not null,
  text text not null, citations jsonb not null default '[]', reply_to uuid, signed_off_by text, status text not null default 'open'
  check (status in ('open','refuted','supported','limit')));
create table swarm_message (id uuid primary key default gen_random_uuid(), swarm_run_id uuid not null, account_id uuid not null,
  t_ms bigint not null, from_agent text not null, to_agent text not null,
  type text not null check (type in ('broadcast','claim','ask','deliver','help','handoff','refute')),
  text text not null, task_id text, refs jsonb not null default '[]', sets jsonb not null default '[]');
create table paper (id uuid primary key default gen_random_uuid(), account_id uuid not null, dossier_id uuid not null,
  doi text, arxiv_id text, title text not null, file_ref text, access text not null check (access in ('full','abstract_only','uploaded')),
  pages int, page_text_ref text);
create table annotation (id uuid primary key default gen_random_uuid(), paper_id uuid not null references paper(id), account_id uuid not null,
  layer text not null, ord int not null, text text not null, kind text not null check (kind in ('claim','interpretation')),
  citations jsonb not null default '[]', verified boolean not null default false);
create table quiz_item (id uuid primary key default gen_random_uuid(), paper_id uuid not null, account_id uuid not null, layer text not null,
  question text not null, rubric jsonb not null, answer text, verdict text);
create table interactive_anim (id uuid primary key default gen_random_uuid(), paper_id uuid not null, account_id uuid not null,
  locator text not null, widget_type text not null, html_ref text, status text not null check (status in ('pending','ready','accepted','rejected','failed')),
  reject_reason text, provider_meta jsonb);
create table repro_attempt (id uuid primary key default gen_random_uuid(), paper_id uuid not null, account_id uuid not null,
  plan jsonb not null, verdict text check (verdict in ('exact','partial','unresolved')), evidence jsonb not null default '[]');
create table study_ref (id uuid primary key default gen_random_uuid(), dossier_id uuid not null, account_id uuid not null,
  os_study_id text, program_ref text not null, eval_set_ref text not null, metric jsonb not null);
```

每张表都要有 RLS 策略和对应的跨租户测试（第 12 节 T-SEC）。

---

## 5. 共享契约（`packages/contracts`）

用 zod 定义，导出类型。前端与后端只能通过这些类型交流。

```ts
export const Citation = z.object({ source: z.string(), locator: z.string(), quote: z.string().max(400).optional(), verifiedBy: z.string().optional() })
export const Risk = z.enum(['read', 'write', 'danger'])

export const LedgerEvent = z.object({
  seq: z.number(), at: z.string(), dossierId: z.string().uuid(), runId: z.string().uuid().nullable(), roleId: z.string().nullable(),
  kind: z.enum(['message', 'tool', 'approval', 'card', 'artifact', 'cost', 'gate', 'swarm', 'study', 'delegation', 'memory', 'error']),
  action: z.string().nullable(), risk: Risk.nullable(), costCny: z.number().nullable(), payload: z.record(z.unknown()),
})

// 结构化卡片：模型只能通过插件工具产生它们，前端按 kind 渲染
export const Card = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('answer'), question: z.string(), options: z.array(z.string()).min(2).max(6), multi: z.boolean() }),
  z.object({ kind: z.literal('approval'), title: z.string(), effects: z.array(z.string()), risk: Risk, action: z.string() }),
  z.object({ kind: z.literal('plan'), stage: z.string(), steps: z.array(z.string()), budgetCny: z.number() }),
  z.object({ kind: z.literal('finding'), claim: z.string(), citations: z.array(Citation).min(1), negative: z.boolean() }),
  z.object({ kind: z.literal('verdict'), subject: z.string(), pass: z.boolean(), reasons: z.array(z.string()) }),
])

export const ResearchRequestV1 = z.object({
  schema: z.literal('research_request@1'), question: z.string().min(4),
  scope: z.object({ include: z.array(z.string()).optional(), exclude: z.array(z.string()).optional(), since: z.string().optional(), languages: z.array(z.enum(['zh', 'en'])).optional() }),
  refs: z.array(z.object({ kind: z.enum(['artifact', 'memory', 'url']), id: z.string(), version: z.number().optional() })),
  budget: z.object({ cny: z.number().positive(), quotaRuns: z.number().optional(), gpuMinutes: z.number().optional() }),
  expect: z.string(), deadline: z.string().optional(), gate: z.enum(['none', 'approve-before', 'approve-after']),
})
export const ResearchFindingsV1 = z.object({
  schema: z.literal('research_findings@1'),
  methods: z.array(z.object({ name: z.string(), claim: z.string(), evidence: z.array(Citation).min(1), fit: z.string(), confidence: z.enum(['high', 'mid', 'low']) })),
  routes: z.array(z.object({ id: z.string(), name: z.string(), steps: z.array(z.string()), why: z.string(), picked: z.boolean() })),
  negatives: z.array(z.object({ what: z.string(), how: z.string() })),
  nextPlan: z.string(),
})
// 群研工具参数（与第 9.1 节一致）、RunToken、PendingPromotion、Layer、QuizItem 等同样在此定义
```

---

## 6. 控制面 API（`services/control/src/api`）

**通用约定：**
- 前缀 `/v1`，`Authorization: Bearer <Supabase JWT>`。
- 写请求必须带 `Idempotency-Key`。
- 错误体为 `{ code, message, details? }`，`message` 用中文。
- `/internal/*` 只接受账户容器调用：带 `X-Container-Secret`，并校验来源机器属于该账户。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/me` | 账户、预算、账户容器状态 |
| GET/POST | `/v1/dossiers` | 列表 / 新建（bench=research） |
| GET | `/v1/dossiers/:id` | 档案详情（门禁、进行中运行、预算） |
| GET | `/v1/dossiers/:id/events?after=<seq>` | SSE，按 seq 续读；`Last-Event-ID` 支持 |
| GET | `/v1/dossiers/:id/audit` | 审计导出（JSONL）与费用汇总 |
| POST | `/v1/runs/estimate` | 费用预估（模式、规模、模型档） |
| POST | `/v1/runs` | 启动运行（含预算确认） |
| POST | `/v1/runs/:id/cancel` | 取消 |
| POST | `/v1/runs/:id/budget` | 追加预算（门禁上的决定） |
| GET | `/v1/approvals?state=pending` | 待审批 |
| POST | `/v1/approvals/:id/decide` | `{ decision: 'approve'|'reject', scope?: 'once'|'session' }`（`project` / `always` 不开放） |
| GET | `/v1/promotions?state=pending` | 上线收件箱 |
| POST | `/v1/promotions/:id/decide` | `{ decision: 'approve'|'edit'|'reject'|'keep_local', items? }` |
| POST | `/v1/read/papers` | 新建精读：`{ dossierId, source: { arxivId|doi|url|title } }` 或 multipart 上传 |
| GET | `/v1/read/papers/:id` | 论文、层、批注、检查题、动画、复现 |
| POST | `/v1/read/papers/:id/ask` | 带定位提问 `{ locator, text }` |
| POST | `/v1/read/papers/:id/quiz/:qid/answer` | 作答 |
| POST | `/v1/read/papers/:id/anims` | 生成互动解释 `{ locator, concept, widgetType? }` |
| POST | `/v1/read/anims/:id/decide` | 接受 / 驳回（带原因） |
| POST | `/v1/read/papers/:id/repro` | 生成复现提议（不执行） |
| POST | `/v1/swarm/propose` | 编制提议 `{ dossierId, question, budgetCny }` |
| POST | `/v1/swarm/:id/start` | 按（可修改的）编制启动 |
| GET | `/v1/swarm/:id/state?t=<ms>` | 回放：重建时刻 t 的全局 |
| GET | `/v1/swarm/:id/agents/:agentId` | 单个 agent 的完整过程 |
| POST | `/v1/swarm/:id/conclude` | 你手动结束 |
| POST | `/v1/auto/brief` | 研究简报对话一轮（返回 card / 已填字段） |
| POST | `/v1/auto/datasets` | 上传数据集（multipart，进档案工作区） |
| POST | `/v1/auto/eval-set` | 抽样标注：生成待标注样本 / 提交标注 |
| POST | `/v1/auto/studies` | 启动 study（简报齐全 + 有评估集才允许） |
| POST | `/v1/auto/studies/:id/steer` | 常驻指令 |
| POST | `/v1/dispatch` | 模式间派发 `{ dossierId, from, to, brief, refs }` |
| POST | `/v1/delegations` | 调研委托（body = `research_request@1`） |
| GET | `/v1/delegations/:id` | 状态与结果引用 |
| POST | `/internal/os/:osSessionId/token` | 插件取运行令牌 |
| POST | `/internal/os/tool-call` | 插件工具回调控制面（swarm / memory / card / finding） |
| POST | `/internal/os/permission-ask` | 插件 `permission.ask` 钩子转交控制面决策 |

**错误码（节选）：**

| 码 | 含义 |
|---|---|
| `GATE_LOCKED` | 门禁未开 |
| `BUDGET_EXCEEDED` | 预算已用完 |
| `NEEDS_EVAL_SET` | 自研没有评估集 |
| `SCOPE_DENIED` | 角色越权 |
| `RLS_DENIED` | 跨租户访问 |
| `OS_UNAVAILABLE` | 账户容器不可用 |
| `ANIM_PROVIDER_UNSUPPORTED` | OpenMAIC 不支持该生成方式 |
| `IDEMPOTENCY_CONFLICT` | 同一幂等键的请求内容不同 |

---

## 7. 账户容器（`services/control/src/provisioner`）

- **镜像**（`infra/fly/account.Dockerfile`）：
  - 安装锁定版本的 `@synsci/openscience`；
  - poppler-utils（`pdftotext`）、tesseract-ocr（含 `chi_sim`、`eng`）、python3 + 常用科学包；
  - `plugins/reinlab-os-plugin` 的构建产物，放在 `/opt/reinlab/plugin`。
- **启动脚本**：
  - 写 `OPENSCIENCE_CONFIG_DIR/openscience.json`：注册插件（`"plugin": ["file:///opt/reinlab/plugin/index.js"]`）、默认 provider 设置；
  - 以 `openscience serve --port 4096 --format json` 启动；
  - 解析就绪 JSON；健康检查 `GET /global/health`。
- **只在 Fly 内网暴露**：不对公网开端口，控制面经 `<machine>.vm.<app>.internal:4096` 访问，并携带 `OPENSCIENCE_AUTH_TOKEN`。
- **目录**：
  - `/data/dossiers/<dossierId>/` 是档案的 project 目录；
  - `/data/os-data`、`/data/os-config` 是运行时数据。
  - 一台服务器用目录选择器服务该账户的所有档案。
- **生命周期**：
  - 注册即创建机器和卷；
  - 常驻（`auto_stop` 关闭）；
  - 每晚把 `/data/dossiers` 快照到对象存储；
  - 升级镜像时滚动替换，替换前等进行中的运行收尾或标记 `interrupted`。
- **恢复**：机器重启后，控制面把该账户所有 `running` 的运行对账，变成 `interrupted` 或交给 Hatchet 续跑（第 10 节）。

---

## 8. 翻译层（`services/control/src/bridge/openscience`）

### 8.1 下行

**会话与运行：**
- 每个 ReinLab 运行对应一个 OpenScience 会话（`client.session.create({ title, workspace: 'project' })`，`directory` = 档案目录）。
- 运行令牌按 `os_session_id` 登记。
- 提交用 `runtime.prompt({ sessionID, requestID: run.request_id, effort, message|parts, model })`。**`requestID` 永远等于我们的 `run.request_id`**，保证幂等。
- 同一个 `requestID` 内容不同会返回 409，要映射成 `IDEMPOTENCY_CONFLICT`，不能重试。

**agent 定义生成：** 由 `role_def` 生成 `/data/os-config/agent/rl-<roleId>.md`。

```markdown
---
description: <角色中文说明>
mode: <primary|subagent>
model: <provider/model-id，来自模型路由>
steps: <role_def.steps>
permission:
  edit: <allow|ask|deny>
  bash: <allow|ask|deny>
  <tool-id>: <allow|ask|deny>   # 由 tool_grants 生成；danger 一律 deny
---
<角色提示词：语言（中文）、语气、篇幅、禁止事项、必须使用结构化卡片工具的规则>
```

**SPIKE-1（P0，第 1 周）：确认给单个会话指定 agent 的方式。**
- 候选：`session.create` 的参数、`prompt` 的输入字段、或 parts 里的 agent mention。
- 结论写入 `docs/spikes/SPIKE-1.md`。
- 如果都不支持：每个角色在档案下用 `.roles/<roleId>/` 子目录作为独立 project，并在该目录的项目配置里把 `rl-<roleId>` 设为默认 agent。由验收方确认后再用。

**记忆注入：**
- 运行开始时，记忆服务按角色 `read_scope` 过滤，写成项目说明文件放进档案目录。
- **SPIKE-2：** 读 OpenScience `src/session/instruction.ts`，确认它读取的项目说明文件名与优先级。
- 运行中按需检索，走插件工具 `memory.read`。

**模型路由：** 位置 → 模型档 → 具体模型（账户设置）。会员凭据用户需在自己的容器里自行登录，控制面不接触明文。

### 8.2 上行

- 每个活跃会话一个订阅器：先取 `runtime.snapshot` 得到游标，再 `runtime.events({ afterSequence })`。
- 去重键 `dedupe_key = <osSessionId>:<sequence>`。
- 游标冲突时重新取快照。**永远不因为观察出错而重新提交 prompt。**
- **事件映射：** 由 SDK 生成的类型确定全部 `RuntimeEvent.type`，在 `bridge/openscience/mapping.ts` 里逐一映射。**未知类型记为 `kind: 'error', action: 'unmapped_event'`，不丢弃。** 最低要覆盖：

| 来源 | → LedgerEvent.kind |
|---|---|
| 助手文本消息 | `message` |
| 工具调用开始 / 结束 / 失败（含 metadata） | `tool`（risk 来自 tool_grants 查表） |
| 本插件卡片工具的完成结果 | `card`（payload = `Card`） |
| 权限请求 / 提问 | `approval`（同时写 `approval` 表，`os_request_id` 记下） |
| 用量 | `cost`（按 credential_kind 计 ¥ / 额度 / GPU 秒） |
| 运行状态变化 | `gate`（运行级）或 run 表状态 |
| 产物 / Result | `artifact` |

- **决定回填：** 用户在 ReinLab 决定后，调用 `runtime.decide({ kind, sessionID, requestID, reply: 'once'|'session'|'reject' })`。
  - 返回 `indeterminate` 时，`approval.state='indeterminate'`，在界面提示「无法确认，请检查状态」，**不重复执行**。
  - OpenScience 进程重启后，原来的待决定会消失：我们把对应 `approval` 标为 `expired`，并把运行标为 `interrupted`，由流程决定是否重提（用新的 `requestID`）。

### 8.3 费用

- 优先用提供方回报的用量，按 models.dev 价目换算 ¥。缺用量时记 `null`，界面显示「未知」，**不估**。
- 会员凭据记 `quota`，GPU 记 `gpu_seconds`。
- 每日对账任务：比较账本合计与提供方账单（能拿到账单的那几家），误差写入 `evidence/`。

---

## 9. 插件（`plugins/reinlab-os-plugin`）

- 插件入口导出一个 `Plugin`。所有工具都通过 `REINLAB_CONTROL_URL/internal/os/tool-call` 回调控制面，并带上 `sessionID` 与 `callID`。
- 控制面查到对应的运行令牌，在服务端校验角色权限。**插件本身不做业务判断**，只做转发和参数校验。

### 9.1 工具

| 工具 id | 参数（zod，来自 contracts） | 作用 |
|---|---|---|
| `card_answer` | `{ question, options[], multi }` | 发回答卡，本轮结束等用户选 |
| `card_approval` | `{ title, effects[], risk, action }` | 请求审批（risk=danger 一律被拒） |
| `plan_propose` | `{ stage, steps[], budgetCny }` | 交回下一阶段 Plan |
| `finding_record` | `{ claim, citations[], negative }` | 记录结论或负结果（citations 至少 1 条，负结果写检索过程） |
| `verdict_record` | `{ subject, pass, reasons[] }` | 审查 / 核实判定 |
| `memory_read` | `{ query, layers[] }` | 按角色范围检索记忆 |
| `memory_propose` | `{ target, items[], reason }` | 提议升级，进收件箱 |
| `read_layer_write` | `{ paperId, layer, items: [{ text, kind, citations[] }] }` | 写精读层 |
| `read_quiz_write` | `{ paperId, layer, question, rubric }` | 写检查题 |
| `swarm_broadcast` / `swarm_claim` / `swarm_ask` / `swarm_deliver` / `swarm_help` / `swarm_handoff` / `swarm_refute` / `swarm_board` | 见 PRD 附录 A | 群研 |

**工具返回：**
- 返回 `{ title, output, metadata }`，`output` 为简短中文说明。
- 被拒时返回 `output` 说明原因，`metadata.error` = 错误码。**不抛异常**，让 agent 读到原因。

### 9.2 钩子

- `permission.ask`：调用 `/internal/os/permission-ask`。控制面按运行令牌返回 `allow`、`deny` 或 `ask`。返回 `ask` 时，由翻译层把它转成审批卡。
- `tool.execute.before`：再校验一次运行令牌（白名单、预算未超）。不通过时拒绝并说明原因。
- `tool.execute.after`：把工具耗时与 metadata 回报控制面（补充账本）。

---

## 10. 长流程（`services/worker`，Hatchet）

每个工作流都必须满足：
- **可重入**：任何一步重跑不会产生重复副作用。所有对 OpenScience 的提交都用确定的 `requestID`。
- **可等待**：要等人批准的地方用 Hatchet 的等待事件 / 信号，不轮询。

| 工作流 | 步骤 | 等待点 |
|---|---|---|
| `read.ingest` | 解析来源 → 开放获取取全文（或标 `abstract_only`）→ 按页抽文本 → 存 `page_text_ref` | 无全文时等用户上传 |
| `read.layers` | 逐层提交精读助手 → 写层 → **引用核对**（10.1）→ 失败条目退回重写（最多 2 次）→ 标 `verified` | 预算门禁 |
| `read.anim` | 调动画提供方 → 存 HTML → `ready` | 用户接受或驳回 |
| `read.repro` | 生成提议 → 用户批准 → 计算任务 → 判定 | 批准；预算 |
| `swarm.run` | 见 10.2 | 编制确认；`ask` 等交付；预算 |
| `auto.study` | 简报齐全 + 评估集 → 提交「开始 study」→ 订阅 study 事件 → 映射前沿 → 收尾写报告与 lessons 提议 | 预算（复用 OpenScience 的预算暂停，同步到我们的门禁） |
| `delegation.research` | 校验 `research_request@1` → 选模式（规则见 10.3）→ 子流程 → 校验产出 schema → 交回 | 委托方的 `gate` 设置 |
| `promotion.expire` | 每小时过期未处理的升级请求 | — |
| `account.reconcile` | 机器重启后对账运行状态 | — |

### 10.1 引用核对（精读与群研共用，必须实现）

对每条 `Citation`：
1. `source` 必须是本档案已有的论文或产物。
2. `locator` 解析成页码（或段落），页码必须在范围内。
3. 如果有 `quote`：用规范化后的文本（统一空白、全半角、连字符断行），在该页文本里做子串匹配。匹配不上时，允许相似度 ≥ 0.9 的近似匹配，并记录相似度。
4. 不通过的条目不得标 `verified`，也不得进入最终报告。

### 10.2 群研服务（`services/control/src/swarm`）

**编制提议（`/v1/swarm/propose`）：**
- 一次总负责人运行，产出：子问题、角色人数、模型档、预计 token、预计 ¥。
- 规模由预算决定：`人数 = clamp(8, 32, floor(预算 / 单 agent 预计成本))`，第一版上限 12，可配置。

**agent 的状态：**

```
idle → working → (waiting ↔ working)* → done | failed
```

- `working`：正在跑一轮（一个 OpenScience run）。
- `waiting`：发出 `swarm_ask` 或等待被分派，本轮已结束。

**调度循环**（`swarm.run` 工作流内）：
1. 每当有 agent 空闲并且有可领取的任务或待回复的交付，就为它开新一轮。
2. 新一轮的输入：角色提示词 + 黑板快照（按角色过滤）+ 新到的消息。
3. 同时 `working` 的数量 ≤ `max_active`，其余排队，在黑板上显示「排队」。

**消息的服务端语义：**
- `claim`：用条件更新做原子领取（`update swarm_task set claimed_by=… where id=… and claimed_by is null`）。
- `ask`：写消息，提问方进入 `waiting`。对方在下一轮看到问题；对方交付时，Hatchet 发出 `swarm.deliver.<swarmRunId>.<askId>` 事件，唤醒提问方。
- `deliver`：citations 至少 1 条，或 `negative=true` 并在 text 里写检索过程；更新任务状态。
- `refute`：被反驳的黑板条目置为 `refuted`，提出方必须在后续交付里补证据（置为 `supported`），或由总负责人降级为 `limit`。
- **核实签核**：只有核实者能写 `signed_off_by`。签核前先跑 10.1 的引用核对。

**结束：** 总负责人发出「结束」决定，或预算触发门禁，或用户结束。结束后由汇总者生成报告：
- 只收 `supported` 且有签核的条目；
- `limit` 进入「局限」；
- 负结果单列。

**回放（`/v1/swarm/:id/state?t=`）：**
- 按 `t_ms` 折叠 `swarm_message`、`swarm_board_item`、任务状态变化，得到时刻 t 的全局状态。**不调模型。**
- 单个 agent 的过程从 `event` 表按其 `os_session_id` 查出。

### 10.3 委托选模式

规则按顺序判断，选中的理由写进账本：
1. `refs` 里有一篇具体论文，且问题是理解类 → 精读。
2. 问题含明确指标、数据与目标值 → 自研。
3. 其他 → 群研。

课程台的「学习方法与路线」调研应落到群研。

### 10.4 互动动画提供方（`services/control/src/anim`）

```ts
interface AnimProvider {
  generate(input: { concept: string; context: Citation[]; contextText: string; widgetType?: 'simulation'|'diagram'|'code'|'game'|'visualization3d'|'procedural-skill'; lang: 'zh' }): Promise<{ html: string; widgetType: string; meta: Record<string, unknown> }>
}
```

**SPIKE-3（P0，第 2 期第 1 天）：确认 OpenMAIC 是否能单独生成一个互动场景。** 结论写入 `docs/spikes/SPIKE-3.md`。
- 如果能：`OpenMaicAnimProvider` 直连。
- 如果不能：做 `OpenMaicCourseAdapter`。先用 OpenMAIC 生成一门只含一个互动场景的最小课程，再取出 `content.type==='interactive'` 的 `html`。**同时**在 `docs/questions.md` 提议给 OpenMAIC 加单场景端点。
- 两种实现都必须通过同一套契约测试。

**校验返回的 HTML：**
- 必须是完整文档；
- 外部脚本只允许白名单 CDN；
- 不允许 `<base>`、表单提交、`window.top` 访问。不符合就标 `failed` 并降级为静态图解。

---

## 11. 前端接入

- 新增 `src/lib/api/`：类型来自 `packages/contracts`；SSE 客户端支持 `Last-Event-ID` 续读与去重。
- **数据源开关：** `VITE_BACKEND=mock|live`，默认 `mock`。
  - `mock` 下现有示例数据与动画**完全不变**，现有的无头回归脚本必须全部继续通过。
  - `live` 下研究台的三种模式读写后端。
- 精读的互动动画组件 `InteractiveFrame`：
  - `<iframe srcdoc sandbox="allow-scripts" referrerpolicy="no-referrer">`；
  - **不得**加 `allow-same-origin`、`allow-top-navigation`、`allow-forms`、`allow-popups`；
  - 外层加载失败或超时 10 秒时显示静态降级。
- 审批卡、回答卡、计划卡按 `Card` 渲染，复用现有 `AgentDock` 的组件。
- 上线收件箱：登录或回到前台时，若有 `pending` 升级请求则弹出（按工作台分组、显示依据、四种操作）。

---

## 12. 测试要求

| 编号 | 类别 | 内容 | 必须 |
|---|---|---|---|
| T-UNIT | 单元 | 门禁状态机、预算计算、引用核对（含规范化与近似匹配）、委托选模式、回放折叠、事件映射 | 每个模块 ≥ 85% 行覆盖 |
| T-CONTRACT | 契约 | 用 OpenScience 自带的本地 fixture provider（确定性模型）跑翻译层：会话创建、提交幂等（同 ID 同内容返回原收据 / 不同内容 409）、事件映射完整、决定回填、取消 | 锁定版本下全绿；升级前必须跑 |
| T-INT | 集成 | docker-compose 起 Postgres + Hatchet + OpenScience（fixture provider）；跑通 `read.layers`、`swarm.run`（4 个 agent）、`auto.study`（玩具指标）、`delegation.research` | 全绿 |
| T-SEC | 安全 | ① 账户 A 的 JWT 访问账户 B 的每一张表、每一个 API → 全部 403 / 0 行；② 插件用别的会话 ID 回调 → 拒绝；③ danger 动作在任何入口都无法执行；④ iframe 里的脚本读 `parent.document`、`document.cookie`、`localStorage`、发起顶层跳转 → 全部失败 | 全绿，结果存证据 |
| T-CHAOS | 可靠 | 群研进行中重启账户机器；Hatchet worker 中途被杀；SSE 断线重连 → 运行可续，无重复副作用，无事件丢失或重复 | 全绿，附事件序列比对 |
| T-E2E | 端到端 | Playwright（`e2e/`），`live` 模式，对 staging：精读一篇论文、群研一次、自研玩具任务、上线收件箱批准、审批卡批准 | 全绿，附录屏 |
| T-REG | 回归 | 现有前端无头回归脚本在 `mock` 模式全部通过；`npm run build` 与 `vitest` 通过 | 全绿 |

---

## 13. 任务分解

**依赖记法：** `←` 表示依赖。每个任务的完成定义（DoD）都包含「测试通过 + 证据入库」。

### 第 1 期 · 底座 + 自研（3 周）

| 任务 | 内容 | 依赖 | DoD 要点 |
|---|---|---|---|
| P1-01 | pnpm 工作区、lint 依赖边界规则、CI | — | 违反边界的 import 会让 CI 失败 |
| P1-02 | `packages/contracts` | P1-01 | schema 有单元测试 |
| P1-03 | Supabase 迁移（4.1）+ RLS + 种子 role_def | P1-01 | T-SEC ① 通过 |
| P1-04 | 控制面骨架：Hono、JWT、`set_config`、错误格式、幂等键 | P1-03 | — |
| P1-05 | 账本写入、SSE 续读、审计导出 | P1-04 | 断线续读不丢不重 |
| P1-06 | 门禁状态机与 `gate` 表 | P1-05 | 状态转移全覆盖 |
| P1-07 | 预算：预估、划拨、80% 提醒、100% 停 | P1-05 | — |
| P1-08 | 账户容器镜像与 provisioner（Fly） | P1-04 | 新账户 3 分钟内可用；健康检查 |
| P1-09 | **SPIKE-1、SPIKE-2** | P1-08 | 结论文档 + 验收方确认 |
| P1-10 | 翻译层：会话、提交、事件映射、决定回填、费用 | P1-09 | T-CONTRACT 全绿 |
| P1-11 | 插件：卡片工具、记忆工具、权限钩子 | P1-10 | 越权调用被拒 |
| P1-12 | 审批卡与上线收件箱（API + 前端 live 接入） | P1-11 | — |
| P1-13 | Hatchet worker 骨架与 `account.reconcile` | P1-10 | T-CHAOS（机器重启） |
| P1-14 | 自研：简报对话、数据集上传、评估集抽样标注 | P1-12 | 无评估集时启动返回 `NEEDS_EVAL_SET` |
| P1-15 | 自研：`auto.study`（接 OpenScience Autoresearch）、前沿曲线与运行矩阵 live | P1-14 | — |
| P1-16 | OCR 验收数据集与端到端跑通 | P1-15 | 见验收 AC-AUTO-OCR |

### 第 2 期 · 精读（3 周）

| 任务 | 内容 | 依赖 |
|---|---|---|
| P2-01 | **SPIKE-3**（OpenMAIC 单场景） | — |
| P2-02 | `read.ingest`：开放获取、上传、按页文本、`abstract_only` 标记 | P1-* |
| P2-03 | 引用核对模块（10.1） | P2-02 |
| P2-04 | `read.layers` + 写层工具 + 退回重写 | P2-03 |
| P2-05 | 带定位问答 | P2-04 |
| P2-06 | 检查题与作答 | P2-04 |
| P2-07 | 动画提供方（按 SPIKE-3 结论）+ HTML 校验 | P2-01 |
| P2-08 | 前端 `InteractiveFrame` + 降级 + 接受 / 驳回 | P2-07 |
| P2-09 | 复现：提议、批准、计算任务（CPU / Modal）、判定 | P2-04 |
| P2-10 | 派发（精读 → 群研 / 自研）与升级提议（论文 + 批注） | P2-04 |
| P2-11 | 精读前端 live 接入 | P2-05 · P2-06 · P2-08 · P2-09 |

### 第 3 期 · 群研 + 委托（4 周）

| 任务 | 内容 | 依赖 |
|---|---|---|
| P3-01 | 群研表与服务骨架 | P1-* |
| P3-02 | 编制提议与确认 | P3-01 |
| P3-03 | 8 个 swarm 工具（服务端语义） | P3-01 |
| P3-04 | 调度循环、准入、`ask` / `deliver` 唤醒 | P3-03 |
| P3-05 | 反驳与核实签核（复用 10.1） | P3-04 · P2-03 |
| P3-06 | 结束与报告生成 | P3-05 |
| P3-07 | 回放 API 与前端 live 接入 | P3-04 |
| P3-08 | 委托：`/v1/delegations`、选模式、`research_findings@1` 校验 | P3-06 |
| P3-09 | 课程台接入一次真实委托（只接调研这一段） | P3-08 |
| P3-10 | T-CHAOS（群研中断）、T-E2E 全量、费用对账 | 全部 |

---

## 14. 证据格式（验收时只认这里的东西）

```
evidence/
  <任务编号>/
    README.md          做了什么、怎么复现（命令）、已知限制
    test-report.json   该任务相关测试的结果（Vitest / Playwright JSON 报告）
    *.png / *.webm     界面截图、录屏（端到端任务必需）
    ledger-export.jsonl  端到端任务的账本导出
  final/
    ac-matrix.csv      验收清单每一项：编号、结论、证据路径（由 Codex 预填，验收方复核）
    cost-reconcile.csv 费用对账
    deploy.md          staging 地址、测试账户（凭据写在 infra/seed/ 的示例文件里，不进证据）、版本号
```

**交付时附一份 `evidence/final/HANDOFF.md`：**
- 所有任务的状态；
- 未完成项与原因；
- `docs/questions.md` 里待用户决定的问题；
- 验收方需要的全部命令。
