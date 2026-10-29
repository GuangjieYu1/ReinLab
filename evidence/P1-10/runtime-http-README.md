# Runtime / Harness HTTP adapter evidence

实现范围：services/control/src/api/runtime.ts、app.ts薄接线、runtime-api.test.ts，以及pipeline-native.test.ts仅把旧onRunQueued改createApp.pipeline。未修改main/localboot/业务工具/DecisionService/HarnessStore。

- runtime-api-red.json：缺接线，9 failed/0 passed，有效路由行为红。
- runtime-api-effects-red.json：嵌套effects原生身份暴露，8 passed/1 failed；增加字段投影过滤后保留question options。
- runtime-api-cost-status-red.json：完整历史但价未知时usageUnknown误false，12 passed/1 failed；改看历史uncertain ORnull usage ORunpriced hold。
- runtime-http-related-green.json：**89/89**，HTTP13、pipeline7、decisions32、budget34、HarnessStore3。
- pipeline-native-option-green.json：**1/1**，最终createApp.pipeline默认queued callback。
- pipeline-native-option/pipeline-native-evidence.json：实际provider bodies（无header/token）、system、模型route/effective版本摘要、usage/hold/ledger摘要；临时根脱敏。
- control tsc与依赖边界lint通过，Node22.23.3。

HTTP验证：JWT真实签名验证、RLS归属/foreign404、strict空submit/cancel体、强制Idempotency-Key、confirmed Harness binding要求、submit只本次新intent才dispatch、坏问题答案无HTTP/decision意图、idemheader缺失不读runtime snapshot、alternate HTTP key仍service fence一次SDK决定/取消、postcommit SDK失败稳定ledger仍202、GET恢复失败固定code不隐去数据、审批按state精确SQL过滤、safeDTO不出prompt/memory/OS身份、费用unknown准确、Harness patch/approval与HTTP idem同事务。

原生最终捕获：本机ES256/JWKS fixture Auth（非live Supabase登录），真实Hono估算确认→run_harness固定quote模型→真实HarnessLoader/materialize→native2.0.150→observer+ledger，provider=1、usage=1/costnull/statusunknown、hold unpriced/null，重复confirmation和recover不加calls/usage。fixture估算catalog仅用于报价测试；模型非DeepSeek实际价，unknown正确，不能声称真实CNY账单已验证。

首次旧hook原生证据pipeline-native-green.json和pipeline-native/保留；最终option证据单独路径，未覆盖原历史。真实模型/外网请求0；未读取任何用户secret。独立审查与补跑由docker_driver负责，作者未自批。
