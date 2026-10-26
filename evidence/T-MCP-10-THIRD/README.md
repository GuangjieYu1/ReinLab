# T-MCP-10 第三次授权

用户明确授权一次，执行人Codex；新绑定/旧绑定拒绝先提交，CI终态全绿之后才真实执行。执行窗口、命令、样本、完整审批核验及失败处理见evidence/P1-13/T-MCP-10/NEXT_SMOKE_PLAN.md。旧mcp10-authorized-20261024不可复用。本次绑定独立目录/marker/requestID，峰值守卫上界¥0.95551488，预算≤¥1。

预执行验证：绑定/顺序/守卫及独立安全31项通过；原生SDK2.0.150六轮模型fixture真实驱动search→fetch批准→PDF page1→write批准→finding批准，三次精确once批准、五项能力各一次。loopback fixture的现金路由是local，6笔用量均保留unknown、hold未冒充结算；不是DeepSeek实际模型验证。原生fixture首次因未restoreSession、目录输出限制及现金路由预期错误失败，修复fixture装配与按真实语义断言unknown；未放宽生产校验。

独立安全发现截止时间只在入口核验的缺口，已补在guard每次真正transport前复核；创建过期/读body时过期/marker落盘后过期三项均0转发。报告见SECURITY_REVIEW.md，测试冻结。write前同run全文章节回执+DB原文；card前已完成精确write及相同资产引用，不只核配置。

Safari由用户清理凭据页面后只读核今日ReinLab请求0/token0/¥0.00。真实执行报告、账本和专用key核账将在执行后追加；当前本目录尚不声称实际冒烟通过。任何真实阶段失败或未知立即停止，绝不第二次执行。

## 实际执行与停止

执行前提交aa772e3567d5dffc8aa718f1be37b725d78a8a94，PR/push共10项CI completed/success，见pre-execution-ci.json。2026-10-26北京时间10:11–10:13只执行一次，6次真实DeepSeek转发；三项审批fetch/write/finding均精确核capability/requestId/argsHash/完整args后once。五项能力各成功一次，但内核仍请求第7轮，守卫按计划返回409，run failed。故整个T-MCP-10保持未通过，不能因发现卡成功而标绿。没有调高轮数、重置marker、换requestID或再次执行。清理全部成功，控制面恢复；raw报告guard快照是在cleanup之前，不能据closed=false推断守卫仍在运行。

专用key今日基线0，执行后UI6请求/30318 token，今日导出4条用量+成本项确认供应商总¥0.02159384。CSV此次只给掩码key，ReinLab别名和掩码前后缀在内存与当前受保护key一致；没有冒称完整key逐字节核对。已知6笔原生账本费用逐笔向上取整合计¥0.021596，差额-¥0.00000216。按同一小时、今日零基线核账，不以总账户余额核单key。仅追加provider_invoice_reconciled事件，原failed与unpriced/actual=null保留。run.spent_cny=0是未结算投影，绝不当本次零费用。

执行原始报告execution-report.json保留；实际账本ledger.jsonl包含追加核账事件；provider-reconcile.json去除了user_id与api_key，原始ZIP在仓库外700目录/600文件。该最小能力链路仍不代表完整精读课程/测验体验已通过。
