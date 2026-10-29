# D-1 独立测试记录

- 范围：只新增 `services/control/test/independent-d1.test.ts`；未更改生产实现、主测试或 fixture。
- 环境：Node v22.23.3，工作树 `research-foundation/ReinLab`，分支 `codex/d-1-http-recovery`。
- 执行：`PATH=/Users/guangjieyu/.npm/_npx/52027bd8fc0022aa/node_modules/.bin:$PATH pnpm exec vitest run services/control/test/independent-d1.test.ts --reporter=json --outputFile=evidence/D-1/independent-test.json`。
- 最终结果：22 / 22 通过，退出码 0；原始 Vitest JSON 见 `independent-test.json`。

覆盖：

1. BEGIN、set_config 两处断连均重新借连接，完整重做 BEGIN 和账户上下文；业务仅执行一次；首次坏连接销毁，监听器移除。
2. 连续两次前置断连仅借两次连接，返回第二次原始错误，业务从未开始。
3. work 或 COMMIT 断连时，模拟外部副作用仍恰好一次，返回原始错误且不再借连接。
4. 42501、40001、40P01、53300 均不重借；普通包含 connection 字样的错误也不误判重试。
5. 57P01、57P02、08006、ECONNRESET、EPIPE、ETIMEDOUT 及驱动无 SQLSTATE 的三种明确断连消息可前置恢复。
6. 已借出连接 error 事件的恢复边界、非法账户在借连接前被拒。
7. 真实 PostgreSQL 应用角色、真实 JWT 验签、真实事务与 RLS：在一次 set_config 前置故障后确认新后端 PID，使用 sub=A / account_id=B 的有效签名 JWT 仍只返回 A；查询所有 account 仅看到 A，无法读 B；后续 sub=B / account_id=A 仍返回 B；事务外零行。随机 A/B 账户用毕清理。

边界说明：第 7 项故障采用代理注入 SQLSTATE 57P01，明确不是第二份真实断线复现；真实服务端终止而池尚未感知的红灯证据与 fixture 由主任务独立维护。独立测试未调用 pg_terminate_backend，未读取 env 文件或输出连接凭据。首次运行的 13/14 是测试中错误假设 HTTP 仅借用两次连接；查明账户校验中间件和 /me 各执行一个事务后将正确预期改为三次，最终扩展到 22/22。

本记录只证明该独立文件的 Node22 定向执行；Node22/24 全量与连续五轮由主任务另附报告。

## 资源释放边界追加红灯

在首次七轮全量通过后，主任务要求进一步明确：一旦识别为断连，不论是否仍可重试，均应 `release(true)` 丢弃该连接。已在连续两次前置断连和 work/COMMIT 断连共四个用例加入精确断言；fake rollback 刻意成功，使断言不依赖 rollback 失败间接标坏。

Node v22.23.3 定向执行结果为 18 通过 / 4 失败，退出码 1；原始记录为 `resource-red.json`。这四项失败分别来自第二次 BEGIN 前置断连、第二次 set_config 前置断连、work 断连和 COMMIT 断连，均显示已知断连却释放为非坏连接。此追加轮次未修改生产实现；最终修复后结果以主任务重新执行的同代码七轮全量为准。


## 资源边界修复后独立复验

主任务在断连分类后加入 `if(lost)broken=true`，随后独立复跑相同 22 个用例：Node v22.23.3，22 / 22 通过，退出码 0，最新原始报告已更新 `independent-test.json`。本轮未改测试源码。

四项资源红灯现全部转绿：第二次 BEGIN/set_config 断连，以及 work/COMMIT 断连，即使 fake rollback 成功也精确验证 `release(true)`。work/COMMIT 用例仍验证业务副作用只发生一次、连接只借一次、原始错误向上传递，因此丢弃断连客户端没有引入业务重放。此前的 `resource-red.json` 保持原样，形成可追溯的红绿证据。
