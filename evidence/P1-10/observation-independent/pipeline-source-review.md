# Runtime pipeline 源码/非原生回归独立审查

当前pipeline.ts与RunBridge pricing窗口增量暂未见额外P1/P2，非原生unit7/7独立通过，pipeline-unit-regression.json。未启动native以避免与作者E2E冲突，真实Auth/Hono→native闭环待作者绿后另验。

默认依赖为真实ProductionRuntimeFactory与immutable run definition loader，注入factory/definition仅NODE_ENV=test允许；没有生产fixture model fallback。只有显式submit进入bridge，accepted后启动只读scheduler；indeterminate只记稳定gate、不重发prompt，recoverAccount只读已accepted active binding。decision服务单独暴露给显式用户入口，不在观察分支自动调用。shutdown关闭新submit并中止观察。

RunBridge第四参数严格校验currency/window/固定7.2/version与有序validFrom/Until；snapshot只有在既存binding planned/preparing/prepared且pricing_context null时首次写，requestedModel固定binding.role.model，已有非null不覆盖。无pricing保null，submitting恢复不补猜窗口，观察时窗口外保持unknown。此增量不添加新prompt调用或降级重放。

下游sink另发现terminal后晚到priced step会造成ledger/spent不一致，记录sink-review.md，P2未关闭前不能据此宣称整个pipeline已完整通过。HarnessStore proposeClient/decideClient轻重构仍保留账户锁、base CAS、纯proposal重算和收据/ledger同事务；HTTP接线独立事务验收待root完成。

## Sink修复及原生复验状态

下游晚step P2已独立68/68关闭，sink-review.md已追加结论。API/pricing15/15、main/bootstrap57/57也独立通过，runtime-main-review.md。

但实际pipeline-native独立连续三轮失败，不将整个闭环标通过。pipeline-native-regression.json、pipeline-native-final.json、pipeline-native-diagnostic-report.json均0/1，30秒poll run.ended_at未完成。原生2.0.150成功ready、submit已accepted；只读随机fixture结果running/cursor6/usage0，事件停session_status；诊断确认loopback provider收到1次fixture模型请求，native JSON日志只有ready。诊断仅独立副本finally增加scrub日志/请求计数/fixture状态，没有改原测试或production。详见native-diagnostic/independent-pipeline-diagnostic.json。

尚未定位是nativefixture协议/初始化时序还是生产管线问题，不能将作者既有1/1替代这次失败；root和作者已收到。所有独占测试自有进程均finally关闭，无真实模型/凭据操作。

## 后续修复收口状态

原生失败根因已确定为observer replay后同步旧snapshot的时序错误。root授权docker_driver作者修复，78/78+tsc/lint通过，原native修复后1/1；详见stale-snapshot-fix-report.md。当前仅等待root/另一agent对作者修复独立复核，不再将原native未定位作为现状；历史失败记录保留。
