# Harness RunDefinition loader evidence

实现范围仅run-definition.ts/test及设计/证据；不改main/app/RunBridge、008 schema或HarnessStore。

- run-definition-red.json：已导出typed loader但NOT_IMPLEMENTED；8 failed/0 passed，有效行为红。
- run-definition-green.json：10 passed/0 failed。
- control tsc与边界lint通过，Node22.23.3；使用fixture PG55432，未启动真实模型/外网/容器，无secret读取。

覆盖：run_harness不可变快照与新dossier override分离；仅服务端route控制模型；input authority字段不扩权；角色prompt/steps/grants来自有效snapshot；无旧role_def或thread summary读取；L1/跨档案/其他thread/scoped-global/revoked/superseded拒绝；L2当前无thread与global L3/L4允许；层级收窄、显式refs交集/空集、其他账户refs、assigned-citations空；坏snapshot/missing binding/跨租户；非法steps/refs/消息上界与canonical fallback；记忆JSON超限413；SQL只读。

memory快照只在尚未建立BindingStore binding时由调用者加载。建立后binding持久化role_options，恢复应从binding读取，不重新解析当前memory。这一接线由root负责；本loader不自行创建binding或提交模型。


## P2模型route确认边界修复

首版虽10/10通过，却允许执行时重选server/env route；独立审查发现这是已确认报价的一致性缺陷。原报告保留历史。当前仅从run_harness.model_route读取，环境、构造modelRoutes和input不能替换；默认/历史null必须重新确认，MODEL_ROUTE_UNBOUND409，无livefallback。loader只传当前effective角色tier→存储route给materializer。011/API由root实现，本任务未修改。

- run-definition-route-red.json：7 passed/4 failed，真实有效route差异/null行为红。
- run-definition-route-red-final.json：补非法读行防御后7 passed/5 failed。
- run-definition-route-green.json：12 passed/0 failed，control tsc/lint通过。

数据库CHECK本身拒绝非法model_route；非法读行回归用纯test受控DB read adapter覆盖，不把约束setup失败当成行为红。其余scope/只读/租户边界原测试均保留通过。
