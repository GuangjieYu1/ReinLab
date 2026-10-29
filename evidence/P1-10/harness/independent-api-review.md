# Harness API 独立审查

当前有3项有效红待修，不能通过。independent-harness-api.test.ts为真实PG/RLS +本地catalog fixture，不修改生产或原测试；independent-api-red.json为最初1绿2红，追加route后independent-api-route-red.json为1绿3红。

1. HTTP相同Idempotency-Key重放返回已保存201，但外层无新建标记，onRunQueued会重复调用；独立vi计数2，应1。回调本身从独立admin连接可读到run_harness，确认当前顺序已在事务提交之后。
2. 回调抛错时HTTP500，但run/预算/run_harness/HTTP收据已提交。应保留持久创建收据并以稳定诊断记录调度故障；不能诱导未知模型变更重发。
3. 服务端真实model route改变但manifest tier不变时，旧报价仍确认201。报价.model未与当前可信route核对，run_harness也未钉实际route；loader之后按新环境tier路由选择模型，报价与执行可能不同。root确认P2，计划011增加运行model_route绑定并固定loader authority。

已通过边界：tier/defaultBudget来自有效manifest slot/budget而非旧research角色三元表；改变manifest配置后旧quote409且无新增run。create确认时持账户ledger锁，校验quote归属/模式/tier/入口role/digest/expiry，estimate一次消费；run和immutable run_harness及预算/ledger同提交。008含账户/档案/run复合FK及account/digest/bench/versionFK、RLS+FORCE、只SELECT/INSERT、不可改删trigger。

此报告不把HTTP回调执行等同于实际SDK发送完成；queued后续恢复需显式安全调度，未知结果仍按binding send fence只读恢复。等待root修复后独立复验。

## 修复独立复核

三项P2已关闭：new1+独立4+旧budget34独立39/39通过，independent-api-green.json。回调只在本次mutate work实际新建且成功提交时触发，HTTP旧收据重放不会触发；异常保留201并写固定ADMISSION_DEFERRED ledger error，不回显异常。新增严格正向断言读出run_harness.model_route=fixture/model，并核回调失败ledger只有稳定payload；限定独立4/4复跑 independent-api-route-ledger-green.json。

确认报价时与PricingService受信route(tier)核对，不同route即409无run；011新增model_route由创建同事务保存，008不可变trigger继续保护，不回填猜测旧route。模型固定loader增量独立12/12通过另见run-definition-review.md。
