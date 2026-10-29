# P1-10 Runtime 事件翻译 ToSpec / ToTDD

范围：纯函数 `services/control/src/bridge/openscience/mapping.ts` 与既有源码研究合同中的26种原生可达event、13种Part。无网络/文件/SDK调用，不提交prompt，不执行决定，不计价，不实现P1-11工具。

输入 `mapRuntimeEvent(raw:unknown,context:MappingContext)`，context只来自受信服务端角色配置：toolGrants和可选trustedP111Tools（默认空）。输出单条 `MappedRuntimeEvent={kind,action,payload,risk?,approval?,usage?,runState?}`。payload为有界、脱敏JSON；未知event/part、坏结构或无法安全表示的数据均输出kind:error、action:unmapped_event，不能静默丢弃。

工具risk只取toolGrants自有属性，不能取event声称的risk。缺grant的tool输出错误诊断；deny/danger工具事件可审计，但不能成为卡片。permission/question映射approval仅表达historical_pending/resolved/cancelled/rejected，不能成为真实可决定授权；fresh snapshot检查仍属服务层。

step-finish独立输出RuntimeUsage，保存part/message/session身份、规范化token及upstreamCost。missing/invalid raw字段保留null和unknownReasons，不归0；费用CNY及可靠价格来源交独立计价模块，不能从上游computed cost推定真实账单。message.updated不再产生usage，防累计字段双计。

P111尚未开始。研究建议：未来ToolResult.metadata.data携带完整contracts.Card，限定card_answer→answer、card_approval→approval、plan_propose→plan、finding_record→finding、verdict_record→verdict。仅服务端显式trustedP111Tools、已授予且非danger工具、真实completed状态与严格Card校验同时满足才生成card。data未知字段/错kind不接受，不解析output JSON或工具input来伪造卡片。这是待P111确认的Q建议，当前默认不声明任何P111工具真实完成。

验收先写纯fixture测试并取得红灯，再实现：26事件/13Part逐项有界映射；未知和坏结构error；工具risk自有grant边界；usage无缺失归0、无assistant双计；historical approval；五卡对应工具且严格schema/默认禁用；敏感字段脱敏、不改变输入；循环/超深/过大数据不抛出无限递归。测试无模型/外网/真实账户资源。

实现结果：最小占位实现取得49项47失败/2通过的行为红灯后完成纯函数；49/49映射回归、与既有观察包装器合计53/53通过，strict tsc与boundary lint通过。证据位于 `evidence/P110/mapping/`。此结果仅证明本纯函数及fixture约束，不代表observer持久化集成或P111工具已完成。
