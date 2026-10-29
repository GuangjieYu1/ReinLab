# DSH 精读改造 · 可执行 spec

依据 [PRD 01](../../../../Documents/DeepSeekPlugin/ReinLab/design/prd/01-slim-and-dsh.md)（工作区 `design/prd/01-slim-and-dsh.md`）与用户已确认的取舍。
分支 `slim/backend`，基线 `0298c89`。本 spec 只覆盖 B1–B4，不扩大范围。

## 1. 目标

精读跑在无界面 DSH 上；管控层缩为「访问控制 + 单次审批 + 取消 + 用量记录」；旧内核在 DSH 验收后退役。
B1 8 步精读、B2 启动链不再有 OpenScience、B3 无预算预留/单卡/未知用量不阻塞、B4 保留能力照常 + 全量测试。

## 2. 已核实事实（spike 实测，2026-10-27）

用 `@deepseek-ai/dsh@0.2.1-rc.4` + `dsh-sdk-client@0.2.1-rc.4` + `dsh-sdk-protocol@0.2.1-rc.4`，本地 stub Messages 服务，实跑结论：

| # | 事实 | 证据 |
|---|---|---|
| 1 | 官方 client 以 `process.execPath` 启动 `node <dshBin> --profile sdk --patch <p>`；`dshBin` 是 **Node 模块路径**，不是可执行文件 | `dsh-sdk-client/lib/index.js:164-182`；实跑 |
| 2 | 模型走 **Messages API**：`POST {DEEPSEEK_BASE_URL}/v1/messages`，头 `anthropic-version: 2023-06-01`、`x-api-key`（**不是** `authorization`），SSE | 请求日志 `/anthropic/v1/messages`，`x-api-key: true` |
| 3 | 适配器 `dsh-llm-deepseek@0.2.1-rc.4` 默认 `baseURL=https://api.deepseek.com/anthropic`，可由 patch/`DEEPSEEK_BASE_URL` 覆盖 | 包内 `PUBLIC_BASE_URL`/`BASE_URL_ENV` |
| 4 | 自定义 Cordis 插件经 `--patch` 加载，`name` 可用 `file://` URL；`defineTool` + `ctx.tools.register` 生效 | `probe`/`ask_host` 出现在请求 tools 列表 |
| 5 | 工具在宿主决策上阻塞时 turn 保持打开：阻塞 12.6s 后返回，turn 正常 `completed` | `ask_host` 实测 `allowed-once@12656ms` |
| 6 | 取消 = `harness.close()`：直接子进程 1.36s 关闭且无残留；经 shim 时可确认 in-container/in-process PID 消失 | `closeMs:1359`、`stillAlive:[]`、shim `stopped-confirmed` |
| 7 | 用量随 `assistant/message.data.usage` 每步到达：`{inputTokens,outputTokens,totalTokens,...}` | step1 `{11,7,18}`、step2 `{21,13,34}` |
| 8 | 工具面可裁剪：在 patch 里 `disabled: true` 掉 base 的 tool 行后，模型可见工具列表精确等于自定义工具 | `tools: ["ask_host","probe"]` |
| 9 | 所选发布版（0.2.1-rc.4）**缺少 SDK 侧的审批桥接**（`approval/request` 服务端→客户端通道）；DSH 本身有 approval 扩展点，是发布版没有 SDK 桥接，不是 DSH 没有审批机制 | 包内 `HarnessSdkRequestMap` 无 `approval/request` |

未核实（环境受限，非设计问题）：`docker exec -i` 的 stdio 长连接与容器内 PID 确认。本机 Docker Hub 拉取全程超时，账户镜像内实测推迟到镜像可用时。
降级路径不做第二形态，仍在容器内跑；镜像是前置条件。

## 3. 实现决议

### 3.1 模型：Messages API 薄透传
新增 `POST /llm/anthropic/v1/messages`（控制面）：
1. 从 `x-api-key`（或 `authorization: Bearer`）取 run token → `kernel/auth.ts` 校验 → `{account,dossier,run}`；
2. 请求体、头、错误体**原样**转发到 Provider 的 `${baseUrl}/v1/messages`，把 run token 换成宿主持有的真实 key；
3. SSE 逐帧中继，客户端 abort 传播到上游；
4. 从上游 `usage` 记 `usage_record`（唯一权威写入路径）；Provider 未给 → `known=false`。
不做 chat/completions 转换，不加 512/1024 硬限制；输出上限由配置给。

### 3.2 认证与范围：只提取两样
`kernel/auth.ts`：run token `{v,account,dossier,run,exp}`，HMAC/签名校验；只做身份 + 范围。账户隔离仍靠 RLS + `app.account_id`。
不复用 `CapabilityAuthority` 整体；不带预算 hold、版本摘要、能力树。

