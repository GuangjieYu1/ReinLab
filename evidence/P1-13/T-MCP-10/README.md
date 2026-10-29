# T-MCP-10：单次执行失败，真实模型链路未通过

2026-10-25北京时间01:44:54，在26e4940的push/PR共10项CI终态全绿后，执行一次smoke-mcp.ts --execute-once。用户要求单次、失败不重试；本次没有再次启动执行器。

- 新账户、新research@1.1.0档案创建成功；预估阶段HTTP503。没有进入protected_key阶段、未创建模型守卫、无run/estimate/os_usage行，无模型转发marker；实际模型请求0。papers/files/cards链路均未执行，不能标记T-MCP-10通过。
- report.json为原始执行报告，保留未改。其realModel:true表示计划执行模式，不表示发生模型调用；以execution-facts.json的实际0请求及账单为准。控制面恢复true，cleanupFailures为空。
- ledger.jsonl为空文件：RLS查询该档案没有账本事件，也没有run；不是遗漏或伪造成功记录。
- Safari刷新后的ReinLab专用key当日用量为0请求/0tokens/¥0.00；私下核对key与筛选别名匹配。billing-before-execution.png、billing-after.png已关闭凭据弹窗并裁掉账号余额等无关区域。billing-reconcile.json及cost-reconcile.csv记录实际费用0、账本0、差额0。

## 原因及修复

临时控制面遗漏pricingFromEnvironment(config)，从process.env读取空的价格路由/汇率；正常main.ts已经显式传入文件配置。提取createSmokeApp，强制把已受保护文件读取器提供的配置注入原PricingService，执行器改用这个入口。没有把秘密放回ENV，没有放宽价格校验或用固定假价格替代live目录。

pricing-config-red.json复现503；修复后按既有API的201与六位小数合同断言，pricing-config-green.json共6/6通过。新增测试经真实API/RLS数据库，仅公共价格目录用合成fixture；错误ambient ENV不能覆盖传入配置。另做只读真实models.dev预估诊断成功，见public-pricing-diagnostic.json。它没有创建/重试工作流、没有调用模型，不替代真实链路验收。

当前结果仍是失败。后续真实复验必须取得新的明确授权和新计划；不得删除/替换现有私有状态或拿更换输出目录规避本次单次约定。
