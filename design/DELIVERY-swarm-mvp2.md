# 交付 · 群研 MVP-2（黑板：候选结论 + 证据 + 阶段结果）

分支 `codex/swarm-2`，一个提交。契约 13 的接口与语义没改；前端没动。

## 三个研究工具的参数

负责人和队员都装这三个（同一套参数），提交人由插件按会话带上自己的名字，模型不用填。

**`research_submit`** —— 把产出交到黑板；先落库，再标任务完成；按 `submission_id` 幂等。
| 参数 | 说明 |
|---|---|
| `kind` | `claim` / `negative` / `evidence` / `question` / `answer` / `help` / `decision` |
| `submission_id` | 幂等键；重试同一次提交要原样带上（不给就插件生成一个） |
| `task_id` / `route_id` | 属于哪个任务 / 哪条路线（route 不填就用你自己登记的路线） |
| `claim` | `{ text, basis: checked_fact\|source_claim\|inference\|observation, conditions[], claim_id?, negative?: { searched, scope, not_found } }`；`claim_id` 给了就出新版本 |
| `evidence[]` | 每条 `{ source: { kind: paper\|web\|code\|data\|proof\|other, title, ref, asset_id?, version? }, locator: { section?, quote?, page?, lines? }, access, how }` |
| `text` / `to` / `answer_to` | `question`/`help`/`decision`/`answer` 的正文；`to` 指定接收者；`answer_to` 指向被回答的留言 |

校验：结论必须引用至少一条证据，或者带 `negative`（找过什么、没找到什么）；空泛进度直接拒。`locator` 按用户 2026-11-03 的决定写「章节 / 表号 / 图号 + 原文摘句」，页码可缺、缺了不降级、也不许编。

**`research_query`** —— 按路线 / 任务 / 版本增量读，分页。独立阶段（前 2 轮）研究员只拿到自己那条路线的结论，**在服务端裁**（反驳、核实、负责人不受限）；进第 3 轮转交叉阶段后自动放开。返回 `{ phase, scope, claims, evidence, posts, routes, truncated }`。

**`research_register_approach`** —— 登记路线与方法族：方法族 + 标题归一化后相同的不新开；标阻塞要写 `blocked_reason` 或 `gap`；重开一条阻塞/停止的路线必须写 `reopen_reason`（新机制），否则拒。

配套的接口与事件（契约 §2/§3 阶段 2）：`GET /v1/swarm/runs/:id/claims/:claimId?version=`（结论 + 证据 + 任务 + 队员）、`GET …/evidence/:id`（证据 + 引用它的结论）、`GET …/report`；事件新增 `claim`、`evidence`、`report`（阶段结果变了才推，和上一条一样就不推），并补上确认后立刻推的 `route`（E6）。真机验收那条运行的实时流里实际出现了 `claim` 26 帧、`evidence` 61 帧、`route` 9 帧、`post`、`report`。快照里的 `claims` / `evidence` / `report` 都是真内容。

## 怎么在真实运行里看到候选结论和证据

1. 研究档案开群研 → 澄清 → 计划卡确认（编制 1+3+1+1）。
2. 队员会先检索、读全文，再用 `research_submit` 交结论（`route=r1/r2/r3`）。跑起来后：
   - 留言板「发现」栏 = `snapshot.claims`（`status` 一律 `candidate`）；点开走 `claims/:id`，能看到它引用的证据、来自哪个任务、哪个队员。
   - 点证据走 `evidence/:id`，能看到哪几条结论引用了它。
   - 汇总面 = `report`：`state: "stage"`、`verified: []`、`answer: null`，候选进 `unverified`，负结果进 `negative`，窗口期缺口在 `gaps`。
3. 黑板里同一来源 + 同一版本 + 同一定位只记一条证据；两条结论引用同一条证据时，证据详情里 `referencedBy` 会有两条。

## 断线或重起后结论不重复的复现步骤

1. 跑到已经交出至少一条结论，记下 `claims` 的 id 与数量。
2. 刷新页面（或断网几秒）：`GET /runs/:id` 的快照里结论条数不变、id 不变。
3. 重起栈（`pnpm local:up22 --real-models`）后再取快照：结论、证据、引用关系都在；运行变成 `paused · 已从中断恢复`，继续时同一份产出不会重记（提交按 `submission_id` 幂等，证据按去重键合并）。
4. 想直接验幂等：让某个队员对同一份产出重复提交（同一 `submission_id`），第二次返回第一次的 id，`claims` 不新增。

