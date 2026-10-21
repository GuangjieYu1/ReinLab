# RoleRuntime 恢复与观察增量独立评审

最终结论：指定恢复/观察包装器范围通过。权限/幂等主边界未发现放宽；RT-1错误语义问题已由父任务修复并经独立复跑确认。评审只写报告，未改共享RoleRuntime生产代码。

## RT-1 [P2] invalid_answer 被改成服务不可用

位置：`services/control/src/bridge/openscience/role-runtime.ts:13–22,34–36,61`。

真实上游 `OpenScience/backend/cli/src/server/routes/runtime.ts:182–183` 对 RuntimeDecisions.AnswerError 返回 HTTP400 `{error:'invalid_answer',message}`。触发条件包括答案数量与问题数量不符、单选提交多项、重复选择、custom=false提交未列出的选项（`runtime/decisions.ts:98–110`）。桥接Decision的宽数组schema无法提前判定这些依赖pending内容的错误，调用会到上游；responseFailure没有400分支，因此返回OS_UNAVAILABLE503。合法服务拒绝无效用户答案被误报为基础设施故障，无法让调用方明确修正答案。

建议只对精确400 invalid_answer保留稳定 `INVALID_ANSWER/status400`，且call的保留代码表同步更新；不暴露上游原始message。用现有fakeHTTP fixture验证单次转发、准确400、没有自动重试。

修复复核：父任务已增加精确400 invalid_answer分支及call保留码，固定中文消息未复制原始上游内容；`runtime-observation.test.ts`新增客户端错误/单次转发回归。独立再次运行该文件4/4通过（与mapping49项合跑，`evidence/P110/mapping/green.json` 53/53），RT-1关闭。本报告保留原发现历史。

## 已核对通过的边界

- 锁定真实SDK为 `@synsci/sdk@2.0.150/v2`。decide使用 `{directory,runtimeDecisionInput}`，subscribe消费`{stream}`，与锁定SDK生成实现一致（`dist/src/v2/gen/sdk.gen.js:2980–3000,3078–3095`）。
- createSession显式ID有固定格式检查，返回ID/directory/workspace/parent进行校验；restoreSession先重新核对issued project与精确全局plugin，再读取绑定session，验证同ID、目录、project workspace、无parent后补本计划session grants。不会把任意sessionID直接加入Set；异role目录上游404被拒绝。持久化account/role/session业务绑定仍属于后续控制面职责，不由此包装器自动推断。
- prompt仍strict文本输入、固定normal及delegation:false；请求ID不在本次恢复时重造，不存在观察方法调用prompt的路径。upstream同request同内容返回durable收据，异内容409的语义保留；死owner由上游收据标interrupted，不重新执行。
- reader为frozen对象，仅暴露snapshot/messages/getRun/capabilities/replay/subscribe六个方法，不含create/prompt/decide/cancel，方法都经已有角色绑定检查。观察端没有获得写入端对象。
- replay拒绝负数/非安全整数cursor；responseFailure分别保留CURSOR_EXPIRED/CURSOR_AHEAD和边界字段，保留DECISION_EXPIRED/DECISION_CONFLICT/SESSION_BUSY。404可识别；非语义化传输故障稳定503，不重发prompt。
- subscribe设置SDK最大1次尝试，受控fetch读取HTTP错误并保留cursor语义，握手deadline只覆盖拿响应/错误体，不把普通10秒超时当永久SSE寿命。for-await顺序交付，正常EOF显式OS_STREAM_CLOSED；调用方abort或generator结束触发lifetime abort。SDK内部自动Last-Event-ID重连不会偷偷绕过应用已提交cursor。
- decide只允许permission once/session/reject，拒绝project/always；question/question_reject严格shape。indeterminate作为结果原样返回，没有重做决定的路径。pending freshness及业务答案授权仍需后续调用方根据fresh snapshot完成，本桥接不宣称已提供持久化审批状态机。
- cancel必须绑定session并指定runID，真实SDK/上游路径按run scope处理，不会用legacy session cancel误取消替代run。

## 测试及证明范围

独立复跑现有 `runtime-observation.test.ts`：3/3通过，见 `runtime-review-unit.json`，使用本地fakeHTTP+真实锁定SDK，无模型/真实资源。覆盖reader无写能力、真实SDK SSE顺序消费/abort、cursor409无重试、决定范围和indeterminate单次转发、cancel体。

只读核对 `runtime-recovery.test.ts` 的controller_restart/in_flight_replay/kernel_restart三场景及既有他方报告：恢复后同requestID回放、异内容409、provider marker请求不增加、跨role restore拒绝。`runtime-recovery-green.json` 4/4与`runtime-observation-green.json` 13/13属于他方运行结果；本轮未重复启动native fixture，避免干扰并行测试。恢复测试的kernel_restart分支尚未直接断言最终state=interrupted；当前证明重点是没有重复provider请求，不应把它夸大成全部重启状态机已验收。翻译/账本cursor事务/unknown ledgererror属于后续实现，未在本包装器review中冒充已完成。

本轮未读取secret、运行真实模型/外网/账户资源或改生产文件。纯排版独立结论另见 `format/review.md`。
