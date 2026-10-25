# T-MCP-10 历史记录更正与核账

本批（BATCH7）真实模型调用0。原Codex预估503/0模型调用，与Claude在10-25用户独立新授权下的真实2调用分开。旧RUN_KEY/model-forwarded.marker属于后者，已消费；未删除、替换或重跑。

Claude执行原始记录：主仓库design/reviews/T-MCP-10_CLAUDE_RUN.md；原始报告在仓库外/private/tmp/reinlab-mcp10-claude/out/report.json。后者卡在papers.fetch审批后取消，链路仍未通过。

2026-10-26在用户确认已关闭凭据页面后，只读Safari专用key用量。页面选10/25–10/25与ReinLab，汇总显示0（截图保留），但同筛选下导出CSV明确记录2请求。CSV原始api_key字段仅在内存与受保护仓库外原件中处理；与当前受保护key匹配为真。

供应商导出：输入缓存未命中3875、命中3712、输出235 tokens；费用¥0.00488924，与cost导出¥0.0048892400000000一致。原账本已知¥0.004198；推算原未知部分差额¥0.00069124。CSV按小时汇总，不含逐请求ID，所以该差额是两请求总额扣已知项的推算。历史账本未知状态保持原样，不回写伪造usage、不把未知计0。

仓库仅保留provider-amounts-redacted.csv和provider-reconcile.json，均去掉user_id/api_key，截图裁掉账户余额与浏览器标签。原始zip放在本机受保护billing目录（700/文件600），不上传。

NEXT_SMOKE_PLAN和smoke-mcp.ts已把papers.fetch列入能力名/requestId/argsHash/完整args四项核对与单次批准；paperId取本run实际成功search回执，并核预定样本一致。授权来源、执行人由显式CLI参数提供。旧绑定仍是已消费目录/过期窗口，禁止直接再执行；下一次需用户新授权及新提交绑定。
