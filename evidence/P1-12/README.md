# 第五批 P1-12 送审索引

范围：旧部署/控制面凭据文件化 → research@1.1.0 → 审批卡与上线收件箱 API/前端live。停在P1-12送审；T-MCP-10未授权且未执行，模型请求0、模型费用¥0。Fly/托管Supabase/staging均为云端补验。

- `credentials/`：ToSpec/红绿/真实原生鉴权/旧账户4/4迁移、完整本地基础设施9/9；`followup/security-review.md`独立20/20。
- `release/`：旧版字节归档、新版schema、档案pin、当前run页回执与quote校验、quiz keys仅档案；独立迁移与引用安全复核。
- `inbox/red/`：API缺失、真实Supabase opaque refresh形状及quiz原生名称回归红灯。
- `inbox/green/`：Node22/24全量原始报告，API定向与quiz投影。
- `inbox/security/inbox-review.md`：独立API/DB/Auth/session竞态与扫描器安全评审，修复和亲跑结果逐项列明。
- `inbox/local-live/`：真实本地Supabase/Auth/API/浏览器7/7，四种人工决定、once卡、回前台/闲置刷新、eventRef原文回看、截图与账本。数据为明确人工录入的审阅验证条目，不冒充模型生成或T-MCP-10。
- `final/`：18/18 T-REG原始report与每场景截图、逐文件前端hash、双模式构建/类型、真实容器8/8+4/4、凭据实际值扫描与可读进程环境范围。

CI：以本任务附件PR当前HEAD的Actions终态与可下载报告为准；完整索引和复跑命令见REPRODUCE.md。主仓库保持只读，本批仅在隔离工作树实现；旧mock JSX/CSS/交互分支、e2e/legacy场景不重写。

已处理：baseline ENV迁移丢失、不可变Image ID创建、Docker挂载顺序、unknown受限对账、旧refresh覆盖新账户、跨账户旧视图、intent幂等键清除、opaque refresh错误长度假设、构建目录第三方测试误收集、原生fixture漏schema。没有放宽RLS、原生Host/Origin、引用核对或iframe沙盒。

限制：运行入口/P1-13后续功能未接；live明确提示未开放，不返回假研究结果。当前选值凭据扫描11值/4账户，列明范围0命中；不覆盖历史所有轮换key/所有能力令牌/整机/OCR。每账户1个ENV不可读，如实列blocked，未用passed冒称所有进程覆盖。Cloud与真实模型验收不以本地fixture替代。

最终全量：Node22/24各1433/1433、0失败0跳过；最后18场景回归为冻结前端后的完整复跑。final-boundaries-review独立16/16覆盖eventRef跨来源/事务失败与并发锁；新镜像ec9cf4906365冷启动/四账户升级/9项本地集成均真实通过。并发lock首轮红灯与受控1000次绿灯保留，未修改旧断言。
