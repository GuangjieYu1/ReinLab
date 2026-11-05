# 交付 · B17 复验回退（范围卡被清扫作废）

分支 `codex/swarm-3`，一个提交。契约 13 没改；前端 `d937d4f` 没动。**用现有数据复现，没有另花钱。**

## 是哪段代码改的

`services/control/src/kernel/lifecycle.ts` 的**超时清扫**：`reconcileAccount` 把「`pending` 且
`created_at` 早于 TTL（默认 24 小时）」的审批一律标成 `expired`，没有任何 kind 过滤。
三张范围卡是 11-04 建的，到 11-05 就过了 24 小时，收件箱一刷新（每次都会被触发）就被扫掉——
`7ca94198` 留了 `approval.expired(reason: timeout)`，另外两张是同一批 update 命中的（事件按
`lifecycle-expired:<id>` 去重，重复清扫不会再补一条，所以看起来「没有事件」）。
不是清结果卡时连带改的：结果卡那几条走的是另一个分支（已结束任务名下），那个分支之前就排除了群研。

## 改法：群研卡只由用户决定或被新卡替换

四处会写 `approval.state='expired'` 的清扫，全部加上「群研四种卡（`swarm_*`）与委托结果卡
（`delegation_result`）不参与」：

1. `reconcileAccount` 的超时清扫（这次的根因）；
2. `reconcileAccount` 的「已结束任务名下的卡」；
3. `reconcileAccount` 的「没有执行者的孤儿运行」；
4. `reconcileOnStartup` 的两条（超时 + 已结束任务）。

内核 `onState` 那条（回合结束时清卡）在 B17 里已经排除了这两种卡。

## 恢复

三张范围卡已恢复成待处理（`decided_at`/`decided_scope` 清空）：
`7ca94198-4cbf-4723-b4ad-b3c93b907bff`（首例）、`13e92fc8-af4a-4b4f-b3d7-78369ce69bf7`、`4f74ec66-7f9b-42d6-9416-caa3ef7fe930`。
恢复后再刷新几次收件箱（每次都触发清扫），它们仍是 `pending`。

## 怎么验（现有数据）

1. 收件箱现在有 4 张待处理：三张「问题范围变了，需要你确认」+ 一张「报告前还有分歧」；
2. 反复刷新页面（每次都会触发一次清扫）：这四张不会被作废；
3. 点一张范围卡批准 / 驳回，或让它被新卡替换——这是它们唯一会消失的方式。

## 验证

`services/control` + `packages`：**609 条全绿**。新增一条：48 小时前创建的四类卡里，
普通 `question` 卡按超时作废，`swarm_scope` / `swarm_divergence` / `delegation_result` 必须仍是 `pending`。
