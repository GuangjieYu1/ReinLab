# ObservationScheduler 独立只读评审

结论：通过。本次未发现P1/P2阻断；未修改scheduler生产代码。

复核范围：observation-scheduler.ts、既有8项测试、observer.ts与binding/reader边界，及docs/tasks/P1-10-observation-scheduler.md。独立重跑8/8，报告scheduler-independent-green.json；control tsc与边界lint通过。

- L17–34：bindingRow在db.withAccount事务内受RLS及定义hash验证；只对accepted、存在receipt、running/waiting/paused_budget且未ended提供目标。recoverable只查传入已认证账户，reader再次校验并仅返回RoleRuntime.reader()窄面。没有跨账户枚举或模型提交路径。
- L50–68：账户+run去重，活动并发1～32（默认4），排队项仅在空出活动槽后进入访问层；相同run结束后释放key，允许后续经状态检查恢复。
- L70–85：目标账户/运行一致性校验在reader前，observer只获reader/session/run/sink/signal。外层不把observer三次耗尽包成无界重试；异常不记录原始文本，logging callback抛错仍finally释放所有权。
- L88–93：先closed、abort所有任务，排队项直接完成且不会再启动SDK；活动项await其reader/observer退出。既有测试覆盖主动订阅abort、排队不启动及关闭后不再接单。

证据局限与范围：仅真实fixture PG的RLS/绑定验证加读端口fake协议；不宣称真实模型或生产main接线。该模块界定进程内活动并发，未声明队列总容量/跨进程唯一观察所有权；全局无人值守恢复与长期队列由P1-13负责。shutdown是等待已持有调用完成的优雅退出，不声称可强制取消任意DB调用。上述与本批ToSpec一致。
