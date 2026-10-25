# BATCH7 第七批送审证据

范围：Claude前端8文件原样同步与数据注入、研究台对话澄清→真人选论文→页数预估→确认、research@1.2.0、T-MCP-10记录/计划修正。未开始P1-14/P1-15，未调用真实模型。

source-hashes.json记录8文件复制前/来源/复制后SHA256。WorkbenchStudio只有data wrapper导入改动，wrapper传available=[read]与liveReadAdapter；无样式/交互重写。追问/评分仍诚实未接入。

新档案1.2.0；冻结1.0/1.1保留。澄清仅papers.search/原生question，cheap、最多6次实际HTTP、每档案累计¥0.05，不经确认。逐HTTP持久最坏预留，完整可信usage后只释放已知多余预留；在途/失败/未知保持全额，不重试。SQL/RLS、独立模型audience、原生出站与人工选择测试见tests/及SECURITY_REVIEW.md。六份迁移均为已应用之后的追加修复，保留校验和；006对不完整历史receipt保守采用maximum。

候选只来自同一次实际检索成功回执；公开书目页数注明未下载核验，缺失按32页保守估价并明确说明。估算绑定candidate和selection revision；换篇使旧估算无效。正式角色移除search、服务器绑定已选paperId，fetch仍必须批准。

测试原始JSON见tests/；Node22/24全量均1567通过、0失败/跳过；独立安全16通过。原样T-REG20/20见T-REG/report.json。真实Supabase Auth/API/RLS/SSE、原生2.0.150澄清与Claude组件浏览器8/8见browser/，其中2次模型HTTP均fixture，正式精读卡片明确合成，不替代真实模型端到端。必需原生构建后33/33，CI终态补在HANDOFF。

T-MCP-10原链路仍未通过，真实复验等新授权；历史Claude2调用供应商导出已核¥0.00488924，原未知账本保留，详见T-MCP-10/。云端补验不冒称完成。
