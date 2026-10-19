# P1-05 · 账本、SSE续读与审计

真实Postgres只追加账本，账户级事务锁保证同档案提交与可见顺序；去重键同内容重放原序号、异内容冲突。RLS和复合外键阻止跨账户、跨档案引用。SSE每100条短事务续读，不长期占数据库连接，支持Last-Event-ID、after、取消、心跳和脱敏中断信息。JSONL导出单语句快照与末行summary，六位费用字符串精确合计，未知费用、额度和GPU分列。

ToSpec/ToTDD：`docs/tasks/P1-05.md`；红灯记录在`red-test-report.json`。本地数据库中的测试记录是集成测试输入，不用于live模型路径。本任务未调用模型、未进入P1-10翻译层。导出示例`ledger-export.jsonl`来自本地集成测试，不是云账单。

复现（Node22）：
```sh
pnpm db:up
pnpm exec vitest run services/control/test/ledger.test.ts --reporter=json --outputFile=evidence/P1-05/test-report.json
pnpm exec tsc -p services/control/tsconfig.json
pnpm lint
VITE_BACKEND=mock pnpm build
```

最终结果：本项23/23、全仓455/455通过，失败0；模块行覆盖57/58（98.27%），类型检查、边界检查与mock构建通过。独立67项检查通过（含61个独立样本），复审通过；首次脱敏遗漏及Zod3科学计数精度缺口记录保留。250个前端文件哈希一致，凭据模式扫描0命中，见verification.json。

本项包含真实30秒断线后的105条跨批续读和序列逐项比对。独立TCP测试另测心跳、取消、30秒后续读；独立测试、评审、覆盖率和全仓报告分别保存在本目录。

边界：全局bigserial在不同档案、回滚和去重之间有空号；续读保证可见事件顺序及完整性，不捏造连续序号。金额单事件最多六位，拒绝超精度而非静默取整。API字段与脱敏约定见questions Q018/019。

参考：[Hono官方Streaming](https://hono.dev/docs/helpers/streaming)及锁定4.13.13实际stream实现，尤其是流内异常不会进入app.onError；本实现捕获后只输出固定中文错误，不打印原异常。
