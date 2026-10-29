# P1-06 独立评审

结论：**通过，未发现阻断问题。**

范围：docs/tasks/P1-06.md、Q-020、BACKEND_SYSTEM §5、合同 P1-06、gates/index.ts、api/gates.ts、gate_chain / gate_revision 迁移、GateTransition / DossierDetail revision 契约及门禁测试。未改实现、前端或迁移；独立真实数据库验证在事务内进行并整体回滚，仅写本报告。

## 身份、状态与前置条件

- HTTP 只提供 start / discuss / approve，复用既有验签 / 账户初始化检查与持久幂等入口。actor 由服务端固定为 user，不从请求读取；严格 schema 拒绝 actor、任意 targetState、submit、审批 scope 等额外或系统字段。
- 六条合法边分别限制 user / system；系统不能开始或批准，用户不能提交 / 重新提交。可信服务函数留给后续工作流，没有开放 internal 路由或接入模型。
- 取得账户 ledger 事务锁后锁定 gate 行，同时比较 expectedState 与 expectedRevision，再判断状态边；讨论 / 再提交均推进 revision，防止 review→discuss→review 的 ABA 旧批准。
- review 必须引用 RLS 下真实存在的同档案 artifact；批准要求已有审阅引用。locked→ready 需要前驱 approved。批准只递归解锁下一段为 ready，不调用执行流程、不推进到 running。

## 数据、事务与并发

- gate 前驱与审阅产物的外键同时绑定 account_id / dossier_id；自引用禁止，每前驱最多一个后继。账户 RLS 继续有效，HTTP 先校验档案、再按该档案与 subject 查找 gate。
- 所有状态更新、revision、后继解锁与账本追加使用调用方同一事务；账本异常会使状态和 HTTP 幂等收据一起回滚。
- 统一先取得账户 ledger 锁，再 gate 行锁，appendEvent 再次取得同一可重入事务锁；自动解锁后继也保持此顺序，没有引入跨档案锁顺序反转。
- 不同 HTTP 幂等键并发会被序列化并比较同一旧版本，至多一项成功；同键由持久化收据返回原结果。可信系统服务函数依 expected state / revision 执行，后续工作流应传其实际观察版本。
- 初始化由可信调用方配置线性链，首段 ready、其余 locked；同链重放返回原 gate，不追加初始化事件；冲突顺序、部分链与重复 subject 拒绝。未在创建档案时猜测研究阶段名。不同独立链可由调用方明确配置。

## 独立验证

指定 Node v22.23.3 环境：

- 逐项检查 36 个状态对 × user/system，共 **72 项**；与指定六边图比较，**差异 0**。
- GateTransition 对自签 actor / 系统 submit 的 schema 验证均拒绝。
- lint 通过。

另在真实 Postgres 中建立随机账户、两档案与两产物，SET LOCAL ROLE reinlab_app 后绑定账户，事务整体回滚：

| 场景 | 结果 |
|---|---|
| 初始化两段并重复初始化 | 同 ID，状态 ready / locked |
| 使用同账户另一档案 artifact 提交 | REVIEW_EVIDENCE_REQUIRED |
| start→submit→discuss→resubmit | 正常，revision 递增 |
| 用首次 review 的旧 revision 批准第二次 review | GATE_STATE_CONFLICT |
| 最新 review 人工批准 | approved，后继仅 ready，后继 revision=1 |
| 上述事务账本动作 | initialized ×2、started、submitted、discussed、resubmitted、approved、unlocked |

已审阅父测 46 项设计，涵盖36状态对、跨账户 / 跨档案、并发幂等、账本故障回滚与 ABA。完整 HTTP / 覆盖结果以父 agent 及独立测试报告为准；本评审未重复运行会建立持久样本的完整套件。当前仅本地 PostgreSQL 和控制面验证，不扩展为 Supabase 云集成或后续工作流 / 模型执行验收。
