# 05 · 关闭澄清、结算与重开的幂等状态机

状态：推荐方案，待用户确认；2026-10-27。来源：[走查 run7 C3/C3b/C4](../walkthroughs/2026-10-26-research-read/RESULTS.md)及用户报告的关闭 409；配合[卡 02](02-runtime-event-compatibility.md)、[卡 04](04-chat-clarify.md)。

## 1. 要解决什么
换篇/新建精读因旧澄清关闭冲突而卡住。现有关闭流程在 HTTP 收据事务外执行，重放还会再跑；重复选入已关闭但费用未知的 run，又会重算 hold、用同一事件键写变化的金额。409 具体来自 HTTP、结算还是事件去重须分别定位，不能一律吞掉。

## 2. 定下来的决定
- **关闭状态：active → closing → closed。** 首事务锁定档案修订号，保存 closeId 和当时的 targetRunIds，给这些 run 设置 closed 围栏、使旧待答问题失效，并与 HTTP 收据一起提交。closing 表示后续取消/核对待处理；取得取消结果或记录 unknown 后置 closed，仅表示交互已关闭，不假报原生终态。无活动 run 也成功返回空目标收据。
- **结算状态独立：pending → settled 或 unknown；unknown 仅在新证据核齐后 → settled。** 已结算直接读取原收据；同证据重复核对无副作用，不再把 settled 用 null 重结算。未知保留已知费用和未核部分的预留，不记零、不释放全部预算。补齐只追加差额一次；内容矛盾留待核对，不使关闭回滚。
- **重开条件是旧 run 围栏已提交，不是费用已结清。** 换篇在首事务清选择并递增 selectionRevision，保留候选；新建精读取得关闭受理回执后即可创建新 dossier。新的澄清仍须用户发话，并检查可用预算（扣除旧预留）；原生取消未知只挡旧 run，不形成账户级“忙”锁。真实余额不足仍拒绝。
- 同一操作重试沿用 key、路径和请求体，返回同一 202 收据；异内容才为 IDEMPOTENCY_CONFLICT。另以账户/档案/目标修订/动作去重，重复点击即使换 key 也复用原操作；先查已有操作，再判旧修订。后续处理按持久 closeId 恢复，不因 HTTP 重放再执行。取消发送意图先落库；结果未知只读核对，不重发 prompt。
- 旧关闭操作只能修改冻结的旧 run 和旧修订，不能扫描“当前全部运行”或再次把新一轮设 closed。迟到用量经受信对账归旧 run，迟到回复/取消结果不得清掉新选择；观察/对账可继续，但不恢复旧 run 的执行权限，费用更新不改变关闭事件原始内容。
- 否决“每次点击重新结算”“费用未知就禁止整个账户重开”和“409 一律成功”。“都不是 / 补充说明”沿卡 04 续聊，绝不触发关闭。

## 3. 改哪里
`services/control/src/clarify/lifecycle.ts::closeClarifications` 拆成持久受理与可恢复后续处理；新增 RLS 表 `clarify_close_operation` 保存 account/dossier/revision/action/closeId/targetRunIds/state，配合 read_clarify_run.closed。`api/read-clarify.ts` 的 cancel-clarify/unchoose、`budget/index.ts` 结算统一使用它；`mcp/authority.ts`、`model/gateway.ts` 拒绝旧 run 新动作，保留在途用量回报。`clarify_closed` 只写不变事实，金额另记。`src/data/read-live.ts` 的 cancelIntent/pendingMutation/creating 按档案＋修订隔离，失败 Promise 必须释放；切换后清旧意图，迟到响应按档案/epoch 丢弃，不改样式。

## 4. 接口
`POST /v1/dossiers/:id/read/cancel-clarify`、`/read/unchoose` 请求增加 `{selectionRevision}`，携带各自操作的 Idempotency-Key；返回固定 `202 {closeId,dossierId,targetRunIds,fenced:true,selectionRevision}`。副作用目标与收据同事务确定，后续错误不改写已受理的 HTTP 结果。`GET .../read-state` 返回 `clarification.close:{closeId,state,cancelStatus,accountingStatus,knownCny,unknownCost}`；取消未知明确显示 unknown，不假报 cancelled。重放读原回执；旧修订的新请求返回 CLARIFY_REVISION_CONFLICT 并刷新，不自动换 key 掩盖冲突。

## 5. 验收项
1. 分别重复同一次停止或换篇，并重放原请求 → 每个动作只一个关闭操作、同一回执；不重复计费、取消或出现正常重放的 409。
2. 旧 run 已 settled 后再关闭；或 unknown 后再次关闭 → 前者读原金额，后者保留“已知＋未知”，均可完成交互关闭。
3. 旧档案正在等待回答时新建精读并发话 → 围栏落库后新档案能建新 run；旧费用仍归旧档案，余额不足则明确说明，不静默等待。
4. 围栏提交后断开连接/重启控制面，再重试 → 返回原 closeId，恢复未完成处理；原生取消结果未知不引发重复模型调用。
5. 换篇后直接改选已存候选 → 不调用模型；再送达旧关闭/结算结果 → 新选择与新 run 不被清除，旧费用至多补记一次。
6. 点“都不是”并补充说明 → 同一 run 收到回答，不发生 question.cancelled/runtime.cancelled；金额不回到零。
7. 同 key 改请求内容，或用旧 selectionRevision 发起未曾受理的新动作 → 分别返回幂等冲突/修订冲突；旧冲突不污染新档案请求。

## 6. 不做的事
不回滚/改写历史账本，不把取消响应当费用证明，不自动释放未知预留，不自动重开模型，不扩大为通用工作流系统。只补现有测试的针对性回归，再按实际换篇/新建路径复验。
