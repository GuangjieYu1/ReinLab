# T-MCP-10 后续单次执行计划修订（尚未授权，禁止执行）

2026-10-25：本轮只实现精读适配器和修订计划，不运行真实模型。历史PLAN/report/execution-facts/空ledger及零调用核账保留不变。上次授权对应的执行已在预估503失败，不能因实际模型0调用而复用。

## 先决条件与失败处理

1. Claude审查本PR并确认最新HEAD全部CI终态成功。单次控制面必须使用createSmokeApp显式注入受保护文件中的路由与汇率，先跑真实API/RLS的估价fixture回归；模型key尚不读取。生产API与单次API都不得回落到空ENV配置。
2. 完成零真实模型的原生SDK/MCP/守卫演练：research@1.1.0新档案，真实papers引用校验与once权限边界，检验出站thinking.type=disabled存在、串行限轮、请求大小和输出token上限、失败/未知/重启不再转发。精读适配器的Auth/API/SSE浏览器测试使用合成研究数据，**不替代这项原生链路演练**。
3. 用户再明确授权一次后，才分配新的授权命名空间、requestID、独立marker与限时窗口；保留旧mcp10-authorized-20261024状态，只读审计，绝不删除/覆盖旧锁或marker。现smoke-mcp.ts绑定历史授权目录与窗口，不能直接复跑；授权后先将新绑定与拒绝旧绑定的测试提交、CI全绿，再开始唯一一次执行。
4. 任何阶段失败或结果未知都停止；只读定位原run/收据、保留证据，不换requestID重发，不发第二次模型流程。清理恢复控制面，单独记录清理失败。

## 单次最小真实链路与批准

新账户、新research@1.1.0档案。产品三档deepseek/deepseek-v4-flash，wire deepseek-flash；SDK与守卫双方强制thinking:{type:'disabled'}。

papers.search → papers.fetch → papers.pages(1) → 用户批准的files.write一次 → cards.card.finding一次 → 结束。样本预检只查公开元数据/PDF，不算run内已读。必须在此次run生成paper_page_read后引用实际asset/page/原文句子；只有摘要、许可不足、页读取失败就停，不编造页码/引用。

写路径只准本次findings/mcp10-<新UUID>.md，内容预先核对，无敏感值。批准前同时核实际能力名、requestId、argsHash和完整预先参数，只授权once；其他权限或原生问题不自动答复。此最小MCP链路不能被描述为完整精读layer/quiz/多层UI已经真实模型验证。

## 预算、价格窗口与来源

总预算≤¥1；最多6个串行不同模型回合，每请求≤65536B、≤32条文本消息、输出≤1024token。按峰值美元输入$0.30/百万、输出$1.20/百万、固定汇率7.2并预留每轮4096输入token头部，保守守卫界限：

`6 × ((65536+4096)×0.30 + 1024×1.20) × 7.2 / 1e6 = ¥0.95551488`。

这只是守卫估算上界，不是后台实账；不启用额外DeepSeek Search/Fetch计次API，papers走已有OpenAlex/arXiv能力。

2026-10-25重读官方：[人民币价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)、[美元价格](https://api-docs.deepseek.com/quick_start/pricing/)。北京时间工作日（排除中国法定节假日）09:00–12:00、14:00–18:00为高峰，其他时段及周末/法定节假日全天为空闲。Flash CNY空闲输入未命中¥1/百万、命中¥0.02、输出¥4；峰值分别¥2/¥0.04/¥8。USD空闲未命中$0.15、输出$0.60，峰值$0.30/$1.20。官方当前wire deepseek-flash对应V4.1-Flash-1017；旧产品路由名称保留，实际版本不得冒称原V4模型。执行日重新核来源与所选窗口；过期窗口必须拒绝，不自动顺延，未知假日不猜。

## 凭据、核账与证据

执行前先私下检查Safari前台及弹窗，关闭所有显示凭据的页面后才允许截图/浏览器操作。专用key严格从~/.config/reinlab/local.env读到宿主进程内存，不source、不进ENV/argv/日志/账本/证据；能力令牌同样处理。

按ReinLab专用key先记后台基线，执行后只读核请求数、输入/输出token、费用；账单延迟则标待核，不以总账户余额推单key费用。保存脱敏截图、actualModelRequests、run/estimate/usage计数、账本、逐步结果、取消/清理、cost-reconcile与本次授权标记。未知费用保留未知。新计划在授权和绑定提交之前没有可执行命令。
