# D-3 独立代码评审

范围：第三批首提交的委派默认值修复；审阅 role-runtime.ts、delegation-default.test.ts、role-runtime.test.ts、docs/tasks/D-3.md，对照主仓库 CODEX_BRIEF_BATCH3.md 与 BATCH2_REVIEW.md。未修改生产代码，未运行原生全套，未修改旧 P1-10 证据。

## 代码核查

- RoleRuntime 实例字段默认由 `options.testOnlyDelegation === true` 得到false；仅显式true且NODE_ENV严格等于test才可开启，其他环境显式true在构造时SCOPE_DENIED。
- prompt严格只收sessionID/requestID/message；额外delegation或testOnlyDelegation不能进入请求。SDK传递的delegation来自实例固定值，未新增模型/请求body控制路径。
- research/task权限、插件补闸、会话绑定、全局插件校验、请求deadline和错误处理均未放宽。
- requestID仍原样传递，未生成新ID、添加重试或修改message/sessionID；同一实例的delegation值固定，重复提交的原生指纹输入保持稳定。切换委派策略并不是同一个完整内核payload，不能把跨策略修改宣称为精确重放；本D-3范围不交付控制面/内核重启恢复。
- 原生T-ROLE4改为false/true各一例：均强制task调用、断言无成功task与无子会话、task不在offered tools，且额外parts/agent拒绝。true分支避免仅靠总开关制造权限测试假阳性。
- D-3任务说明保持仅本缺陷与相关测试，不提前T-REG、本地化或完整翻译层；与批次顺序一致。

## 初轮测试阻断

独立以Node24仅运行delegation-default.test.ts：3例中1通过、2失败。两个实际HTTP捕获测试的prepareRoleProject角色输入漏掉必填steps，导致发送HTTP前即SCOPE_DENIED，尚不能据其证明false/true提交值。已反馈父任务只修测试输入。该失败不代表默认值生产修复错误，但在补齐并重跑前不能给测试证据通过结论。

## 最终结论

**通过 D-3 本次最小修复。无未关闭的阻断发现。**

测试输入已补steps:8。独立以显式Node24复跑delegation-default.test.ts，3/3通过（180ms）：生产环境显式true被拒绝，实际本地HTTP捕获默认false及测试显式true。评审者没有运行原生全套或改写旧P1-10证据。

检查有效red-test-report.json：针对旧实现的失败为默认委派实际true（期望false），以及生产环境构造测试开关未拒绝；并非setup失败。最初缺steps报告单独保留为setup-failure-report.json，不作为行为红灯依据。审阅父任务最终test-report.json：13/13通过，其中原生T-ROLE4的false与true两个状态均通过；这部分是对独立测试/父任务报告的只读核对，不冒充评审者亲自执行的原生测试。

默认关闭是进一步收紧；测试显式开启仍受NODE_ENV和原有task权限双重约束。SDK输入的sessionID/requestID/message路径未变化，同一实例内精确重放保持固定委派字段，没有新增重试、改号或绕过严格输入的逻辑。任务说明与第三批首提交要求一致；D-4、重启幂等补测及T-REG不在本次D-3通过范围内。
