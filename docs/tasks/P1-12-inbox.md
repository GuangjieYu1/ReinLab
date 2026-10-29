# P1-12 ToSpec / ToTDD

依据 CODEX_SPEC_RESEARCH §5/§10、BACKEND_MEMORY_SESSION 及 BATCH4_REVIEW §5。

- 真实 JWT + RLS 获取本人待审批卡、待上线提议；显示来源工作台/档案/运行、依据、风险与效果。
- 原生 permission/question 保持已审 prepare→dispatch→不可重放 unknown 语义。MCP once 审批走已有 engine；卡片请求只有用户决定，没有任意副作用授权。门禁只批准请求时冻结的 review/revision/artifact。
- 上线四动作原子事务：approve/edit 才创建 L3/L4，keep_local 创建源档案 L2，reject 无记忆写入。过期不可批准；同一决定跨幂等键仍单生效，相反决定409；替代须同账户、同层/档案和key，旧记录保留。
- 前端 VITE_BACKEND=mock 完全保留；live 在既有登录与 AgentDock 容器展示真实收件箱，进入/回前台刷新。会话只内存；失败不展示成功。未接模型入口明确未接，不产生模拟结果。
- 测试先红：API四动作/过期/越权/并发/重放/事务失败、门禁旧revision、MCP去重/once、认证边界；前端真实 API 合同 fixture交互/18个 mock T-REG；真实本地Supabase只做登录/审批/记忆流，不调用模型。
- 安全边界与迁移由独立 GPT6.1 Sol medium 审查。模型与 T-MCP-10 均未授权，本批0调用；云端补验保留。

补齐eventRef同源run真实账本核对、原始依据可点开与可编辑、前台闲置5分钟刷新；独立16项安全测试与真实浏览器7项通过。文件锁首次并发open问题先红后绿并保留1000次受控复现统计。
