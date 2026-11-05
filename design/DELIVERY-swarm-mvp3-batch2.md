# 交付 · 群研 MVP-3 第二批（干预与收件箱四种新卡）+ 三处小改

分支 `codex/swarm-3`，一个提交。契约 13 的接口与语义没改（四种卡照 §5 把字段放在 `effects[0]`）；前端没动。

## 先修的三处小改

1. **`report.answer` 优先具体发现**：核实员 / 负责人写的汇总、进度类（正文以「独立核实汇总 / 本批 / 阶段小结 / 进度…」开头）排在具体发现后面，只有没有具体发现时才用它。
2. **`nextSuggestion` 的剩余缺口不再混进路线合并说明**：合并掉的路线（`state=merged`）不进缺口，「重复登记 / 已并入 / 同一条路线」这类说明也被滤掉。
3. **`Background subagent … finished` 不再进通信时间线**（连系统条目也不记）。

## 四种干预

| 干预 | 行为 |
|---|---|
| `mention` | 投递给指定队员（经负责人的会话转达），干预状态 `delivered`，通信面留一条 `user → 队员`；如果是暂停中，顺手把运行恢复成 `running` 再投递 |
| `redirect` | 标记「改方向待新计划」，提交一轮让负责人出**新版本计划**；新版本交上来**自动继续**（不再等确认）。**只有原问题本身变了**（不是收窄口径、措辞包含）才出 `swarm_scope` 卡并停在等确认 |
| `add_member` | 不直接建人：出 `swarm_add_member` 卡 `{role, routeId, model, count, membersAfter, max:16}`，干预转 `pending_approval`；批准后交回负责人用 `research_spawn` 建人 |
| `extend` | 出 `swarm_extend` 卡 `{findings, gaps, suggest:{rounds,minutes}, used}`；批准时可在 `answers` 里改数值，额度直接加到 `limit_rounds / limit_minutes` 并继续 |

`mention` / `redirect` 没有文字会被拒（400 `INTERVENTION_TEXT_REQUIRED`）；契约里没有的干预种类照旧 400。

## 四种收件箱卡

`swarm_add_member`、`swarm_extend`、`swarm_scope`、`swarm_divergence` 全部走 `/v1/approvals`：

- 列表里**群研卡原样返回结构化 `effects[0]`**（外加一份人话 `lines`），前端照契约渲染卡面即可。
- 页面与收件箱同一张卡：`POST /v1/approvals/:id/decide` 由群研服务处理（`decideCard`），重复提交返回 `APPROVAL_CONFLICT`。
- **去重**：加人卡、追加额度卡同一运行同时只留一张待处理（卡上的数字会随时间变，按内容去重会越点越多）；范围卡、分歧卡按内容去重。
- **不会被顺手作废**：`kernel/lifecycle.ts` 原来会把「底层 run 已结束」名下的待处理卡标成 `expired`；群研一回合结束、收件箱一刷新，刚出的加人卡就没了。现在群研的卡不参与这条清扫（补了测试）。
- `swarm_scope` 在「改方向后新版本计划的原问题变了」时自动出卡，卡面是 `{from, to, changes}`，运行停在 `awaiting_confirm` 等批。
- `swarm_divergence` 在「自动到限但还有有争议/已证伪的结论」时自动出卡，卡面是 `{claims:[{id,text,sides}]}`；**批准 = 再查一轮**（轮次 +1、回到 running），**驳回 = 按「有争议」写入**。

## 真机证据（能直接打开的一条）

运行 `c1ab09ec-87aa-4e65-b9a7-5c4673b18b77`（档案 `55717eee-086a-4622-ada0-bf07c7d5c7f8`，真模型）：

1. `mention` → `delivered`、「已投递给 r1-scaling，等它回应。」
2. `add_member` → `pending_approval`，收件箱里能看到 `swarm_add_member` 卡，`effects[0] = {role:"researcher", count:1, model:"deepseek-v4-flash", membersAfter:7, max:16}`；30 秒后卡仍在（早先那张被清扫作废、现在不会了）。
3. 批准加人 → 卡 `approved`，干预 `add_member: applied`。
4. `extend` → 出卡 `{suggest:{rounds:2,minutes:15}, gaps, findings, used}`；批准并在 `answers` 里给 `{rounds:2, minutes:20}` → 额度从 **4 轮 / 30 分钟变成 6 轮 / 50 分钟**，运行继续。

## 三处小改的真机复核

- `answer` 在运行 `7bb9e6da` 上已经换成具体发现（「把 LLM 用作评审器给 MAS 输出打分本身就带系统性偏差…」），不再是原来那条「独立核实汇总（task-6）」。
- 同一条运行的 `report.gaps` 里已经没有「重复登记 / 已并入」这类路线合并说明。
- 新运行 `c1ab09ec` 的通信面里 `Background subagent …` 条目为 **0** 条（系统条目 23 条都是真的系统事项）。

## 这批没在真机上跑到的

- `swarm_scope` 卡：要负责人先交一版「原问题变了」的计划（要再跑一轮模型）。分类逻辑（收窄口径不出卡、问题本身变了才出卡）有测试。
- `swarm_divergence` 卡：要运行自动到限且仍有争议。卡面与两种回答有测试。

## 验证

`services/control` + `packages`：**600 条全绿**。新增：四种干预与四张卡（含批准后额度变化、去重、范围卡分类）、answer 选具体发现、缺口不含合并说明、群研卡不被清扫作废。
