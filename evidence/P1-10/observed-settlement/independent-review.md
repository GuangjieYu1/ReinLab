# 观察费用内部结算独立审查

结论：当前 settleObservedRun 模块通过，未见 P1/P2。独立复跑原预算34项与 observed settlement31项，65/65 通过，见 independent-regression.json。未修改预算实现、原测试或迁移。

入口只收账户/run/boolean complete，先检查账户事务上下文并持 ledger advisory lock，锁定 accepted binding、run 和其 hold；hold 的账户/档案/run 三者须一致。费用以不可变 os_usage 与 event 数值为准，LEFT JOIN 不会过滤错误行；逐行核对 session/dossier/账户/run/kind/null-aware金额，DISTINCT event_seq 和全部 run cost 数量保证重复引用、漏 cost 都拒绝。metadata 金额不参与结算。

SQL numeric SUM 转 BigInt 微元，全量完整、无null且正金额才结算；缺失/incomplete/zero/null 统一 unknown/unpriced，不能以部分已知金额冲账。聚合上限 numeric(18,6)，既有单笔 strict 上限保持；在 mutation 前预检所有祖先 allocation/run 范围。内部汇总只写 gate/null，逐 step cost 不再重复入账。配额/GPU固定0；来源hash隔离 legacy。账户锁和 hold 收据处理并发重放，unpriced→完整只对账一次；事务失败整体回滚。

独立复验覆盖精确微额、并发/幂等、完整性冲突、原工具严格输入、RLS、不可变 usage、绑定错误hold、120万聚合与祖先链、上限拒绝、主动rollback及后续重试。另 independent-observation 真实PG测试覆盖观察写入与cursor事务失败时 usage/cost/checkpoint 一起回滚、并发重复event/part仅一次费用。

接口属于可信控制面内部，complete 必须来自真实终态/回放完整性；此结论不把公开HTTP参数视作可信标志，也不覆盖尚在接线的controller。observer中发现的历史replied审批仍pending为另项P2，记录 observation-independent。
