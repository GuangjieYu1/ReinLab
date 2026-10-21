# RunBridge 独立评审

最终结论：当前 service 范围通过。发现的两个P2已由父任务修复，独立复跑4/4通过。尚未接入HTTP生产流程；本结论不宣称整个P1-10观察/翻译/审批/计价链路完成。

## RB-1 [P2，已关闭] 预算行锁与ledger锁顺序倒置

原预算事务先锁os_binding/run行，再经authorizeTool取ledger账户advisory锁；既有increaseRunBudget/settleTool等路径先取ledger锁再读写run行。正常并发追加预算与提交可互相等待，至少一个事务失败，提交前准备租约也未立即消失。

有效红灯：`independent-run-bridge.test.ts` 使用同一fixture账户的两个应用数据库pool；预算追加事务先持有ledger锁，提交事务进入真实PG advisory等待后再允许追加继续。两操作期待都成功，旧实现出现一个rejected，`run-bridge-independent-red.json`保留失败。此为既有正常预算操作的本地正确性并发回归，没有真实模型/账户服务。

修复依据：`run-bridge.ts` 预算事务第一项先 `lockBudget(c,accountId)`，再取绑定/run行锁；复核与预算模块统一。独立复跑并发操作均fulfilled且prompt调用一次，关闭本项。

## RB-2 [P2，已关闭] 拒绝预算时pause/approval被回滚

原authorizeTool返回allowed=false前可能调用pause写入paused_budget、待审批卡和budget_paused事件；RunBridge在withAccount回调内立即throw，事务回滚导致运行仍queued且没有持久预算门禁。

有效红灯：fixture run预算1、真实划拨0.5，提交得到BUDGET_EXCEEDED且0个prompt；数据库state却仍queued（应paused_budget）。修复改为事务内return false让pause正常提交，在withAccount返回后再抛稳定BUDGET_EXCEEDED。独立回归确认paused_budget和单个pending budget approval均持久化、0个prompt，关闭本项。

## 其余安全/幂等核对

- BindingStore.prepare在run锁下核对账户RLS、dossier及role，requestId直接取run.request_id；sessionID由服务端生成并持久化，重试复用，不从用户任意session输入获得执行权限。新增004复合FK归另一agent独立评审，本报告不修改迁移或代替其结论。
- 提交只在明确submit入口：先claim、capabilities协议/版本校验、固定ID create、空run snapshot、baseline持久化，再预算事务检查租约/run状态并落hold和runtime_admitted事件；最后sendIntent独立提交为不可回退的submitting后才prompt。控制runtime测试在prompt入口使用另一数据库连接核对phase=submitting、hold_id存在且reserved、requestID等于run.request_id，证明这些写入已提交。
- session绑定唯一且首次snapshot若已有任何run即BINDING_SESSION_OCCUPIED，避免上游“忙session新请求可能加入旧run”的隐式follow-up路径；租约、基线和发送意图阻止同时submit成为第二次prompt。
- 已有receipt直接返回；submitting但无receipt仅restore+snapshot，按requestID及sessionID匹配权威run后保存receipt，不调用prompt。没有匹配run则持续indeterminate，不换requestID或新session，不把“没看到收据”误当从未提交。
- 追加controlledruntime故障测试：上游接受后丢响应，首次indeterminate，后续新RunBridge实例只snapshot找回同收据，总prompt一次。另一场景记录一次未知prompt尝试但上游snapshot始终无run，后续两次恢复仍indeterminate、总尝试一次、phase仍submitting。没有用固定返回收据的stub掩盖重发。
- immutable definition/input hash导致同run异内容冲突；已有accepted路径不重新reserve或prompt。request/role不由模型文本修改。预算hold取完整当次run预算，后续实际费用结算和unknown价格处理仍属独立模块。

## 证据与边界

- 独立新增并运行 `services/control/test/independent-run-bridge.test.ts`：修前4项2失败/2通过，修后4/4通过（`run-bridge-review-green.json`）。使用本机55432测试PG、随机fixture账户和仅test文件中的controlledruntime；未执行模型/真实账户资源，没有secret读取。
- 只读核对原 `run-bridge.test.ts` 三种native重启场景及父任务 `run-bridge-independent-green.json`：独立4+native3共7/7；native三项由父任务运行，本评审未为此并行再启动内核。
- 测试strict tsc及依赖边界检查通过。只新增本测试和本报告，没有修改共享RunBridge/BindingStore/迁移生产实现。
- 观察器未获得submit接口、运行终态落账、pending决定fresh snapshot检查及费用hold结算须由后续observer/service集成独立验收；本次仅批准当前提交/恢复service边界。
