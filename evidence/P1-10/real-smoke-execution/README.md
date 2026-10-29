# 唯一真实冒烟：失败，禁止重发

用户明确确认计划后，于北京时间2026-10-22 02:31执行。前置Git HEAD为38f2e2e，PR/push CI均success；时段为空闲。真实Auth、HTTP确认、默认生产Pipeline、SDK账户容器与持久账本均参与，非fixture模型。

- **一次真实转发，HTTP 400，运行failed。** 提供方提示思考模式必须回传reasoning_content。未获得回复或token usage；账本usageUnknown=true，budget_hold=unpriced、actual_cny=null。spent=0是累计已知费用，不代表免费；不得认定已证明实际费用≤¥1。
- 实际请求10771字节，守卫预留上界0.5元，输出配置1024；此为限制/估算，不代替真实费用或后台账单。
- marker已经消费并保留；没有第二次模型请求、没有删除/改路径重置授权。临时auth/config清理成功；未改上游、RLS、沙盒或引用核对。
- 前置检查曾在数据库连接前失败，报告原样保留于../real-smoke-confirmed/。当时marker/admission均不存在，provider转发0；恢复专用Colima和原数据卷后才发出本次唯一请求。

## 只读诊断（尚未修复）

[官方思考模式文档](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/)说明默认启用思考，需要显式thinking.type=disabled关闭；携带tools时历史思考字段缺失可能400。只读上游provider/transform.ts:1062只在API id匹配deepseek-v[4-9]且reasoning能力关闭时注入disabled。B-1映射后的API id为deepseek-flash，可能跳过此分支；reasoning:false配置能力本身不足以证明线上请求关闭思考。本次未持久化原始请求，不能断言所有wire字段或历史消息细节，根因仍需fixture截获确证。

后续建议在SDK模型options显式配置关闭思考，并将原生fixture的出站thinking字段加入断言；不得修改上游或在guard里篡改live请求来掩盖问题。本轮只读取证，未修改此行为，未擅自再次验证真实模型。

## 报告

- real-smoke.json：不可覆盖的原始报告，含真实事件/unknown结算/清理。
- ledger.jsonl：该报告全部账本事件逐条导出，未补造用量。
- execution-summary.json：用户确认、唯一计数、保留marker及失败说明。
- cost-reconcile.csv：未知金额留空；后台核对后另附结果，不将usage缺失记成0。

P1-10未完成，P1-11未启动。需Claude判断缺陷处理及用户后续授权；本次授权已经用尽。

专用profile恢复后另跑普通真实基础设施验证：**9/9，0失败，模型请求0**；两账户复用，未再次升级。见[infrastructure-recovery/local-integration.json](infrastructure-recovery/local-integration.json)。

## 后台只读核对：未对平

02:36:56北京时间已刷新并再次导出当日用量，距本次提供方返回约353秒，超过页面声明的5分钟延迟。前后原始ZIP在仓库外权限600目录保留，摘要见[billing-readonly.json](billing-readonly.json)。后台导出为小时/model/key/type聚合，不含提供方request_id；同一小时存在其他调用，无法把聚合差额可靠归因本次400。本次无token usage，金额与误差率均留空，providerInvoiceReconciled仍false。未把余额变化、其他调用差额或后台缺行当成零费用证明。其他调用的token/金额/key标识未加入仓库。
