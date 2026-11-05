# 交付 · 群研 MVP-3 第一批（审查与门禁、多轮推进）

分支 `codex/swarm-3`，一个提交。契约 13 的接口与语义没改；前端没动。

## 这一批做了什么

**审查（`research_review_claim`，PRD §5）** —— 反驳 / 补证据 / 独立核实 / 降级四种，参数：`claim_id`、`claim_version?`、`kind`、`verdict`（`upheld` / `rejected` / `verified` / `not_verifiable` / `pending`）、`reason`、`evidence[]`（核实必填）、`task_id`。规则：
- 不能审自己交的结论；反驳过同一条的人不能再给它签核实（反驳与核实分人分任务）。
- 核实必须自己回原始出处核，把核到的证据（来源 + 章节/表号 + 摘句）一起交上来，只复述反驳意见会被拒。
- 每条结论最多两轮反驳，改版本不重置计数；第三轮直接拒，并提示「还有分歧就按有争议呈现」。
- 核实**绑定版本**：改主张或证据后旧核实作废（门禁只认 `verified_version == 当前版本`）。
- **这一版还有没解决的反驳时不能签核实**（409 `VERIFY_OPEN_REFUTE`）：先改主张/补证据出新版本，或者让反驳者撤回。不做这一条，「已核实」和「有争议」会同时落在同一条结论上（真机里抓到过一次，见下）。
- 状态走：候选 →（独立反驳）待核实 / 有争议 →（独立核实）已核实 / 证据不足 / 已证伪。每次审查推 `review` + `claim` 两条事件，并落一条通信。

**多轮推进（PRD §3）** —— 轮次和阶段由服务端推进：`run.round` 每轮 +1，`run.phase` 前 2 轮 `independent`、第 3 轮起 `cross`。第 3 轮起的续跑提示里带**精简 Context Packet**（PRD §4）：只放已核实结论和明确负结果，一条一句（结论、适用条件、来源），不转别人的会话，也不转工作目录。

**额度与收尾（PRD §3）** —— 活动时长达 80% 时进 `near_limit`（仍在跑），`report.nextSuggestion` 给「新发现 / 剩余缺口 / 建议追加多少」。真正到限或任务收齐就停：不再新增任务，保存阶段结果。
自动结束时若还有「有争议 / 已证伪」的结论 → `awaiting_review`（等你看分歧；分歧卡在第二批），不硬写成完成。用户主动「结束」时按 `partial` / `final` 收尾，分歧列在 `report.disputed`。

**报告门禁（PRD §5 末）** —— `report.state`：运行中 `stage`；自动结束有分歧 `awaiting_review`；结束且只放已核实结论时 `final`（无遗留）或 `partial`（还有候选/缺口）；一条核实都没有 `unresolved`。`answer` 取「已核实证据最多的那条」的原文，没有就是 null。没通过核实的进 `unverified`，争议进 `disputed`，证据不足与适用条件进 `limits`，负结果进 `negative`，缺口进 `gaps`。

## 前端要吃的东西（形状，和契约 §1 一致）

- 快照 `claims[].status` 会有新值：`verified` / `disputed` / `insufficient` / `falsified`（外加原来的 `candidate` / `awaiting_refute` / `awaiting_verify`）；徽标按它显示。
- 快照 `claims[].reviews` 是审查 id 列表，`snapshot.reviews` 是 `Review` 对象数组；`Review` 就是契约 §1 那个形状（`id / claimId / claimVersion / kind / by / reason / evidenceIds / verdict / round / taskId`）。
- 结论详情 `GET …/claims/:id?version=` 返回 `{ claim, evidence, reviews, task, member }`：`reviews` 是这条结论**跨版本**的全部审查（谁、哪一版、判定、理由、核到的证据），`claim.reviews` 是同一批 id，`claim.evidenceIds` 是这一版的证据。
- 汇总 `GET …/report` 字段与契约 §1 的 `SwarmReport` 一致；`state` 的取值含义：`stage` 运行中 / `awaiting_review` 自动结束仍有分歧 / `final` 正文只有已核实且无遗留 / `partial` 有已核实但也有候选或缺口 / `unresolved` 一条核实都没有。

## 真机效果（能直接打开的一条）

运行 `95bdf46e-8450-4c62-ab38-e145763f75df`（档案 `2cbbc5d3-0892-4443-82e4-203273e47d48`，真模型，4 轮 / 30 分钟额度，约 ¥5.29，已结束）：

| 看到什么 | 数字 |
|---|---|
| 候选结论 | 26 条：`verified 5 · awaiting_verify 7 · candidate 11 · insufficient 1 · disputed 2` |
| 审查记录 | 32 条：`verify/verified 14 · refute/rejected 11 · refute/upheld 5 · verify/not_verifiable 2`（其中一条「同一版先被反驳成立、又被签了核实」的结论已经按新规则改回「有争议」，所以已核实从 6 变 5） |
| 多轮推进 | 第 1 轮 → **第 2 轮**（`phase=independent`），轮次由服务端推进 |
| 报告 | `state: "partial"`、`verified 5`、`disputed 2`、`unverified 13`、`negative 6`，`answer` 是最强那条已核实结论的原文 |
| 缺口 | 三条路线各自写明「这次群研结束时这条路线的任务还没全部交付」 |

## Claude 怎么验（页面上）

1. 打开上面那条运行。留言板「发现」栏里每条结论带状态徽标（候选 / 待核实 / 已核实 / 有争议 / 证据不足）。
2. 点一条**已核实**的结论：详情抽屉里 `reviews` 有独立核实记录（谁、判了什么、理由、核到的证据），证据是核实者自己回原文找的那条。
3. 点一条**有争议**的结论：能看到反驳记录（谁、理由），状态是「有争议」，并且没有核实记录。
4. 汇总面：`verified` 只放已核实的 5 条，`answer` 是其中证据最多的一条；`disputed` 2 条、`unverified` 13 条、`negative` 6 条分开放；候选不再出现在正文。
5. 想验「改版作废旧核实」和「两轮反驳上限」：这两条只有工具侧能触发（`research_submit` 带 `claim_id` 出新版本 / 第三次 `research_review_claim kind=refute`），页面上看到的是结果——改版后那条结论回到「候选」、已核实列表里消失。

**这批没在真机上跑到的**：
- `near_limit` 与 `nextSuggestion`：这条运行到 80% 时长之前就手动结束了；逻辑有单测（活动时长 85% 时进 `near_limit`、`nextSuggestion.rounds=2` 且 `why` 带「剩余缺口」）。
- 第 3 轮的 `cross` 阶段与 Context Packet：这条运行只推进到第 2 轮（再跑两轮成本更高）；阶段切换与 Packet 内容有单测。
- `awaiting_review` 的**自动**路径：这条是手动结束的，所以是 `partial`；自动到限且有分歧的路径有单测。

## 验证

`services/control` + `packages`：**592 条全绿**（新增 2 条：审查与门禁全流程——不能审自己、核实必须带证据、反驳者不能签核实、两轮上限、改版作废旧核实、报告分区；多轮推进——轮次/阶段/`near_limit`/`nextSuggestion`）。
