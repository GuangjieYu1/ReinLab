# RuntimePipeline / RunBridge pricing / native composition

变更：pipeline.ts/test，RunBridge增加第四参数严格PricingWindowSnapshot以及sendIntent前只写null且未提交的pricing_context，pipeline-native.test.ts，设计与本证据。未改main/app/API/localboot/ObservationStore。

- pipeline-red.json：typed stub，6 failed/1 passed（坏配置/生产注入拒绝测试当时仅因constructor stub抛错通过；其余业务测试有效失败）。
- pipeline-green.json：7 passed。
- pipeline-related-green.json：pipeline7+RunBridge独立4+RunDefinition12=23 passed。
- pipeline-native-green.json：1 passed，单套串行独占真实native2.0.150，无真实模型/外网。
- control tsc与边界lint通过。

服务回归覆盖accepted才观察、indeterminate去重稳定gate且再次显式submit只snapshot恢复不重prompt、recover只读且不重loader、shutdown后拒新submit、生产禁止factory/definitionLoader fixture注入、价格严格字段与固定7.2/版本/时间顺序、先写价格再prompt、非空不可替换、已发送null不事后补价。真实sink成功进入subscribe后才算accepted观察回归。

原生证据pipeline-native/pipeline-native-evidence.json：真实ES256/JWKS fixture Auth+Hono估算与确认路由，run_harness绑定effective digest和quote模型；默认HarnessLoader（仅factory注入native测试端点），真实prepare和Runtime，观察落真实PG ledger/usage。首次接现有onRunQueued hook，root正在提供createApp.pipeline/main composition；本报告不冒称最终main生产接线。总provider请求1；usage1/unknown/null；hold unpriced/null；ledger34。重复HTTP确认和recover未增provider/usage。估算catalog只是fixture估算，不授予fixture DeepSeek实价。

捕获仅provider body与脱敏临时根/账本摘要，无token/header/private key；JWKS仅公钥、本机临时签名私钥不保存。测试结束全部fixture进程关闭。作者尚未自批，docker_driver独立复核待收口。

后续HTTP任务已补最终createApp.pipeline option：pipeline-native-option-green.json 1/1，捕获pipeline-native-option/pipeline-native-evidence.json，总provider1/usage1 unknown/holdunpriced，同确认HTTP idem+recover仍1。旧hook报告保持原历史，当前source已改最终option。薄HTTP最终13/13及相关89/89，见runtime-http-README.md；main/localboot由root负责。
