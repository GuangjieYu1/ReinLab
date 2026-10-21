# main/bootstrap/observer时序增量独立只读评审

结论：本次限定新增composition、临时冒烟配置与observer时序修复**通过，未发现P1/P2阻断**。未改生产，未跑native或真实模型，未读取secret/env状态文件。此报告不代替整批完成、真实账户基础设施及账单验收。

作者边界：本人曾实现factory/materialize/definition/pipeline及HTTP薄适配，本报告不对这些作者范围自批。HTTP只核root新增budget确认/queued回调逻辑与main调用点；api/runtime.ts/app.ts适配的独立结论由docker_driver负责。

## 源码核对

- main.ts17–28：构造RuntimePipeline只传经runtimePricingFromEnvironment验证的窗口，无factory/definition/test transport注入；createApp拿同一pipeline。缺价格窗口保持undefined/unknown，部分或非法配置拒绝。HTTP application先验证非特权DB角色；auth-worker独立启动，不把provisioner连接交给HTTP。shutdown先关闭新HTTP入口、停止观察与worker，再结束pool，重复signal有停止标志；源码未增加自动模型submit。
- tooling/local/control.ts只加载受保护runtime配置再import main；local-bootstrap.ts27/46保留127.0.0.1本地admin范围，先既有迁移再从可信仓库load/publishBench。bench_version发布仍走只追加内容校验；HTTP不import admin bootstrap，不将supabase_admin能力传入应用。
- api/budget.ts94–247：模型tier/入口从有效Harness取得；确认quote.model与当前受信pricing.route(tier)一致，同一事务写run_harness.model_route。queued回调只在mutate work新建并成功提交201时触发，HTTP idem旧收据不回调。交付异常保原201，固定ADMISSION_DEFERRED ledger，不保存原异常。该root逻辑的独立既有4项复跑全绿。
- observer.ts141–169：replay逐条await持久化之后重新snapshot并读取已提交cursor。latest<cursor稳定CURSOR_AHEAD；相等才synchronize/terminal判断；snapshot较新则从真实已提交cursor subscribe补事件，不把可回放历史错误当gap或用旧快照结算。permission/question asked仍即时snapshot，terminal仍先ingest成功再退出；没有prompt、decide或cancel端口。gap/有限退避/abort/sink故障边界未放宽。
- RoleRuntime.configureSmokeGateway仅是可信CLI管理能力，未进reader或HTTP port；新dedicated账户预检connected providers/配置内apiKey，避免覆盖已有凭据；origin限host.docker.internal，127只test可用。并发busy与cleanup重试围栏保留，保存/恢复原始全局配置后移除临时DeepSeek auth，失败不假称清理成功。此方法不接真实upstreamKey。
- smoke-local.ts201–235：真实DEEPSEEK_API_KEY只从宿主受保护文件交给startOneShotSmokeGuard.upstreamKey；发给容器SDK auth.set的是新randomBytes(32)临时token。容器reachability probe无Authorization，不消耗marker。pipeline仍默认生产factory，无test dependency/live fallback；脚本为显式CLI，不被main/test/CI自动import执行。
- one-shot-smoke-guard.ts31/250/315–343：上游固定官方DeepSeek HTTPS，redirect:error；test transport仅NODE_ENV=test；私有宿主bind、恒时临时token比较、strict请求形状与64KiB/输出1024边界。文件独占marker在转发前写入并fsync文件/目录，重启/并发/未知结果均不能再转发；不打印或返回upstreamKey，只将它放入官方上游Authorization。status/证据不含key；失败响应稳定码、不回显异常。schema/source预留不构成网关部署。

RLS/schema：bootstrap发布走独立admin本地初始化，main application仍reinlab_app；本次未放宽角色/grants、租户FK/immutable schema，也未把external HTTP role/model/session字段传成执行权限。当前新安全模块均已经正常换行/缩进；不要求以格式例外放宽lint。

## 独立执行

Node22.23.3，本机fixture PG和fake HTTP/transport，全部无需native：

- pure-regression.json：**130/130**（observer27 + 独立stale-snapshot3 + runtime临时gateway12 + one-shot guard19 + smoke-plan12 + pricing environment2 + 既有API39 + local-independent16）。
- queued-callback-regression.json：**4/4**独立Harness API回归。
- control tsc与边界lint通过；未改静态规则。

source-sha256.json记录本次只读核对的10个明确源码文件摘要，未读取任何secret配置值。本人没有把自己未运行的native结果混入上述纯测试计数；role_independent_test按root安排独占native复跑。已只读看到observer/independent-race-review.md追加原生1/1通过，属于另一审查者结果，不是本次本人复跑。

## 保留边界

本报告不证明主机上的最终镜像/Supabase migration已完成新生产链路验收；不证明真实DeepSeek账单已核对。one-shot护栏的本地测试只验证约束、一次转发与未知不重试，实际调用/账单属于root显式冒烟步骤。main的优雅shutdown等待已持有调用退出，不宣称能强制中断任意数据库事务。closure草稿按root要求暂不重写最终计数。

补充只读核对上游接口：OpenScience backend/cli/src/server/routes/global.ts345–367的configRawSet返回脱敏Config对象；server/server.ts324–380的auth.set/remove返回boolean true。与RoleRuntime.call要求非空data一致，清理不依赖不存在的204响应体。本次只阅读上游源码，未执行或修改。
