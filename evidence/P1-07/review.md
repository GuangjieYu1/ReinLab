# P1-07 独立代码评审

评审日期：2026-10-19。工作树：`codex/p1-07-budget`。本轮结论：**暂不通过，1 项 P2 阻断；修复并回归后复审。**

## 范围与依据

已核对 `docs/tasks/P1-07.md`、Q-021～024、实现合同 §4/§6/§8.3/P1-07、PRD G2/G3、验收 X1/X2/X5/X7 与 CH-6。审查预算 index/money/pricing、预算 API、账户/档案预算视图、共享 schema 与迁移 0006～0009。

六位 BigInt 金额、显式模型路由/汇率 fail-closed、固定 models.dev live 工厂、目录哈希与 token 假设、10 分钟估算、单次消费唯一索引、模式/角色限制、queued 持久化前 scrub、账户事务锁、真实结算与未知 API null 暂停、额度/GPU 单列、FORCE RLS、不可更新估算表与 hold 复合外键均已逐项阅读。未发现 live 测试价目或当前调用模型的路径。

## 阻断 R1：[P2] 子划拨未扣父自身在途费用预留

位置：`services/control/src/budget/index.ts` 的 `allocateBudget` 父余额检查与 `growPath` 父余额检查（本轮约 54～55、65～67 行）。

父预算可用额只扣 `spent_cny` 与子划拨尚未消费的余额，没有扣父自身 `budget_hold.state in ('reserved','unpriced')` 的 `maximum_cny`。因此已授权给父工具的同一资金仍可承诺给子运行；`growPath` 追加子额度也存在相同遗漏。账户锁能串行化操作，但无法纠正余额公式。

独立真实 PG 回滚探针（非 mock）：新建隔离账户/档案，预算根与父运行各 ¥10；切换受 RLS 约束的 `reinlab_app`，设置事务局部账户。依次调用父 `authorizeTool(maximumCny='8')`、`allocateBudget(child, amountCny='10')`、父 `settleTool(costCny='8')`，再调用子 `authorizeTool(maximumCny='10')`。观察：

```json
{"parentHoldAllowed":true,"childAllocationCny":"10.000000"}
{"childFullBudgetAuthorization":{"allowed":false,"reason":"BUDGET_EXCEEDED"}}
```

已成功划拨的 ¥10 子预算实际只能使用 ¥2。下游祖先检查避免了新工具直接越限，但用户已确认的子预算无法兑现，且被错误暂停，违反“子预算来自父未划拨余额”和先预留最大费用的要求。整个探针最后 `ROLLBACK`，临时脚本已删除，未留下测试业务数据。

建议余额公式同时扣除父自身仍有效的 hold；子节点 hold 已包含在子剩余划拨中，避免重复扣除。对子初次划拨及追加预算分别补回归：父先 hold、再划拨/追加；父已 unpriced；先划拨后父 hold；并发 hold 与划拨。父剩余资金不足时应拒绝划拨或按明确追加操作增长祖先/月额度，不能静默重复承诺。

## 验证边界

本轮独立验证为源码/DDL 审查与真实本地 PG 回滚事务，未改实现、前端或上游，未输出凭据。父 agent 报告的 25/25、95.5% 行覆盖与 tsc/lint 成功不是本轮重新执行结果；独立测试 agent 的结论另列。未连接 Supabase/Fly、未验证云部署、真实提供方账单或模型执行；queued 行为不得表述为模型已执行。后续修复复审应追加在本文件，保留本轮记录。

## 第二轮复审（2026-10-19）

首轮 R1 **关闭**。新增 `unallocated(client,node)` 将子剩余划拨与该节点自身 reserved/unpriced maximum_cny 分别扣除；初次划拨、子预算增长、档案预算准备、新月父预算增长均使用同一公式。没有把子 hold 在子剩余划拨之外重复扣除。新月续期的在途检查已递归覆盖旧 allocation 子树。

独立真实 PG 回滚探针观察：

```json
{"r1":"BUDGET_EXCEEDED","parentBudgetAfterChildIncrease":"11.000000","quotaGpuChildAllowedBeyondParent":true,"descendantPendingRenewal":"USAGE_PENDING"}
```

具体场景：父 CNY 10、hold 8 时子初次申请 10 被拒；子初次分配 1 后追加 2，父预算正确增加到 11；父自己的 hold 已结清而仅子 hold 仍 reserved 时，模拟下一 UTC 月，父续期被 USAGE_PENDING 拒绝。使用真实本地 PG、事务局部 reinlab_app 与账户上下文，整笔回滚，临时脚本已删除。另独立重跑父预算测试 **26/26 通过**，报告为 `review-rerun-parent-suite.json`。该范围未发现人民币修复回归。

### 新增阻断 R2：[P2] 额度/GPU 未随父子预算划拨或共享限额

当前 `authorizeTool` 对 quota/GPU 仅检查当前 run 的累计、预留和限额；`allocateBudget` 的 allocation 只有 CNY，子预算创建或追加不会从父额度/GPU余额扣除，结算也不把这些用量计入父预算消耗。不能把现状描述为三类预算均已完成层级控制。

判断依据：PRD D4 明确“预算从委托方划拨”，对应 `research_request@1.budget` 明确包含 cny/quotaRuns/gpuMinutes（合同 §5、PRD 附录）；Q-024 规定三类预算显式追加、子预算使用父未划拨余额及祖先限额同步。“独立计量”应解释为不换算人民币，不能解释为子运行可获得不受委托来源限制的额外额度。账户月上限当前只定义人民币，并不自动要求凭空增加账户月额度/GPU上限；本项要求的是已确认来源运行/委托预算的父子约束。

