# MCP smoke guard与终态审批清理独立安全审查（最终定向通过）

范围：tooling/local/mcp-smoke-guard.ts与共用one-shot validator；ObservationStore.finishTerminal。仅安全评审与独立测试，未读真实key、未调用模型，所有HTTP均随机127.0.0.1合成handler/transport；PG仅55432合成账户。

## guard已通过边界

- 单次workflow最多6次不同body，串行active标志防并发；相同body重放后unknown封禁；非2xx/transport异常后停止，不自动重试。双实例抢同一不存在marker只有首个wx成功实例转发。
- 每体原始与canonical JSON均≤65536B，max_tokens为1..1024整数、n仅省略/1，模型固定flash别名、thinking强制disabled，其他字段由原严格validator拒未知/类型coercion。认证精确单Authorization头、timingSafeEqual；POST固定路由；上游固定HTTPS且redirect:error。
- 原第二轮open(a)会跟链接/接受硬链接/缺失重建/替换/改权限；独立6项红灯已复现。修复后每轮校验父目录owner/700/canonical/初始dev+ino；marker首次EXCL创建，后续无CREAT，APPEND|NOFOLLOW|NONBLOCK，fstat常规/单link/currentuid/600/精确长度/原dev+ino。marker及父目录fsync在每次上游之前。
- 按任务给定价格与预留假设：6*((65536+4096)*0.30+1024*1.20)*7.2/1e6=0.95551488 CNY<1。已以Decimal精确复算。这是给定峰值价格、每轮输入tokens≤body bytes+4096的保守计费假设，不等于实测账单。固定6轮硬限不依赖上游成功/用量返回；失败已计消耗，不恢复marker workflow。
- marker仅body SHA256摘要，不存上游key/来访token/body；异常输出固定错误码，不打印原异常。测试注入transport仅NODE_ENV=test允许。

## 响应错误边界已关闭

HTTP200 JSON/SSE内error原本不会置unknown，两项独立红灯已证实。修复后响应有界读取≤512KiB且不打印；JSON检查error与stop/tool_calls finish_reason；SSE逐data解析、检查error并要求DONE及stop/tool_calls；缺失、截断/解析失败、超限、length等未知状态封禁后续轮。独立两项红灯转绿；补缺DONE/缺finish/坏JSON/空choices/length/超512KiB六项拒绝，以及拆chunk的正常SSE tool_calls可继续一项，通过。成功transport fixture全改真实choices+finish_reason，避免用{ok:true}触发unknown导致负面假绿。

本次代码安全边界最终定向通过。总费用结论仍受给定峰值价格和token开销保守假设约束；真实付费请求/账单不在本agent验证范围。

## 终态修复通过

本账户事务内按account_id+run_id+state=pending+kind permission/question精确UPDATE为expired，无自动批准或模型/decision调用。已approved/indeterminate、budget及其他run/account保持原状。原预算锁+run行锁与RLS边界保留，audit用run唯一dedupeKey，仅记录数量；同事务预算结算与终态提交。

新增p113-terminal-approval-security-review通过：真实PG合成两账户/同账户额外run；故障注入令审计insert失败，审批状态/run终态全部回滚；跨账户调用RLS_DENIED；成功后仅2项pending permission/question过期、其他5项对照不变；重放同终态只1条count2审计。无真实模型/原生提交。

## 实际执行

全部login:false，先unset DEEPSEEK_API_KEY，指定Node22 PATH。p113-mcp-smoke-security-review初轮6红2绿；修marker后与原mcp-smoke-guard、terminal独立测试共3文件13/13绿。随后新增200内error两项，独立guard文件现10绿2红。终态测试初版fixture缺hold绑定及跨账户预期码错误已修正，未放宽实现断言。原observation-store末项广查所有审批因新增预算卡失败，已报主agent，不能把它记为通过。

## 最终亲跑附录

最终4文件26/26通过：p113-mcp-smoke-security-review 19项、mcp-smoke-guard 2项、p113-terminal-approval-security-review 1项、observation-store 4项。六类marker红灯与200内error两项红灯均转绿；原observation-store按permission/question限定后通过，budget仍保留。

本轮首次合跑独立terminal测试在默认5s到时失败，无断言失败；显式给该真实PG双账户+故障注入集成用例30s后，原断言全部保留，重跑4文件26/26用时约3s。不得把首次超时隐去，也不将超时当实现漏洞。所有命令仍login:false/先unset DEEPSEEK_API_KEY/Node22；无真实key/模型调用或真实容器Env读取。真实chaos发现/回放与付费smoke另由主agent执行，本报告不冒称亲跑。

## cleanup重连附录（红灯修后通过）

新内层cleanup允许可选RoleRuntime，检查instanceof、同账户token、相同role/dossier目录与roleId，并在写之前bound重新校验受管文件；配置恢复与临时auth删除仍只重试未完成阶段，无模型/决策重放。预期适用于专用fixture容器hostPort变动后的受信production resolver。

独立p113-cleanup-reconnect-security-review首次红灯发现：返回cleanup包装仍无参数，调用this.cleanupSmokeGateway()，导致外账户/普通对象入参被忽略且沿原连接清理。内层新检查未进入返回API，真实新端口也未使用。已通知主agent修复；最终返回API→cleanupSmokeGateway→保存closure均显式传入reconnected，smokeSetting互斥保留。扩展现经下列独立复跑通过。新增测试将覆盖非instance、其他token、同账号不同role、克隆未发行project capability、受管文件变动拒绝，随后同身份fresh endpoint并发/重复仅恢复一次。所有请求合成本机随机端口，无真实key/模型。

## cleanup最终复跑与范围

亲读确认保存closure类型、返回cleanup参数与cleanupSmokeGateway参数已完整传递。独立scope红灯现转绿：非RoleRuntime、外账户token、同账户不同role、克隆未发行project均在写前拒绝；合法角色的受管文件改动也拒绝且零写；恢复文件后同身份fresh endpoint并发+重复cleanup仅执行一次PUT原始raw config与一次DELETE临时deepseek auth，旧endpoint零请求，无重新配置/模型请求。默认无参路径和失败仅重试未完清理阶段的原测试继续通过。

最终亲跑6文件39/39：p113-cleanup-reconnect-security-review、runtime-smoke-gateway、p113-mcp-smoke-security-review、mcp-smoke-guard、p113-terminal-approval-security-review、observation-store。Node22/login:false/unset DEEPSEEK_API_KEY，所有模型transport合成，所有SDK重连随机本机HTTP，未读真实key或调用模型。

只读核对主agent产出的/tmp/reinlab-p113-chaos/report.json固定摘要字段：fixtureModel=true、realInfrastructure=true、passed=true、checks数量8、fixtureGatewayCleaned=true、realModelRequests=0、realKeyReads=0。此为读取既有报告，非本agent亲自执行chaos；未输出账户/档案/运行ID或原始请求内容。

本次cleanup扩展的必要接线问题已关闭，定向安全通过。该口仅限受信CLI的专用fixture gateway清理；生产resolver重新验证目标连接，不能据此扩大HTTP用户权限。
