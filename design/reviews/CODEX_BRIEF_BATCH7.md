# 给 Codex 的开场（第七批：精读对话澄清 + 前端同步 + T-MCP-10 计划修正）

你好，Codex。第六批（含精读 live 接入）已审查通过，见 `design/reviews/BATCH6_REVIEW.md` 和末尾的「追加」一节。这份是第七批的完整说明。下文说的「主仓库」都指 `/Users/guangjieyu/Documents/DeepSeekPlugin/ReinLab`。

**分工照旧：** 前端由 Claude 负责。你同步 Claude 的组件、实现 live 适配器和后端，不改界面的样式和交互。

## 一、先读

1. `design/RESEARCH_LIVE_FRONTEND.md`：特别是新增的「先对话澄清，再预估」一节，以及更新后的方法表和事件映射表。
2. `design/reviews/T-MCP-10_CLAUDE_RUN.md`：审查方 10-25 那次真实执行的记录。
3. `design/DEFERRED.md`：「模型分档」一条新增了澄清对话的说明。本批不涉及，只需要知道。

## 二、本批任务（按顺序）

### 1. 从主仓库同步前端（原样同步，逐文件记录哈希）

- `src/components/workbenches/research/read/`：`readTypes.ts`、`useRead.ts`、`mockRead.ts`、`ReadMode.tsx`、`read.css`。
  - 其中 `useRead.ts` 已修复 Q-097：每次 effect 用自己的取消标记，卸载后才 resolve 的 load 不再订阅。
- `src/components/workbenches/research/ResearchStudio.tsx`：新增 `available` 参数（三入口方案）。
- `src/components/inbox/InboxPanel.tsx`：没有待办时，文案从「已清空 · 处理了 0 件事」改为「无待办」。
- `e2e/legacy/scenarios/20-read-run.mjs`：精读场景，已改为「对话澄清 → 选论文 → 预估 → 确认 → 运行」。

### 2. live 下的三入口

给 `ResearchStudio` 传 `available={['read']}`。群研、自研入口会置灰，并标出在哪一期接入，点不进去；「派给群研」只记下待办、不切换过去。**不要另写占位界面。**

### 3. live 适配器补齐新接口

按 `RESEARCH_LIVE_FRONTEND.md` 的方法表实现：
- `clarify(text)`、`pick(pickId, candidateId | null)`、`unchoose()`；
- `estimate(candidateId, budget)`：改为按选定论文的页数预估；
- `start`：运行目标是 `run.chosen` 这篇，第一步就是 `papers.fetch` 的审批，不再检索；
- `run.clarifySpentCny` / `clarifyCapCny`：如实上报。

`ask` 和 `grade` 在 P2-05 / P2-06 之前，仍然如实返回「未接入」。

### 4. 后端：新增「澄清」角色

- **角色：** 在研究台清单中新增 `research-clarify`。因为改动了清单，要**发布 research@1.2.0**：旧档案仍钉在原版本，新档案默认用 1.2.0。
- **模型：** 便宜档，也就是现在的 DeepSeek V4 Flash。
- **预算：** 固定上限 ¥0.05，**不弹确认**。达到上限就停下，推一条 `agent` 说明，不能偷偷超支。
- **能力：** 只有 `papers.search`，只读公开元数据、不下载，最多 6 轮。
- **候选：** 用原生 question 交给用户选（映射为 `pick` 事件）。候选要带 title、authors、venue、access、pages。**AI 不能替用户选。**
- **审计：** 澄清的用量照样记账，但和正式精读的运行**分开计费**。

### 5. T-MCP-10 记录与计划的两处更正

1. **更正记录：** 旧锁目录 `mcp10-authorized-20261024` 里的 `RUN_KEY` 和 `model-forwarded.marker`，来自审查方 10-25 那次真实执行：DeepSeek 调用 2 次，已知 ¥0.004198，另有一笔用量未知；`papers.search` 成功，`papers.fetch` 卡在审批上，运行被取消。请把这次和更早那次「预估 503、0 调用」分开写，更正 Q-095 和计划里的说法，并补上这一次的核账（按 ReinLab 专用 key）。
2. **补上 `papers.fetch` 的批准：** 在 `NEXT_SMOKE_PLAN.md` 和 `smoke-mcp.ts` 里，`papers.fetch` 也要「能力名、requestId、argsHash、完整参数逐项核对后单次批准」，参数用 search 实际返回的 paperId，并把它列进执行器的预期审批。

**本批不执行任何真实模型调用。**

## 三、送审

完成以上五项后停下送审，附上：
- **测试：** Node 22 / 24 全量结果；
- **前端回归：** T-REG 20 / 20；
- **真实后端：** 精读浏览器测试结果，包含「对话澄清 → 选论文 → 预估 → 确认」这一段；
- **凭据扫描：** 按实际值扫描的报告；
- **CI：** 终态；
- **新增问题：** questions 摘要，需要用户决定的放在最前面。

真实复验（T-MCP-10 和澄清对话的真实体验）等用户另行授权。
