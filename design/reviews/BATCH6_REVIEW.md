# 第六批审查（E-1 / E-4 + 收件箱 live 适配 + P1-13 + T-MCP-10）

- 日期：2026-10-25
- 审查方：Claude
- 被审对象：Codex 工作树 `research-foundation`，分支 `codex/p1-13-reconcile-inbox`，提交 `34348f8`，PR GuangjieYu1/ReinLab#19
- 依据：[BATCH5_REVIEW](BATCH5_REVIEW.md) 第 4 节

## 结论

**E-1、E-4、收件箱 live 适配、P1-13 通过，可以关闭。**
**T-MCP-10 未通过**：执行器在预估阶段漏传了价格配置，没有发出任何模型调用。已经修复，但需要用户**重新授权**一次真实复验。

## 1. 审查方亲自复核

| 项 | 方法 | 结果 |
|---|---|---|
| E-1 | **故意先跑** `VITE_BACKEND=mock pnpm build`，再跑 `REINLAB_REQUIRE_NATIVE=1 pnpm test`（Node 22.23.3，环境里去掉 key） | **1511 / 1511，0 失败、0 跳过**。上一批正是这个顺序导致 32 项原生测试失败或跳过，现已关闭 |
| 依赖边界 / 类型 | `pnpm lint`；contracts、control、worker 三个 tsc | 通过 |
| T-REG | 在 Codex 分支上跑 mock 模式全部 19 个场景 | **19 / 19**，包括审查方修改后的转场场景和新的问答收件箱 |
| 工作区 | 跑完以上各项后检查 | 0 改动 |
| 收件箱前端同步 | 看 Codex 的哈希记录与 diff | 7 个文件从主仓库原样同步；live 适配器按 `InboxAdapter` 实现：answers 原样转发、没有真实路由时 href 留空；Codex 自己写的 `LiveInbox` 界面已删除 |
| P1-13 发现角色 | 读 `202610240001_recovery_discovery.sql` | `reinlab_reconcile_discovery`：可登录、noinherit、不是超级用户、不可绕过 RLS，连接数上限 4；**只能 SELECT `account.id` 这一列**，策略只对这个角色生效；启动时用 `reinlab_assert_discovery()` 自检，只要多出任何表、列、序列、security definer 函数的权限，或者 account 表没开 FORCE RLS，就拒绝启动。符合 Q-086 的最小权限设计 |
| T-MCP-10 失败报告 | 读 `execution-facts.json`、`cost-reconcile.csv`、账单截图 | 卡在预估阶段（HTTP 503）；守卫还没创建，也没有 run、usage、模型转发标记，**模型调用 0 次**。专用 key 当天 0 请求、0 token、¥0.00；截图只显示筛选名「ReinLab」，不含 key 和余额。没有重试 |
| 凭据扫描 | 用当前专用 key 的实际值搜索（只数命中次数） | Codex 本机日志 0 处，工作树 0 处，git 全部历史 0 处，`.zshrc` 0 处。这次 Codex 也进过 DeepSeek 后台，没有再泄露 |

审查方**没有**亲自复跑恢复混沌测试（9/9）和真实浏览器测试（9 项），因为它们要起本地完整的 Hatchet 和 Supabase。这两项采信 Codex 的证据目录（`recovery/`、`inbox/`），以及独立安全评审。

## 2. 前端负责人做的改动（记录在案）

- **转场场景：** 原来用「转场帧数 ≥ 20」判断动画是否在播放，这个指标跟机器速度有关，在 CI 上误报失败（只录到 19 / 15 帧）。审查方作为前端负责人，改成三项与速度无关的检查：
  1. 真的到达了目标页面；
  2. 两段转场都录到至少 3 帧；
  3. 至少 3 种不同的帧，证明画面在动。

  这不属于 Codex 放宽测试。
- **Q-085：** 收件箱新增「回答 AI 的提问」（`InboxQuestion` / `answers`），以及「有真实路由才显示的回到原对话链接」（`href`）。

## 3. 观察（不阻塞）

