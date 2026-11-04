# 交付 · 群研 B15 修复（一条消息只投一次、一张卡只加一人）

分支 `codex/swarm-3`，一个提交。契约 13 没改；前端 `02a3d69` 没动。

## 改法

**1) 取即领走，一条消息只投一次**

- `swarm_inbox` 加 `handed` 状态：`pendingFor(..., claim=true)` 改成
  `UPDATE … SET state='handed', handed_at=now() … RETURNING`——**取到就领走**，下一个工具边界再取也拿不到它。
- 插件侧按消息 id 兜底去重（`steeredIds`）：同一个 id 即使被重复下发也只 steer 一次。
- 送达仍是「会话里出现这条 user/message 才写 delivered」；`handed` 也会被这条确认覆盖。

**2) 一张加人卡只对应一次建人**

建出一名之后，把这张卡关掉（`approval.state='approved'` + `consumed_at=now()`），
再要加人必须另出卡、等用户批准——不会再因为同一条指令被多次投递而连建多人。

**3) 单测**

- 插件侧：同一条待送消息连续经过 5 个工具边界，只被 `agent.steer` 一次（`swarm-plugin-inbox.test.ts`）。
- 控制面侧：`pendingFor(claim=true)` 第一次取到、第二次取不到，库里是 `handed`；
  加人卡建出一名之后 `approved` 且 `consumed_at` 已写（`swarm-blackboard.test.ts`）。

## 真机（运行 `52b40a8e`，**¥1.91**，在你给的 ¥2 以内）

负责人跑第一轮时（名册 6 人：负责人 + 3 研究员 + 1 反驳 + 1 核实）：
- `@r1-scaling`「只看同预算那一格」；
- 批准一张**要 critic** 的加人卡（卡 `4256d73a`）。

结果：
- 两条待送消息各自在 `agent/inbox/spliced` 里只出现 **1 次**（上一版是反复插入 41 次）。
- `swarm_inbox` 两条都是 `handed`（领走一次就不再发）。
- 名册 **6 → 7**，多的正是 `critic-2`（第二名反驳），没有多建。
- 加人卡已关掉：`state=approved`、`consumed_at` 已写。
- 干预回执：`add_member: applied`「已建出反驳员 critic-2（反驳员 02）：这个角色的人数已经超过原计划编制（2 > 1）」；
  之后补上的送达确认让 `mention` 也变成 `delivered`（两条收件箱记录都已是 `delivered`）。

**送达确认也一起修了**：上一版读的是 `payload.message.content`，而 `user/message` 的事件说法是
`{id, role, source, content}`，正文在 `payload.content` —— 取错了地方，所以消息明明进了会话、回执还停在
「已排队」。现在改成独立的一次核对（取快照时跑），直接查这一 run 的 `user/message` 正文里有没有这条消息；
重启后、历史运行上也会补上。重新打开运行 `52b40a8e` 现在看到的是：
`mention: delivered（已送到，对方在这一轮里看到了）`、`add_member: applied`、加人卡 `consumed`、名册 7 人。

## Claude 的复现步骤

1. 打开运行 `52b40a8e`：名册 7 人（2 名反驳）；干预里 `add_member: applied`；加人那条指令在会话里只出现一次。
2. 自己走一遍：确认计划后在负责人忙时 @ 一名队员、批准一张要 critic 的加人卡 →
   期望名册**正好多一人**，不会连建；`swarm_inbox` 里两条很快变成 `handed`，然后（会话里出现后）变 `delivered`。
3. 想再要第二个：必须再出卡、再批准。

## 验证

`services/control` + `packages`：**605 条全绿**。
