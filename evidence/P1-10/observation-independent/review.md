# ObservationStore / observer 独立审查

当前结论：ObservationStore 有一项 P2 待作者修复，未完成通过；纯读端 observer 范围暂未见独立 P1/P2。

真实 PG16/RLS：原3项加独立6项，共8通过/1有效失败，见 first-report.json；随机 fixture 账户与run，无真实账户操作，没有修改实现/原测试/迁移。新增 independent-observation.test.ts 默认不写证据，只显式CLI outputFile归档。

P2：permission.asked 经同会话实时snapshot确认后建立pending；随后正常 permission.replied 已映射resolved并推进cursor，但 ingest 对 resolved 不更新approval，卡片仍pending。该历史/外部回复既不能留可操作pending，也不能据此自行标approved。root已确认无控制面intent/receipt时应过期并保留诊断，有未知控制面决定则保持indeterminate等待核对。新增末项断言不pending且不approved；等待修复复跑。

通过的独立边界：6并发相同event仅1cost/1usage；同part重复事件不双计；持久cursor写入前故障让已插入usage、cost和observation整体回滚，重试成功；外国租户ingest/gap拒绝、RLS隐藏usage、usage/observation update/delete42501；run身份不符拒绝；cursor gap永久usage_uncertain并paused_budget/unpriced，后续terminal不结算已知部分；uncertain不可洗回false；历史asked无实时pending证明只建expired，匹配实时snapshot才能pending。

源码：账户事务内先持ledger锁和binding行锁，cost/usage/approval/checkpoint同提交；session/run与绑定receipt核对，role/toolGrants来自冻结binding；不包含模型send/permission决策write port。pricing只采明确有效时间窗及observed来源，未知source/malformed part标不确定，费用不按上游浮点cost。预算独立65/65通过另见observed-settlement/independent-review.md。

纯读消费者 observer.ts：独立复跑25/25，observer-regression.json。先snapshot→持久cursor→replay→synchronize→按成功提交cursor订阅；每条await持久化，sink失败立即停止不自动重放；500/1000ms有限重连，abort清定时器；expired用新snapshot单独gap事务，ahead拒回退；审批asked前刷新snapshot，无prompt/决定权限；同session/run且合法映射terminal才停止。原生协议与真实DB接线由root单独集成验证，25项fixture通过不替代它。

## 修复独立复核

历史审批 P2 已关闭。作者添加 resolved 分支：无 decision_hash 的 pending→expired；有控制面intent hash 的 pending→indeterminate；均不制造 approved。独立原断言不pending且不approved通过，另新增有intent普通fixture严格断言indeterminate。原有效失败 first-report.json 保留。

最终：ObservationStore原3+独立7及最新observer27，共37/37通过，final-green-report.json。新增CURSOR_GAP恢复仅允许从sink.ingest的两个稳定gap code进入；事务失败和其他sink失败仍立即停止，不会当reader故障盲重放。gap恢复使用fresh snapshot、持久cursor核对、事务gap、synchronize后有限重连，ahead拒回退。
