# smoke-mcp操作脚本只读安全评审（最终只读安全通过）

对象：services/control/scripts/smoke-mcp.ts。仅读取源码及相关API/私有文件帮助函数源码；未运行或import操作脚本，未读真实key/.env/容器Env、未调用模型，也未操作浏览器。此前guard/cleanup测试结论另见reinlab-p113-mcp-smoke-security.md，不据此视操作脚本通过。

## 已确认正向边界

- 参数要求仅--execute-once，拒DEEPSEEK_API_KEY ENV与NODE_ENV=test。生产MCP/SDK端口，无mock替代；fresh dossier后核有效bundle为1.1.0。
- 模型key只从受保护文件读入内存进入已审guard，未放ENV或argv；guard≤6回合、单轮65536B/max_tokens1024/thinking disabled、原marker不可重启、峰值公式<1约束保留。
- 文件批准要求预先构造的requestId、files.write capability及args全等，再核实际runtime tool input hash等于批准metadata.argsHash；同账户/本run查询及RLS，API仍绑定OS session/run；发once，不造question answers，不自动重放未知模型调用。
- 卡片核当前account/dossier/run的paper_page_read原文，后端仍二次引用验证；发现偏离即错误取消，不提供绕过选项。

## 必要修复（已向主agent反馈）

1. admission读RUN_KEY后经过多次异步步骤才写，两个并发进程均可进入；model marker仅防付费转发，不防两个run、同账号gateway覆盖/互相清理。需贯穿全流程的跨进程锁（在身份/gateway/控制面变更前取得），加EXCL不可重开准入。已保存RUN_KEY必须保持未知围栏，不能错误后自动重置。
2. evidence out来自ENV且普通mkdir/writeFile：默认目录/文件权限可能755/644，且跟symlink/hardlink。ledger/report包含私有事件，应canonical/currentuid/700目录与600安全原子写，拒链接/不安全现存目标。
3. 卡片quote比较未拒normalized空白，includes('')恒真。虽然后端拒绝，操作脚本仍会先once批准，违背“批准前亲核”。需明确normalized quote非空；按既定任务核page整数且为1、合法assetId、quote≤25英文词，再做原文包含。pending建议限制permission且decision_sent=false，意外question不生成答案。
4. finally仍configured.cleanup()默认旧runtime，需通过production resolver以initialRole重解析当前连接，再cleanup(current)，沿用已审同token/角色/先bound后写边界。
5. 确认POST未知时report.runId尚未取得，finally跳过取消。应仅只读以保存ESTIMATE_ID+本account/dossier定位唯一原run，或取http_request原幂等收据；禁止重POST，再走现有cancel并记录未知状态。
6. finally若guard.close/pipeline.shutdown/server.close任何一步抛错，后续control恢复与报告写会跳过；应逐阶段全尝试，使用既有cleanupSmoke或等效独立catch，固定名记录失败/uncertain。

## 范围限制

没有执行本操作脚本或任何真实付费调用。以上是源码复核，不能宣称操作脚本fixture/CI已过。待主agent修复后只读复核最终接线，再定论。

## 六项修复只读复核（剩取消收据确认）

已亲读最终接线：acquireStartupLock在身份/控制面/gateway变更前取得并持有到清理及report写finally release；RUN_KEY原围栏不清空。private-evidence精确owner/canonical/700目录，临时600/EXCL/NOFOLLOW/fstat单link后fsync、link原子no-replace并删临时+目录fsync，既存链接/文件均拒。quote显式非空、page1、UUID、≤25词、卡字段枚举严格，permission且未sent先断言再once approve。临时配置经fresh readonly production resolver同initialRole清理。未知POST仅按account/dossier/保存estimateId只读查唯一run，无重POST；无结果记submissionIndeterminate。清理所有固定阶段用cleanupSmoke独立catch全尝试。

唯一剩余：run_cancel在已定位但未terminal的run无binding receipt时静默跳过；有receipt的cancel+单次reconcile之后也没查最终ended_at。需先只读terminal；非terminal无receipt或取消后仍未terminal均报固定CANCELLATION_INDETERMINATE/cleanupFailures，不得当已清理。已反馈主agent；未要求任何重新提交。

本轮只亲跑纯文件测试2文件2/2：新增p113-private-evidence-security-review并发两个writer仅一个成功、目标单link/600/currentuid、无临时文件残留；已有private-evidence拒覆盖、硬链接/软链接/公开目录。测试login:false/unset DEEPSEEK_API_KEY/Node22；无PG访问、未import操作脚本、无模型/真实key/浏览器操作。

## 最终取消点关闭

已亲读真实源码：run_cancel先只读核ended_at，终态直接返回；未终态无receipt固定CANCELLATION_INDETERMINATE，已有receipt才执行SDK cancel+有限reconcile，再读ended_at，仍非终态同样抛固定码，由cleanupSmoke记录run_cancel失败。取消未知不重POST、不重放模型，后续清理仍继续。至此前述必要问题全部关闭，操作脚本只读安全审查通过。

同时只读确认Hatchet管理员临时容器run包装及私有配置写helper显式--log-driver none；令牌命令输出仅被IPC捕获到内存。未执行真实脚本、访问真实DB、读取真实key或调用模型。本次最终修复仅源码核验，仍不冒称本agent完成真实smoke或全量CI。
