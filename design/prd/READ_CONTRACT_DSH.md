# 精读前端契约（DSH 内核）· Claude 定，2026-10-27

**界面契约不变**：仍是主仓库 `src/components/workbenches/research/read/readTypes.ts` 里的 `ReadAdapter` / `ReadEvent` / `RunView`，界面组件一行不改。
DSH 要做的是：把 `src/data/read-live.ts` 改成接 `/v1/kernel/*`。下面是映射表，字段以 `readTypes.ts` 为准。

## 方法 → 后端

| `ReadAdapter` 方法 | 后端 | 要点 |
|---|---|---|
| `load()` | 当前档案 + 最近一次 run：`GET /v1/kernel/runs/:id` + `events?after=0` 回放 | 失败时 **reject**，`Error.message` 写人能读懂的原因（F3） |
| `subscribe(on)` | 轮询或 SSE `GET /v1/kernel/runs/:id/events?after=seq` | 按 seq 去重；把事件映射成 `ReadEvent`（见下表） |
| `clarify(text)` | 没有 run：`POST /v1/kernel/runs {dossierId, query:text}`；有 run 且在等 `clarify_question`：作为这个提问的回答发回**同一个 session** | 同一档案始终一个会话（`resume=true`） |
| `pick(pickId, id)` | 回答 `clarify_question(kind=paper_pick)`；`id=null` 表示「都不是」 | 「换一篇」之后改选：只换掉选定的论文，**不调用模型** |
| `unchoose()` | 只清掉前端的 `run.chosen`，并通知后端 | — |
| `estimate(candidateId, budget)` | 不连预算系统：返回一个展示用的估算 `Estimate`（按页数粗估） | 不预留、不冻结 |
| `start(estimateId, budget)` | `POST /v1/kernel/runs {dossierId, query, chosenPaperId}` | 第一步出下载审批 |
| `decide(id, approve)` | `POST /v1/approvals/:id/decide` | 一张卡；重复提交返回同一回执 |
| `cancel()` / `cancelClarify()` | `POST /v1/kernel/runs/:id/cancel` | 返回 `cancelled` 之后再更新界面；`cancel_unconfirmed` 显示「停止未确认」 |
| `raiseBudget` | **不实现**（管控层已去掉预算） | 界面会显示「尚未接入」 |
| `ask` / `grade` | 照旧：如实说「未接入」 | — |

## DSH 事件 → `ReadEvent`

| `event.action`（kind=`dsh`） | 映射为 |
|---|---|
| `user/message` | `{type:'user', text}` |
| `assistant/message` | `{type:'agent', text}`：只取正文块，**不显示 reasoning**；`usage` 累加到 `run.spentCny`，缺失时 `unknownCost / clarifyUnknownCost = true` |
| `tool/call` `papers_search` / `papers_fetch` / `papers_pages` + 对应的 `tool/result` | `{type:'tool', action:'papers.search' 等, state: running→done/failed, label 用人话}` |
| `tool/call` `clarify_question` `kind=paper_pick` | `{type:'pick', candidates:[PaperCandidate…]}`，候选只取工具真实返回的 |
| `tool/call` `clarify_question` `kind=text` | `{type:'agent', text: question}`，并标记「在等你回答」，下一次 `clarify(text)` 就作为回答发回 |
| `kind=approval` 或待审批列表 | `{type:'approval', …}`，一次动作一张 |
| 卡片工具 `cards.card.layer` / `quiz` / `finding` | `layer` / `quiz` / `finding` 事件，再加 `paper` / `section`（页码原文） |
| `turn/end reason.kind` | `run.state` 和 `endReason`：`completed`→done/`completed`；用户拒绝下载→`rejected`；取消→`cancelled`；只拿到摘要→`abstract_only`；其他→`failed`，并带 `message` |
| `llm/retry*`、`step/*`、`request/*`、`session-log-*` | 不显示（可以计入进度） |

## 验收时看什么（B1）

就是 PRD 里的 8 步，Claude 用 `scripts/walkthrough/research-read.mjs` 走真实页面并录屏。第 7 步（发现卡）以页面上真的出现 `.rd-finding` 为准。
