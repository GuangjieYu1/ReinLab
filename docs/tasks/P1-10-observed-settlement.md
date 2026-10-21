# P1-10 观察用量内部结算

## ToSpec

```ts
export async function settleObservedRun(
  client: pg.PoolClient,
  accountId: string,
  runId: string,
  complete: boolean,
): Promise<{eventSeq: number; settled: boolean; costCny: string | null; reconciled: boolean}>;
```

调用者提供已开启的账户作用域事务 client；不在此函数开启独立事务、调用模型或接受金额、holdId、credentialKind、配额、GPU。complete 必须是真 boolean，表示可信控制面的终态观察及所需回放已完整；不能取模型文本、工具输入或公开 HTTP 请求中的标志。本入口不增加 HTTP 路由。

1. **可信绑定**：核对当前 app.account_id，持有账户 ledger/budget advisory lock；查询并锁定 os_binding，绑定必须 accepted、有 hold_id，run 不能 queued。hold 必须属于同一 account/dossier/run。不寻找其他预留，不释放他人预留。
2. **用量来源**：从本 run 的 os_usage 冻结行按 event_seq 关联不可变 event，逐行核对 session/account/dossier/run、kind='cost'、费用（包括 null）一致。不能过滤掉错误行后只汇总剩余行。同一 seq 不可被不同 part 重复引用；本 run 的全部 cost 事件必须有且仅有对应 usage。metadata 中的金额不参与结算。
3. **unknown**：complete=false、没有 usage、任一 usage.cost_cny=null、合计为 0，均以 costCny=null/api_key 结算，hold 保持 unpriced 并按原逻辑暂停，不能把已知部分当最终总额或当免费。
4. **一致性拒绝**：缺失/异作用域/非 cost/金额不符的 ledger、重复引用、未被 usage 覆盖的本 run cost，统一抛 `OBSERVED_USAGE_INVALID`/409，事务不得有结算变更。缺绑定或越租户为 `RLS_DENIED`/404；phase/hold/queued 未就绪为 `OBSERVED_RUN_NOT_READY`/409。非 boolean complete、非 UUID run 为 `INVALID_INPUT`/400。
5. **精确汇总**：仅 complete=true 且所有可信行有效、非 null、正合计时，使用 PostgreSQL numeric SUM 和 BigInt 定点结算；不读取上游浮点 cost，不重算历史价目。aggregate 范围为 numeric(18,6)，超过单个 cost 事件上限仍可入预算累计；汇总或 ancestor spent 越界则 `USAGE_RANGE_INVALID`/503，不能截断。
6. **不重复 cost**：观察器逐 step 已写 cost ledger，终态只新增 kind='gate'、costCny=null 的 `os_usage_settled`（或 `os_usage_reconciled`）汇总。payload 的 actualCostCny 是摘要；账本 cost 合计不会再次增加。仍复用原预算 hold、ancestor allocation/run spent、overrun、warning、pause 逻辑。此阶段 quota/gpu 固定为 0，不信任模型 metadata。
7. **兼容**：settleTool 仍用 Settlement.strict 与单笔金额上限；legacy hash/content、cost action/dedupe、receipt 和重放行为保持。只有私有 settleAmount 可选择汇总方式，外部 mode/ledgerMode 字段不能切换。
8. **幂等与对账**：相同可信总额重放/并发调用返回原收据，spent 与汇总不重复。内部 hash 带 os_usage 来源，隔离 legacy 收据。已 settled 后总额变化冲突；unpriced 后可信完整正金额可 reconciliation 一次。usage 写入和终态结算须同持账户 ledger lock；observer 应按 part 将 cost 与 usage 原子写入。调用方必须在同一事务调用并负责提交/回滚。

## schema 依赖

root 提供的 `202610200005_runtime_observation.sql`：os_usage 的 PK 为 account/session/part；复合 FK 绑定 account/run/session；event_seq 引用对应逐 step cost seq。应用角色只允许 SELECT/INSERT，强制 RLS，禁止改写/删除历史 usage。绑定的 hold_id 由 trigger 验证同 account/dossier/run 并冻结。event_seq 本身非 UNIQUE，因此函数还检查 DISTINCT seq 数量。测试使用真实迁移，不建替身表。

## ToTDD 与结果

先完成设计接口 red（缺 export，1 failed/2 passed）；真实 PG fixture 初次命中004 role_options约束、第二次命中 SQL 参数推断，均分别保留 setup-failure，不计功能红灯。修正 fixture 后行为 red 为 23 failed/3 passed：所有真实 fixture 可建立，缺函数导致预期结算失败，原 strict 与数据库异 hold 拒绝通过。随后才改 budget 实现。

真实 PG16 + 非特权 reinlab_app/RLS 的新增测试 31 项，加原 budget 34 项，合计 **65/65**。覆盖：

| 边界 | 验收 |
|---|---|
| 两条微额、重放、并发 | 精确总和、所有 allocation 累计一次、gate/null、不新增 cost |
| incomplete/missing/null/zero/混合未知 | unpriced/null、保留并暂停、无部分结算 |
| 先不完整再完整、已结算后新 step | 对账一次；不同终值冲突 |
| 异 cost/kind/run/null、重复 seq、漏 cost | 稳定一致性拒绝、无结算变更 |
| 1200000 汇总与 legacy 同额输入 | aggregate 全额累计并暂停；legacy 仍拒超单笔上限 |
| ancestor 资金链含父 run | 三个 allocation、父子 run 同步累计且重放不重复 |
| 已有累计到 numeric 上限 | 稳定范围错误、无变更 |
| 回调事务主动回滚 | hold/spent/gate/pause 整体恢复，后续重试成功 |
| queued/未接受/无 hold/缺绑定/越租户/异 hold | 拒绝；RLS 隐藏 usage；数据库拒改写、删除和异 hold |
| 非 boolean、外部 mode | 在 DB 调用前拒绝 |

普通测试本身不写证据；仅显式 CLI outputFile 归档到本次目录。原生模型、真实账户容器、前端与既有 estimate 均不在本任务范围。证据见 `evidence/P1-10/observed-settlement/README.md`。