## 本批顺带修的（MVP-1 验收的「剩下的小问题」）

- 同一条消息不再既记「已发出」又记「已收到」：发出时记一条，收到方那一份到达时把同一条升级成 `received`。
- 系统自动发的「继续」、建队提示词、`用户已回答这次提问` 不再显示成 `user → lead`；`Background subagent … finished` 不再显示成队员发给负责人的消息（先按正文认噪音，再谈归属）；重复的系统条目只留一条。
- 从头回放事件流与分页时间线的通信条数一致：SSE 每拍把能取到的取完（之前一拍 200 条封顶，回放会少）。
- 计划已经确认、负责人还在上一回合里说「计划还卡在待确认」时，不再把那句当它现在的话展示，改成一条系统说明。
- `swarm-api.test.ts` 时好时坏（`Cannot use a pool after calling end on the pool`）：收尾前先等这一 run 的回合都结束。
- 额度不足时结束原因写清楚「模型账户额度不足（QUOTA）」，不再是笼统的「这一轮执行失败」。

## 验证到哪一步（重要）

- `services/control` + `packages`：**586 条全绿**，连跑两轮。新增 `swarm-blackboard.test.ts` 五条：提交与追溯（结论→证据→任务→队员）、同来源同定位去重、提交幂等、无证据又无负结果被拒、独立阶段只看得见自己路线（反驳/负责人不受限、第 3 轮放开）、路线登记（同义不新开、标阻塞要原因、重开要新机制）、四栏留言、以及三个新接口的形状（含 404）。
- 真机上确认了的：三个工具装到了负责人和队员两档；`research_query` 在实际运行里按角色裁剪（研究员拿到 `scope: route:r2（独立阶段只给自己这条路线）`，负责人是 `all-routes`）；`research_spawn` / `research_task` 把路线、父任务、角色登记进黑板；确认计划后立刻推 `route` 事件；快照里 6 名成员、6 个任务、3 条路线；`report` 端点在栈上返回 200 且 `verified` 为空。
- **链路真跑过一遍（不花模型钱）**：新建了一个只做链路验证的运行（档案 `a621182d`、运行 `fd0b2f81`，标题就写着「黑板链路验证」），用内核运行令牌直接打 `/kernel/tool`，也就是插件实际走的那条路：交计划 → 登记三名队员 → 交两条结论（各带证据）→ 同一条 `submission_id` 重试 → 发一条问题。结果：快照里 2 条候选结论、1 条证据（两条结论引用同一条，证据详情 `referencedBy` 两条都在）、1 条留言、2 条路线；`report` 是 `stage`、`verified` 为空、`unverified` 2 条、`sources` 1 条；结论详情能拿到 `section: "Table 2"` + 原文摘句、作者与依据类型。这条停在 `awaiting_confirm`，页面上可以直接看「发现」栏与证据详情。

- **真机验收跑（模型自己交的）**：档案 `c35a7a20`、运行 `65c0133f`，真模型、试用账户，约 ¥2.08。确认计划后 6 名成员（1 负责人 + 3 研究员 + 反驳 + 核实）跑了两轮多，**模型自己调 `research_submit`** 交了 **26 条候选结论 / 61 条证据 / 3 条留言**；作者分布 `r1-scaling 9 · r2-topology 7 · critic-1 3 · verifier-1 4 · r3-measurement 2 · lead 1`，依据分布 `checked_fact 14 / inference 9 / source_claim 2 / observation 1`，负结果 5 条。
  - 可见范围按阶段自动切换：前两轮交的 13 条是 `lead_reviewers`，第 3 轮起交的 13 条是 `all`。
  - 证据去重：24 条引用落到 21 条证据（一条被 3 条结论共用、一条被 2 条共用），证据详情 `referencedBy` 逐条都在。
  - 结论详情能一路追：`§5.1 Generalizability` 这类章节 + 逐字摘句（页码按你的决定留空）、来自 `task-5（delivered，route r1）`、作者「研究员 01（数量轴）」。
  - 汇总：`state: "stage"`、`verified: []`、`answer: null`、`unverified 26`、`negative 5`、`sources 61`；结束时写「已交付的产出保留，但没有经过核实的结论」，成员全部 `idle`。
  - 这次还抓到一个真 bug 并修掉：**路线收尾只推了事件、库里仍是 `active`**，页面会一直显示「进行中」；现在收尾会落库成 `stopped`（有测试）。
- 本轮还修了 E3 余项：`Background subagent … finished` 即使带发送者会话，也不再记成队员发给负责人的消息（真机里抓到过两条）。
