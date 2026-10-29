# P1-10 用户决定交付服务

## ToSpec

仅新增 bridge/openscience/decisions.ts 的 DecisionService；不注册 API、不修改 app/main。runtimeAccess.runtime(account,run) 返回 snapshot/decide/cancel 端口，不能接受调用者提供的原生 session/run/request 身份。所有身份只取受 RLS 及哈希核对的 binding。

- listPending(account)：仅 permission/question，pending/indeterminate，安全DTO，绑定 session/account/run 必须一致。
- prepare(client,account,approvalId,input)：仅 DB 事务；strict input decision approve/reject、scope once/session、bounded answers。question只允许once；approve必须答案，reject不可带答案；permission一律不可带answers。默认once。canonical intent/hash冻结，重放同内容返回收据、异内容409；不能自动批准。
- dispatch(account,approvalId)：先读取并核对已保存intent，再事务外freshsnapshot核对同session/run/request与仍live请求；question答案逐题核验数量、唯一答案、single/multiple/custom/选项、64x64x4000边界；失败400且尚未sent。permission批准只接受可信role grant中已知、非danger、非deny的permission；未知及danger默认严拒，reject仍可发送。
- 首次SDK调用前CAS持久化decision_sent=true及state=indeterminate并提交，只有winner可调用decide。SDK未知/超时/indeterminate后，只读snapshot不重发；pending仍存在保持indeterminate，消失expired并将未终结run标interrupted。仅真实SDK resolved才按保存的用户intent标approved/rejected。只保留稳定code与白名单收据，不保留错误文本或headers。prepared前快照错误不设置sent，可后续重新核对。
- cancel(account,runId)：仅显式用户入口；实际目标只取binding.receipt.runID/session。cancel_sent持久化CAS后只发送一次，未知时重复仅snapshot核对终态，不重发cancel。
- migration010增加approval.decision_sent及binding.cancel_sent/cancel_receipt；intent不可改、sent不能退回，resolved收据不能改写。所有外部SDK调用都在事务之外。调用方prepare必须先提交再dispatch。

## ToTDD

真实PG16/RLS fixture，runtime端口为普通测试fixture，不代表原生SDK网络验收。先stub red，再实现：prepare事务回滚、same/different intent、越租户/异session/异kind拒绝；permission once/session/reject与危险拒绝；question fresh选项、single/multiple/custom及400且未sent；并发dispatch仅一次SDK；未知重启只读、消失过期、resolved绑定真实用户意图；取消绑定目标/不确定只读；migration不可退回/不可改写。动态报告仅显式outputFile写本次证据目录。

## 作者验收与接口

最终export：`DecisionService`、`DecisionRuntimePort`、`DecisionRuntimeAccess`、`DecisionReceipt`、`CancelReceipt`。prepare的raw参数为unknown，严格运行时验证；listPending输出仅id/runId/kind/title/effects/risk/state/sent，排除intent/hash/原生凭据；dispatch返回prepared/resolved/indeterminate/expired收据及稳定code；cancel返回resolved/indeterminate及已核对的终态state。最终resolved收据冻结；不确定决定重复只读，缺请求expired；取消不确定重复只读终态。所有SDK mutation均在发送标记事务提交之后、事务之外执行。

先stub设计red（修正it.each数组展开后最终24/24因notimplemented失败，fixture均建成）；初次实现测试被并行007 Harness迁移语法错误阻断，单独存setup-migration-failure，不计功能失败或通过。007作者修复后，本服务010正常应用，30/30真实PG/RLS测试通过；补充发送竞争和已过期状态保持后的最终green仍30/30。此前组合定向回归172/172（decisions/observer/settlement/既有budget/mapping）。control tsc、依赖边界lint、diffcheck通过。

测试runtime仅是普通端口fixture，未声称真实SDK/native决策集成已通过；root负责最终集成。危险permission只能拒绝，不能借用户approve绕过角色风险边界。鲜活问题输入失败400且decision_sent=false。独立评审已交docker_driver，等待独立结论。

## API 提交前预校验

追加 `validate(accountId, approvalId, raw): Promise<void>`：不写意图，freshsnapshot按与dispatch相同规则校验新输入。API必须按 validate→prepare事务提交→dispatch 顺序调用；鲜活问题答案错误返回400并保持hash=null，用户可改正后重试。已经存在的同hash意图保留原收据，不因原生pending已消失而误判重复请求过期；异hash仍409。dispatch保留第二次fresh校验与不可退回sent fence。新增两项后服务 **32/32**；连同调度器/observer/settlement/旧budget/mapping最终组合 **182/182**。
