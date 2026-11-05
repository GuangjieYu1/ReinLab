# 交付 · 群研 MVP-3 第三批（精读关联 / 跨台委托 / 首例全流程）+ B16

分支 `codex/swarm-3`，一个提交。契约 13 没改；前端 `02a3d69` 没动。

## B16

- 负责人这一轮在跑时控制面**只排队**（插件在步骤边界 steer），不再用 JSON-RPC 另排一份到下一回合。
- `swarm_inbox.delivered_at` 与回执里的钟点都用**消息真的出现在会话里那一刻**（事件时间）。

## 精读关联（契约 §2）

`POST /v1/swarm/runs/:id/claims/:claimId/read { evidenceId }` → `{ readDossierId, href, resumed, readRunId }`。
同一 (跑, 结论, 版本, 证据) 只建一次精读档案，再点 `resumed: true`；精读档案是 `research/reading`，
新 run 带 `chosenPaperId`；关联记在 `swarm_read_link`；已结束的运行不改已发布报告。

## 跨台委托（契约 §6）

**首个源台：探索台（`exploration`）**（理由：它在本仓已有完整档案与活动流，探索时冒出的问题交给群研最自然；
精读在本仓是 `research` 的 reading 档案，不算跨台）。四个接口 + 结果卡（`approval(kind='delegation_result')`，
`effects[0]` 是 `DelegationResult`）；按 Idempotency-Key 幂等；采用只在源档案记一笔。
`delegation` 表在退掉 openscience 时被删过，这次按 MVP-3 重建（`202611050002`）。

## 首例全流程：真机走完了，花了 ¥6.31（< ¥8）

| 项 | 结果 |
|---|---|
| 委托 → 建研究档案 → 开跑 | **通**。源档案 `35f6dadc`（探索台）→ 委托 `efe3f613` → 研究档案 `19e9b7c6`、运行 **`c47beab1`** |
| 不同路线 | **通**。计划 3 条路线 |
| 真实反驳与核实 | **通**。29 条结论 / 27 条审查，**17 条已核实**（报告 `verified: 17`） |
| 中途改方向「只看相同总 token 预算下的比较」 | **通**。负责人交了 **plan v2**，带 `diffFrom`（问题、范围都变了） |
| 范围卡 | **通**。`swarm_scope` 卡 `7ca94198`（from 1 → to 2，带 changes） |
| 分歧卡 | **通**。`swarm_divergence` 卡 `9555456f`（3 条有争议，各带主张/反驳两方） |
| 正式报告 | **通**。`report.state = partial`、`verified 17`、`disputed 3`、有 `answer` |
| 精读关联 | **通**。结论 `20e76ae4` + 证据 `7a35c0c6` → 精读档案 `701a3fa6`、精读运行 `8b3fbb98`（`href /dossiers/701a3fa6`） |
| 结果卡 → 采用 | **通**。结果卡 `ca0eb78b`「群研结果：第 1 版」；`decide adopt` → `{state:'adopted'}`，源档案里出现「采用了群研对「多 Agent 数量增加是否一定提高研究质量？」的结果（委托 efe3f613）」 |
| 刷新/重起不丢不重复 | **通**。中途两次重起控制面：结论从 18 条继续长到 29 条、审查 14 → 27，id 不重复，运行按「已从中断恢复」继续 |
| 到限追加建议 | **没走到**。这条运行为控制预算在 ¥6.31 时由用户结束，没到 30 分钟的 80%，所以 `report.nextSuggestion` 是 null；`near_limit` 与建议在第二批的 `7bb9e6da` 上验过 |

**问题卡的答复路径**（上一轮卡住的地方）：`POST /v1/kernel/approvals/:id/answer { text }`。
用它答了澄清卡之后，负责人立刻交了计划，首例才走下去。

## 顺手修的两处（都会影响验收）

1. **群研卡不再被「运行结束」顺手作废**：内核在回合结束时会把 run 名下 `pending` 的卡标成 `expired`，
   而群研的范围卡 / 分歧卡 / 委托结果卡的意义正是「运行结束之后由人决定」。现在这几种卡不受这条清扫
   （已作废的那三张已恢复成待处理：范围卡 `7ca94198`、分歧卡 `9555456f`、结果卡 `ca0eb78b`）。
2. **结论详情带出精读关联**：`GET …/claims/:id` 多了 `reads: [{evidenceId, readDossierId, readRunId, href, mode}]`，
   前端不用再猜哪条结论开过精读。

## 验证

`services/control` + `packages`：**607 条全绿**。新增：精读关联只建一次、委托幂等与采用。

## Claude 可以看

- 首例运行 **`c47beab1-21ab-49f1-9c13-b87c0098ccd7`**（研究档案 `19e9b7c6`）：29 条结论、17 条已核实、plan v2 + diffFrom、
  范围卡与分歧卡各一张、精读档案 `701a3fa6`。
- 源档案 **`35f6dadc`**（探索台）：委托 `efe3f613` 已采用，活动里有那一笔；
  收件箱里「群研结果：第 1 版」是结果卡（`delegation_result`，`effects[0]` 是 `DelegationResult`）。