### 3.3 审批：插件等待 + 控制面唯一一张卡
`papers.fetch` 工具执行前调控制面 → 写**一行** `approval`（绑定 `run + capability + argsHash`）→ 页面呈现唯一卡片 → 插件阻塞等待（turn 不关）→ 决定后返回结果。
批准后带 `approvalId` 重入；**重复提交返回已有状态/结果，不重复下载**（复用 `paper_asset`）。参数变化 → 重新询问。
不做：`mcp_approval` 第二行、原生权限、双答、预算 hold 绑定。

### 3.4 取消：per-run，且确认容器内实际停止
- 每次运行独立：`/run/reinlab/runs/<runId>/dsh.pid`（容器内）、per-run patch + 凭据文件 + token，**不用账户级单文件**。
- 取消只作用于该 run 的进程组：SIGTERM → 轮询 `kill -0` 确认消失 → 才写 `cancelled`；确认不到写 `cancel_unconfirmed` 并如实呈现。
- 同一 `dsh_session` 写入用租约互斥（DB 咨询锁/租约行），释放确认前其他进程不得写该 session；锁粒度是 session，不阻塞其他档案。

### 3.5 用量：单一写入路径
`usage_record` 只由网关写；DSH 事件不再写同一笔。字段：provider/model/input/output/cache_read/cache_write/reasoning/cost_cny(nullable)/known。

### 3.6 读取工具面
精读 profile patch 关掉 base 工具行（bash/pwsh/jobs/fs/fs-search/skill/subagent/subagent-fork/subagent-control/workflow/todo/goal/web/working-directory/plan-mode），只保留：
`papers.search` / `papers.fetch`（单次审批）/ `papers.pages` / `cards.layer` / `cards.finding` / `clarify_question`。
不开放通用 `files.write`。

## 4. 模块与顺序

1. `services/control/src/kernel/auth.ts` — token 与范围。
2. `services/control/src/kernel/dsh/{launch,session,events,cancel,provider,shim}.ts` — 启动、resume、事件映射、取消确认、per-run 配置。
3. `services/control/src/model/messages-proxy.ts` — `/llm/anthropic/v1/messages`。
4. `services/control/src/run/{state,usage,approval}.ts` — 薄状态机、用量、单卡。
5. `plugins/reinlab-read-plugin/` — Cordis 插件与工具。
6. `api/{runtime,read-clarify,read-view,app}.ts`、`main.ts` — 接线（前端契约待 Claude，字段不预设）。
7. `services/account-runtime/`、`infra/fly/account.Dockerfile`、`provisioner/docker.ts`、`tooling/local/up.ts` — 镜像与启动链换 DSH。
8. 退役：`bridge/openscience/`、`plugins/reinlab-os-plugin/`、`clarify/model.ts`、worker/Hatchet、旧表迁移。

## 5. B1–B4 测试

- **B1** `dsh-read-flow.test.ts`：8 步（真实 DSH 子进程 + stub Provider + 论文 fixture）；拒绝下载 → 「已停止 · 没有下载」且无 `paper_asset`；错误可重来。
- **B2** 真跑 `local:up --real-models` 记录进程/容器清单为主证；`openscience-retired.test.ts` 补充断言。
- **B3** `usage-single-path`、`approval-single`、`approval-idempotent`、`no-budget-gate`、`dsh-cancel-confirmed`、`session-write-lock`。
- **B4** 现有 auth/RLS/隔离/论文/收件箱测试全绿；全量一次。

## 6. 改动前基线（`0298c89`，Node 24.14.1，本地 PG 55432，`REINLAB_REQUIRE_NATIVE=1`）

结果：**1606 passed / 4 failed（1610）**，4 条既有失败：

| 测试 | 失败原因 | 归属 |
|---|---|---|
| `services/control/test/batch7-native.test.ts > native2.0.150 candidates=true ... without auto-picking` | 期望 `{questions:1,requests:2}`，实得 `{questions:0,requests:6}` | OpenScience 原生行为漂移，随桥接退役删除 |
| `services/control/test/batch7-native.test.ts > native2.0.150 candidates=false ...` | 同上 | 同上 |
| `services/control/test/account-entrypoint-lock.test.ts > 入口配置与子进程强制禁用自动升级并保留模型和插件` | 期望退出码 17，实得 1 | 旧账户入口（OpenScience）行为，随入口替换重写 |
| `tooling/local/control-process.test.ts > stops the real recorded Node process without relying on the parent ChildProcess handle` | `process.kill(pid,0)` 在 50ms 后仍成功 | 进程回收时序，与本轮改造无关 |

新回归一律当回归修，不并入本清单。

## 7. 不做

双内核开关/自动回退、旧数据迁移、新预算产品、七台重构、`files.write` 通用写、证据审计工程、双 Node 矩阵、额外边缘场景。
