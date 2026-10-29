# 精读live数据适配增补 ToSpec / ToTDD

按用户2026-10-25与主仓库design/RESEARCH_LIVE_FRONTEND.md：原样同步指定六文件记录SHA256；ResearchStudio注入真实ReadAdapter，删临时LiveResearch；不改Claude样式/交互。追问仅本地未接入提示，评分抛未接入，不生成假内容。

先红灯验证：真实API快照租户/游标/未知费用/quiz keys边界，ReadAdapter先预估确认、幂等、SSE去重重连/换账户隔离、真实paper/card/页码映射；再最小实现与安全/迁移独立评审；跑20场景和CI、真实Auth/API/SSE与明确合成研究数据的适配器端到端（不冒称原生模型链路）。

T-MCP-10仅修正下一次计划，原失败保留；没有新授权，不执行模型，不删除旧私有状态。
