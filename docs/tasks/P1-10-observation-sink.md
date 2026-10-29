# P1-10 ObservationStore sink 闭环

ToSpec：提供冻结sink(account,run)，cursor通过BindingStore.get读已提交值；ingest/gap委托已有事务。failed只记录白名单稳定码、不记录原error，设置永久usage_uncertain并unknown结算，活跃run暂停；已ended且known-settled的latefailure no-op。synchronize严格核对session/run/request、拒latest<cursor、不修改cursor、不造os_observation sequence。pending/indeterminate消失过期，未终态run interrupted；快照终态独立gate runtime_snapshot_reconciled/source=snapshot。latest>cursor终态视history不全；仅completed、history完整、usage_uncertain=false且无消失卡时可已知结算。failed/cancelled/interrupted终态保留实际状态、hold仍可unpriced；completed未知才paused_budget。既有ended与新终态矛盾稳定RUNTIME_TERMINAL_CONFLICT，不改状态或费用。

ToTDD：先真实PG红，覆盖既有ingest非completed终态被预算pause覆盖的回归、sink委托、失败幂等/脱敏、latefailure、快照已知/未知/缺history/非completed/去重、审批消失、保留livepending、scope/cursor/terminal冲突/RLS；然后实现，仅改ObservationStore和新测试，保留原3项+独立7项。

## 接口与结果

```ts
sink(accountId: string, runId: string): ObservationSink;
failed(accountId: string, runId: string, code: string): Promise<void>;
synchronize(accountId: string, runId: string, snapshot: unknown): Promise<void>;
```

snapshot只解析有界session/run/request/state/latest与pending标识，不存任意原始snapshot/model/error字段。锁序为ledger账户锁→binding→run；ingest/gap也补run锁。结束时间非null时新终态必须相同（paused_budget+ended只对应completed未知费用）；冲突抛RUNTIME_TERMINAL_CONFLICT/409并整体回滚。快照gate独立source=snapshot，保持原cursor/os_observation；同来源安全摘要已存在直接no-op。费用明细仍只来自os_usage，快照/故障不造cost单据。

有效red16/16失败：其中3项真实复现failed/cancelled/interrupted被预算pause覆盖，另13项缺接口。实现首轮新增16+原core3+独立7=26/26；补expiredpending导致已定价usage也保持未知、及整个同步事务回滚后，最终新增18+原core3+独立7+observer27+scheduler8=**63/63**。Node22 control tsc、pnpm lint、diffcheck通过。未改main/app或SDK；实际原生+DB闭环由root集成，独立评审另交root安排。

## 独立 P2 终态后新用量修复

独立late-step-red.json在已completed/settled之后注入新的顺序step，复现ledger 0.005600而run.spent 0.002800（7绿1红）。保留该独立红，修复位于原event去重/历史基线判断之后、所有投影写入之前：任何已ended运行的新step-finish（含缺tokens/非法tokens）抛LATE_USAGE_AFTER_TERMINAL/409并整体回滚，不追加cost、usage、不移动cursor，不把新费用静默当0或称已核实。原已记录event仍可正常重放去重。已ended的新accepted拒绝；矛盾终态仍RUNTIME_TERMINAL_CONFLICT；相同终态不重新计费、不复活运行。

这是本批协议异常的保守处理：原生内核终态后不应出现新的step，用量需要人工核对，不能自动重新打开已结账hold。store公开稳定409；observer仍遵守既有非cursor持久化异常包装合同，不改变其自动重试范围。新增4项后作者sink22+core3+独立8+observer27+scheduler8=**68/68**。control tsc/lint/diffcheck复跑通过。独立原始红未覆盖。
