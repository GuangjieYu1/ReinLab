# T-MCP-10 单次真实链路计划（本批用户已明确授权）

状态：本次单次执行已经失败于预估HTTP503，实际模型0调用、费用0、未重试。配置遗漏已修复且仅做fixture/只读目录验证；真实链路未通过，后续须新授权与新计划。本计划保留作历史依据，不得再次执行下面的命令。

1. 新建专用本地账户及 research@1.1.0 档案。真正OpenScience2.0.150、SDK、插件和生产MCP；三档产品路由 deepseek/deepseek-v4-flash，wire deepseek-flash、thinking.disabled，每轮输出≤1024 token。
2. 顺序 papers.search→fetch→pages(1)→files.write（once）→cards.card.finding（once）→结束。全文缺失立即停，不把摘要冒充页码，不编造引用。样本 QA-LoRA（OpenAlex W4387156572，OA许可字段other-oa，arxiv.org/pdf/2309.14717）。只读公开预检PDF681578字节、文本层可读；预检不替代新run内实际能力读取与paper_page_read核对。
3. 只许新档案 findings/mcp10-<新UUID>.md，固定无敏感内容。核实际tool input、requestId、argsHash及预先文件参数完全一致才批准。finding必须是本run读到的asset/page1，quote非空、≤25英文词且匹配原文；服务器仍独立验证引用与冻结schema。其他权限/问题不自动批准或捏造答案。
4. 新requestID、仅一次确认。整流程持跨进程锁；私有admission阻重跑，首次转发前消费marker；一个工作流至多6个不同、串行模型回合，不是6次独立运行。重复请求、重启、未知/失败/截断/JSON或SSE内错误后禁止再转发。任何实际失败不重试。
5. 总预算≤¥1。每请求≤65536B、最多32条文本消息、输出≤1024token、6轮封顶。按峰值USD输入0.30/百万、输出1.20/百万，汇率7.2，另加每轮4096输入token头部余量，界限为6×((65536+4096)×0.30+1024×1.20)×7.2/1e6=¥0.95551488。这是守卫上界估算，不冒称后台实账。
6. 2026-10-24周六及10-25周日全天空闲；CNY未缓存输入¥1/百万、命中¥0.02/百万、输出¥4/百万。执行窗口仅覆盖该已核对周末，最迟北京时间10-26零点前结束；原私有admission和marker不变，不增加执行次数。执行时显式限定有效窗口，不猜节假日。[官方CNY定价](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)及[USD定价](https://api-docs.deepseek.com/quick_start/pricing/)，2026-10-24核对。产品汇率仍固定7.2。
7. Key仅宿主从 ~/.config/reinlab/local.env 严格私有读取到内存，不source，不进ENV/argv/日志/账本/证据。账户只收到临时私有网关凭据。Safari前台已是用量页，无key弹窗；按别名ReinLab的基线0请求/0token/¥0.00，截图只在筛选菜单关闭后保存，不进key管理页。
8. 实际浏览器通过live代理接收原SSE finding事件，导出账本/usage。本项只验证事件收到，不增加Claude负责的卡片界面。后台同key核对次数、tokens、费用，容许约5分钟延迟。未知POST只读定位原run，绝不重POST；失败取消仅限此run。清理全阶段尝试，恢复任务控制面，未知如实记录。

以下是本次已经失败的历史命令，保留供审计，禁止复跑：

```sh
unset DEEPSEEK_API_KEY
REINLAB_EVIDENCE_OUT=/private/tmp/reinlab-p113-mcp10 pnpm exec tsx services/control/scripts/smoke-mcp.ts --execute-once
```

此命令不可加入CI。后续复验需新的用户授权，禁止删/换marker再试。
