# Runtime API / main / 本地bootstrap 独立审查

限定HTTP及启动配置源码暂未见新增P1/P2：runtime-api13+pricing-environment2独立15/15，runtime-api-pricing-regression.json；旧API/main-bootstrap组合57/57，main-bootstrap-regression.json。sink晚step另已68/68关闭。整体native尚失败，不能凭这些unit宣称闭环通过，见独立native报告。

HTTP：全v1先JWT authenticated/账户存在和RLS；submit只收空body、由run_harness模型/快照及active状态确认，HTTP mutate新work创建后提交再调用pipeline，重放只回收据。decide先幂等header+strict body，再事务外fresh validate；prepare在同httpidem事务，dispatch事务外且SDK sent fence负责未知不重发。cancel仅绑定service身份及durable fence。回调异常保已接受202并只写固定错误码；不回显SDK/header。harness proposeClient/decideClient与http_request同事务，随机proposal不在重放中另建。DTO只选公共run字段、配置不出prompt/memory，审批effects递归删路由身份并scrub，foreign租户隐藏。GET recover仅读accepted active binding，不送模型prompt。

生产main：默认RuntimePipeline使用真实factory与immutable loader，无fixture依赖注入；HTTP连接必须DATABASE_URL_APP并在createApp assertSafeRole，provisioner只拿专用角色。实际价格显式完整currency/window/UTC validFrom/Until+固定7.2；完全缺窗口保持null，部分/非法配置503，禁止猜日期/节假日/币种或补旧价格。shutdown停止新HTTP、关闭观察/worker、强制结束残留SSE连接后pool.end，日志稳定code。

bootstrap仅local setup导入，受控127.0.0.1带端口postgres路径、禁止query/hash，supabase_admin只在迁移和受信publishBench期间使用并finally pool.end。返回给HTTP的是reinlab_app连接，worker是reinlab_provisioner；snapshot专用writer JWT，不用service_role替代。runtime.env不含管理员URL；真实DeepSeek路由+显式FX，无fixture模型。未读取任何实际env文件/密钥、未运行localup或真实账户操作。

## 后续修复收口状态

原生失败根因已确定为observer replay后同步旧snapshot的时序错误。root授权docker_driver作者修复，78/78+tsc/lint通过，原native修复后1/1；详见stale-snapshot-fix-report.md。当前仅等待root/另一agent对作者修复独立复核，不再将原native未定位作为现状；历史失败记录保留。