同一回滚探针中，父 run quota_limit=1 / gpu_limit=60，父工具已预留 maximumQuota=1 / maximumGpuSeconds=60；子 run quota_limit=2 / gpu_limit=120 仍成功通过 authorizeTool(maximumCny=0, maximumQuota=2, maximumGpuSeconds=120)。即父已确认上限之外额外获准 2 次及 120 秒，人民币路径正确也无法阻止这类用量。需要为两种独立量实现父子额度的划拨/预留/结算/追加/跨月规则，或以明确且可执行的策略拒绝当前无法从来源预算授权的子级用量，不能仅更新说明为“独立计量”后称全部通过。

**本轮最终结论：仍暂不通过，R1 已关闭，R2 待修复。** 本地人民币修复与回归已验证；云部署、真实提供方账单、模型执行等首轮验证边界不变。

## 第三轮复审（2026-10-19）

**最终结论：本地 P1-07 实现评审通过；R1、R2 均关闭，未发现新的阻断。** 保留上述首轮、第二轮历史结论及复现过程，以本轮状态为准。

本轮审查新增 `budget/quantities.ts`、预算主流程三维整合、迁移 0010～0012 与 Q-026/Q-027。运行/委托来源节点有明确的 quota/GPU 上限；子划拨扣除父已消费量、其他子剩余授予量及父自身仍在途的残余用量。未知根上限保留 null，未捏造账户会员/GPU 月总额。委托量读取 request.budget；追加向上增长来源节点且使用 touched 集合使同一决定对每个 run 只增加一次 revision。结算向祖先累计、费用账本仅写实际调用 run；预算视图继续只计根。

### 独立验证

真实本地 PG 单事务隔离账户，事务局部切换 reinlab_app 并设置账户上下文，直接调用实际实现；最后 ROLLBACK，临时脚本已删除。观察：

```json
{"rootUnknown":{"quota":null,"gpu":null},"parentUsage":{"quota_runs":"1","gpu_seconds":"60","state":"running"},"costEventCount":1,"r2":"BUDGET_EXCEEDED","unknownFamilyState":["paused_budget","paused_budget"],"restoredFamilyState":["running","running"],"postRestoreAllowed":true}
```

场景：父上限 2 次/120 秒，子获 1 次/60 秒且真实结算后，父累计为 1 次/60 秒，全账户费用事件仅 1 条。父对剩余 1 次/60 秒做在途预留后，另一个子节点申请 1 次/60 秒被 BUDGET_EXCEEDED 拒绝，关闭 R2。父回报 API cost=null 后，给已暂停子节点追加额度/GPU，父子仍保持 paused_budget，不能通过追加绕过未知费用。父真实对账后，再经用户显式追加，父子恢复 running，子下一次工具预留成功。

另独立重跑父 34 条与独立测试 14 条，**48/48 通过**，JSON 为 `review-r2-suite.json`。其中覆盖三维额度父子保护、祖先100%暂停、追加版本/恢复、跨档案委托来源、显式根上限、身份修改拒绝、数据库环检查及两笔 600000 实费累计为 1200000 的账本精度。此为本轮实际执行结果，并非转述父 agent 结果。

### 迁移与精度审查

0010～0011 回填层级 quota/GPU 实耗及 run 跨周期累计，并要求非根节点有明确量上限；0012 收紧可更新列，禁止应用改来源身份和 hold 原始上限，触发器限制循环及深度。应用预算增长所需 amount_cny/quota_limit/gpu_limit 仍有列级更新授权，不应误述为“上限列也完全不可更新”。累计解析改用 numeric(18,6) 范围，外部单笔实费仍限制 numeric(12,6)；费用账本单笔记账，不随祖先传播重复生成费用。静态检查及本地已迁移数据库上的回归未发现迁移/精度阻断。本轮没有另建空库作独立 fresh migration 验证，不将其描述为已完成。

### 保留边界

本轮未改实现、前端或上游，未打印凭据。父报告的 97.23% 覆盖和双 tsc/lint 不是本轮重新运行结果。48 条为本地真实 PG/HTTP 测试，不等于 Supabase/Fly staging 验收；真实提供方账单对账、云环境隔离及实际模型执行仍待配置和后续阶段。P1-07 创建真实 queued 运行，不表述为已执行 prompt。

## 测试清理补充评审（2026-10-19）

仅审查 `services/control/test/migrate.test.ts` afterAll 将 `DROP DATABASE ... WITH (FORCE)` 改为普通 `DROP DATABASE` 的单行改动，预算实现未改。**通过，无新增阻断。**

测试先等待 `isolated.end()` 关闭该测试自有连接池，随后通过连接基础数据库的 bootstrap 删除 UUID 命名的隔离测试数据库；不存在应强杀业务连接的需求。删除 FORCE 可避免清理阶段主动终止残余连接产生 57P01；若仍存在连接，普通 DROP 会显式失败，将连接泄漏暴露为清理失败。此改动没有吞异常或放宽迁移断言。这里确认其清理策略合理，不把一次通过推断为已证明所有并发清理时序。

独立实际执行 `migrate.test.ts`：**1/1 测试通过，退出码 0，未报告未处理异常**，证据 `review-migration-cleanup.json`。该测试在新建的真实隔离数据库中验证原子回滚、幂等、并发迁移和内容篡改拒绝；本轮没有重跑全仓 549 条断言，也不将其表述为已通过完整 P1-07 空库迁移。历史全仓 cleanup 异常证据保留，由父 agent 的新全仓回归另行确认。
