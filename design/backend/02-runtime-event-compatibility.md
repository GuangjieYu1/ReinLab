# 02 · 事件兼容与费用完整性分离

状态：用户已确认；2026-10-27。实施顺序：02 → 01 → 03。来源：[走查 run6 记账/观测问题](../walkthroughs/2026-10-26-research-read/RESULTS.md)。

## 1. 要解决什么
`session.request.progress` 映射失败后，`ObservationStore.ingest` 因 `mapped.kind === error` 把整次费用标为不完整，正常运行被假停。当前 properties 已允许附加字段，具体哪个必填字段/枚举不匹配仍须核对实际事件，不能把原因一概归为“新增字段”。

## 2. 定下来的决定
- 一张映射注册表明确每类事件的职责：进度/文本、运行终态、审批、用量。外层必须核验 session/run/sequence/time；允许附加字段，身份/游标无效不能推进，也不能冒充普通未知事件吞掉。
- 进度只取展示所需字段：phase 接收未知字符串并显示通用“运行中”，耗时等辅助值缺失/无效则省略；不因展示字段升级中断订阅。用量数值、终态身份、审批决定仍严格校验，不做类型强转或默认补零。
- 有效信封的未知事件/未知 part 记 `unmapped_event` 与兼容诊断，和游标同事务提交；不推断费用、批准或终态。保留有界、脱敏的类型/字段错误信息，不无限保留原始载荷。
- 费用完整性只受真实游标缺口、已识别用量损坏/冲突、实际请求缺用量等影响；不能从日志 kind=error 推导。收尾按该 run 的网关请求收据与原生用量核对是否覆盖全部调用；网关费用上界不重复记成另一笔实际费用。
- 运行状态与结算状态分开：内核已完成就保留 completed；费用缺失仍为 unknown、保留预留且阻止受影响运行继续花钱。订阅故障只恢复观察，不重发 prompt。否决“所有未知都停”和“所有解析失败都忽略”。

## 3. 改哪里
路径相对 `services/control/src/`：`bridge/openscience/mapping.ts` 的 schemas/mapRuntimeEvent 增加显式影响标记；同目录 `observation-store.ts` 同步信封校验，ingest/finishTerminal 去掉 error→usage_uncertain 通用联动；`budget/index.ts` 的 settleObservedRun/settleAmount 将终态与计费门禁分开。`api/runtime.ts`、`api/read-view.ts` 和数据投影透传费用状态，使用既有网关请求表核对，不另造费用来源。

## 4. 接口
内部映射新增 `accountingImpact:none|uncertain`、`diagnostic?:{code,eventType,fieldPaths}`；未知类型默认 none，真实缺费在收尾核对时判定。外层无效仍走观察故障。
run 返回保留 `state`、`usageUnknown`，新增 `accounting:{status:pending|settled|unknown,knownCny,totalCny,reason}`；未核全时 totalCny=null，knownCny 为已核明细合计，文案“费用待核对”。批准卡只由严格解析＋fresh pending snapshot 产生。

## 5. 验收项
1. 从走查失败 run 取实际 progress 事件核对差异，修复后重新真实走一遍 → 正常进度/收尾，无仅由 progress 引起的 USAGE_UNKNOWN。
2. 将已有事件在只读映射入口补一个字段、换成未知 phase/事件类型 → 留兼容诊断、游标继续；不新增费用、批准或模型请求。
3. 真实多轮运行 → 全部调用用量核齐才 settled；只收到部分用量时 totalCny=null，不因已有一笔正费用就判完整。
4. 用已存在的缺用量/失败运行检查 → 已知金额保留，缺项显示未知；已结束 run 不伪装成仍暂停等待执行。
5. 断开再连观察 → 只从持久游标补读，费用/卡片不重复；跨会话事件或坏审批参数仍拒绝。

## 6. 不做的事
不改 OpenScience、不自动批准、不重提历史 prompt、不批量改写旧账本；不扩做价格窗口或后台账单核对。仅在现有测试补针对性回归，实际走查花费遵守用户授权预算。