1. **漏传配置：** T-MCP-10 失败的原因是临时控制面漏了 `pricingFromEnvironment(config)`。这暴露出冒烟入口和正式入口装配方式不同的风险。Codex 已经抽出 `createSmokeApp`，让两者共用同一条装配路径，方向正确。以后再写测试入口，都必须复用正式的工厂函数。
2. **测试并发：** 并行 worker 数从 4 降到 2。原因是本机同时跑真实数据库和多个原生内核时，资源不够用。这会让全量测试变慢，但所有断言都没改，可以接受。
3. **Q-088：** 撤销 PUBLIC 对两个统计视图的读权限。这是为了满足最小发现权限，不影响应用。等上云补验时，需要在托管 Supabase 上再确认一次。

## 4. 待用户决定

- **T-MCP-10 第二次授权：** 用新档案（建在 research@1.1.0 上）跑一次真实端到端：`papers.search` → 经用户批准的 `files.write` → `cards.card.finding`。预算 ≤ ¥1，单次执行，失败不重试，按专用 key 核账。上次没有产生任何调用、没有费用，执行器的问题也已修好。

## 5. 研究台第一期进度

16 个任务里已完成 13 个（P1-01 ～ P1-13），剩下：
- P1-14：自研的简报对话、数据集上传、评估集抽样标注；
- P1-15：`auto.study` 接入 OpenScience 的 Autoresearch，以及前沿曲线；
- P1-16：OCR 验收。DeepSeek V4 Flash 不支持多模态，按 DEFERRED 记为「待多模态模型」。

P1-14 和 P1-15 有大量前端：简报对话、评估集标注、运行矩阵 live。**前端由审查方先做**，并定好数据接口，Codex 再接上数据。

---

## 追加（2026-10-25 晚）：精读 live 接入（`1c064c7` / `adb8f17`）

**结论：通过。**

**审查方复核：**
- 先跑前端构建，再跑 `REINLAB_REQUIRE_NATIVE=1 pnpm test`：**1535 / 1535**；
- T-REG（Codex 分支，mock）：**20 / 20**；
- 跑完后工作区 0 改动。

**`src/data/read-live.ts` 抽查：**
- `anims: []`、`hasRepro: false`；
- 用量未知时 `unknownCost: true`；
- 追问推送「追问未接入，将在第二期 P2-05 接入」，不生成回答；
- 评分直接 throw「评分未接入」；
- 「派给群研」只提示未接入，不创建运行。

整体如实，没有编造。

**Q-097（`useRead` 卸载后残留订阅）：** 审查方已在主仓库修复。每次 effect 用自己的 `active` 标记；load 在卸载之后才 resolve，就不再订阅；`reload` 只在仍挂载时生效。

**三入口：** 已在主仓库完成。`ResearchStudio` 新增 `available` 参数；live 传入 `['read']` 后，群研、自研的入口置灰并标注接入期次，点不进去；派发只记下待办、不切换过去。预览方式：`?modes=read`。Codex 只需同步，并在 live 下传入这个参数。

### T-MCP-10 计划的两处缺口（必须修正后才能请求授权）

`NEXT_SMOKE_PLAN.md` **没有反映审查方 10-25 那次真实执行**（见 [T-MCP-10_CLAUDE_RUN.md](T-MCP-10_CLAUDE_RUN.md)）：

1. **记录要更正。** 旧的 `mcp10-authorized-20261024` 目录里，`RUN_KEY` 和 `model-forwarded.marker` 都是审查方那次执行留下的：真实 DeepSeek 调用 2 次，其中已定价 ¥0.004198，另有一笔用量未知；`papers.search` 成功，`papers.fetch` 卡在审批上，运行被取消。Q-095 和计划里「真实模型 0 调用」的说法只适用于更早那次预估 503，要分开写清楚，并补上这一次的核账。
2. **漏了 `papers.fetch` 的批准。** 计划里只写了批准 files.write 和 cards.card.finding。按 Q-070（「papers.fetch 由控制面落论文，至少 ask」），`papers.fetch` 也会请求批准。新计划必须对它同样做「能力名、requestId、argsHash、完整参数逐项核对后，单次批准」，参数是 `paperId` = 本次 search 实际返回的结果。另外 `smoke-mcp.ts` 的执行器断言里，也要把 `papers.fetch` 列进「预期的审批」。
