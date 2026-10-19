# P1-06 · 门禁状态机

通用六态门禁链：首段ready、后段locked；用户手动开始、讨论、批准，系统交回可审阅产物；批准只解锁后继。相同服务处理所有入口，HTTP actor固定来自已验签用户，拒绝自签system/任意状态/扩展scope。审阅必须引用真实同账户同档案artifact；本任务不声称该artifact已经过后续引用核对或文件验真流程。

expectedState+expectedRevision绑定当前审阅版本，拒绝讨论再交回后的旧批准。账户锁、行锁、业务更新、ledger追加和HTTP幂等收据在一笔事务内；事件写入失败整笔回滚。前驱/审阅外键跨账户与跨档案均不可关联。各工作流阶段清单留给对应任务，本任务提供可信服务初始化，不虚构研究阶段。

独立62项检查全部通过，评审通过；中断恢复后另一个独立agent实际复跑46项门禁测试，退出0，并保存当轮源码哈希。报告明确区分前任实测与恢复后的复测，不虚称历史报告含源码哈希。

ToSpec/ToTDD见`docs/tasks/P1-06.md`，初始红灯见`red-test-report.json`；迁移0004/0005追加新字段，未篡改已应用迁移。46个测试包括全部36状态对、身份、并发、跨域引用、ABA旧批准、事务故障；行覆盖50/50（100%）。独立测试和评审见同目录报告。

复现（Node22）：
```sh
pnpm db:up
pnpm exec vitest run services/control/test/gates.test.ts --reporter=json --outputFile=evidence/P1-06/test-report.json
pnpm exec tsc -p services/control/tsconfig.json
pnpm lint
VITE_BACKEND=mock pnpm build
```

本地真实PG与真实签名JWT；尚无Supabase云项目。本任务不调用模型、不开放未经验证的internal系统动作，也未进入P1-10。

全仓复跑501/501通过，进程退出0，双类型检查与mock构建通过。首次pnpm test出现JSON success=true、501断言通过但包装进程exit1，未找到可复现原因；保留这项不确定性，不将首轮计为通过。随后的完整default+JSON报告复跑退出0，没有未处理错误；原断言与校验均未放宽。

测试基础设施补充：P1-05导出文件只在显式REINLAB_EVIDENCE_TASK=P1-05时更新，日常全仓回归不会覆盖历史证据；其30秒续读和费用/脱敏断言保留。
