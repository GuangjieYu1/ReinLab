# RuntimePipeline composition ToSpec

`new RuntimePipeline(db,{factory?,definitionLoader?,pricingContext?,maxConcurrent?})` 组合默认production factory、Harness RunDefinition loader、RunBridge、ObservationStore.sink、ObservationScheduler和DecisionService。factory/definitionLoader仅NODE_ENV=test允许注入，无livefallback。readonly decisions提供显式用户决定API。

submit是显式用户路径，await bridge.submit；仅accepted启动后台观察，indeterminate只追加去重稳定gate说明提交结果待核对，绝不重发prompt。recoverAccount只用scheduler读恢复accepted运行，不调用submit。shutdown关闭观察订阅，之后不接受新submit。

RunBridge第四参数pricingContext严格对象：currency CNY|USD/window peak|offpeak/usdCnyRate固定7.2/pricingVersion固定官方版本/validFrom与validUntil整数且until>from。root配置parser提供该窗口对象，无requestedModel；准备绑定时添加binding.role.model并在sendIntent前存os_binding.pricing_context。非空已存上下文永不覆盖；无配置保持null，不猜价格，不能给已发送的历史null绑定补事后价格。

ToTDD service纯fake Runtime+真实fixture PG：accepted观察、未知提交零重发/稳定gate、readonly recovery、shutdown、pricing先存且不可覆写、缺配置null、坏配置拒绝、生产注入拒绝。原生串联独占运行真实npm2.0.150+本机fixture，真实Harness/loader/binding/observer/ledger；争取Auth/Hono estimate→confirmation API。fixture usage与真实DeepSeek模型不匹配时保持unknown，不制造CNY实际价。

## 实现与当前证据

service有效stub red6失败/1通过，实现后7/7；accepted回归等待真实ObservationStore.sink成功synchronize并进入subscribe，避免只核对构造调用。组合pipeline7+独立RunBridge4+RunDefinition12共23/23。control tsc与边界lint通过。

`pipeline-native.test.ts` 真实ES256签名经本机JWKS验证（不是live Supabase登录），Hono真实estimate/confirmation API→immutable Harness/模型route→HarnessLoader→native OpenScience2.0.150→observer→ledger，1/1通过。首次运行在root新增createApp.pipeline选项前，使用已有onRunQueued显式hook调用同一pipeline.submit；不是main生产composition验收。root另接正式API/main。实际provider calls=1，usage=1/costnull/statusunknown，hold unpriced，34条ledger事件。确认HTTP相同Idempotency-Key重放与recoverAccount后calls仍1，无重复usage。只用test fixture provider与本机catalog、JWKS，无真实模型/凭据/外网。

完整脱敏捕获在evidence/P1-10/pipeline-native/pipeline-native-evidence.json；不保存Auth JWT、private key、HTTP headers或native token。fixture模型不匹配DeepSeek实际价，因此unknown是期望结果，不能把估算catalog当实际费用证据。独立代码审查交docker_driver；作者不自批。

## Root生产启动接线（实现中）

main创建默认RuntimePipeline（不传fixture factory/loader），经价格窗口严格parser给出snapshot或保持null；新API options.pipeline接显式确认提交、读取恢复和用户决定。local bootstrap在既有管理连接执行迁移后受信发布真实bundle，HTTP连接始终是reinlab_app且不具publish权限。SIGTERM先关服务器接受并abort观察，关闭长SSE连接后等待队列停止和pool释放。最终须复跑D-1真实HTTP入口与Node22/24全量，不能以service/native test代替main已验收。
