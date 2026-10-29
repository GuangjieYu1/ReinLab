# P1-10 HTTP composition ToSpec

仅新增薄API适配，不新增UI/工具、P1-11或模型路由能力。createApp.pipeline可选；缺失时运行写端点503，Harness读写仍有真实服务。默认onRunQueued调用pipeline.submit，显式测试hook优先。鉴权后的GET仅recoverAccount读恢复，失败固定码日志不改变请求响应。

GET run只安全身份/运行状态/金额/submissionPhase/endedAt，不返回prompt/memory/凭据/原生session与receipt。GET approvals按RLS与state pending|indeterminate精确SQL过滤，返回安全effects/title，无原生请求ID。

所有写用Idempotency-Key与mutate账户事务。submit body{}；事务仅核对run_harness租户/确认route与未结束运行、写202意图ledger，本次work-created才在事务外submit；HTTP receipt重放不触发submit。已绑定活动运行可显式恢复，只走RunBridge既有receipt/snapshot围栏，不能自动重发未知prompt。

decide先校验Idempotency-Key，再schema/DecisionService.validate；validate在mutate.prepare前，坏答案不能留下不可变意图。mutate work只prepare，离事务外dispatch；重复service sent fence不重发。cancel body{}先事务检查accepted binding并记录202意图，再事务外service.cancel。202是不可变意图收据；事务外失败只稳定ledgererror，不将已保存写操作改报失败。

Harness GET effective summary只版本/摘要/权限/预算等，不出prompt与notes；patch BenchPatch→proposeClient与httpidem同事务；proposal decide严格{decision:approve|reject}→decideClient同事务。外部不可提交role/root/model/OS session/grants/approved布尔作为旁路权限字段。

ToTDD普通fixture PG+真实Hono认证+受控pipeline/DecisionService读写端口；先404/缺接线有效红，再薄实现。最终真实native fixture将用createApp.pipeline选项验证，不再旧onRunQueued hook。

## 实现结果与证据

已新增api/runtime.ts并接createApp.pipeline。有效接线red9失败/0通过；首绿9/9。补充effects嵌套原生身份红8过/1失败后过滤session/request/run路由身份，保留问题选项；补充default queued callback/显式测试hook优先、postcommit交付异常保202；再补费用DTO红12过/1失败，usageUnknown现综合历史uncertain、os_usage.costnull与unpriced hold，不能把完整历史误当已知费用。

最终HTTP13/13，组合89/89（budget34、decisions32、HarnessStore3、pipeline7、HTTP13），control tsc和边界lint通过。SDK均在mutate事务外；decide header/validate先行，submit HTTP收据重放不调用pipeline，decide/cancel重放经service持久围栏不重发。

最终pipeline-native.test.ts改为真实createApp({pipeline})选项（无旧onRunQueued hook），原生1/1通过；ES256/JWKS fixture鉴权→真实Hono estimate/confirmation→不可变Harness与quote route→默认HarnessLoader→native2.0.150→真实PG observer ledger/unknown费用。provider calls=1，usage=1 costnull/statusunknown，hold unpriced/null；重复确认和recover仍calls1。不是真实模型或live Supabase登录，不使用真实凭据。

本任务未修改main/localboot，root负责进程composition。作者不自批；docker_driver独立review并独占补跑原生。精确红绿与捕获见evidence/P1-10/runtime-http-README.md。
