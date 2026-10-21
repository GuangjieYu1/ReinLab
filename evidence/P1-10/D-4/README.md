# D-4 普通测试报告默认临时输出

作者验证结果：Node **v22.23.3**，helper **4/4**，默认模式定向回归 **76/76**，显式 OUT 定向回归 **72/72**；`pnpm lint`、`git diff --check` 通过。未运行全量 `pnpm test`。本汇总只陈述作者执行结果，独立评审结论由评审文件单独记录。

规格与计划见 `docs/tasks/D-4.md`。统一 helper 为 `services/control/test/fixtures/test-evidence.ts`：未指定有效 `REINLAB_EVIDENCE_OUT` 时，每次新建系统临时目录；旧 `REINLAB_EVIDENCE_TASK` 不授权仓库写入。角色、独立角色、Docker、local 观察及 ledger 导出均使用该 helper。

race 父进程每次创建唯一临时报告目录，通过子进程环境显式传递；子进程成功后只读取本次目录中的文件，再进行断言。仅父进程明确设置 OUT 时，验证成功后才复制本次报告到指定位置。不存在读取旧 `evidence/P1-10/review-toctou.json` 的路径，子进程失败会在读取报告前抛出。

## 先红与最终结果

- `red.json`：临时 workspace 中运行已有 Docker 独立 suite，子进程正常完成，但旧 writer 忽略指定 OUT，读取预期输出文件得到 ENOENT。该行为红灯未触碰真实归档。
- `helper-green.json`：4/4，覆盖默认目录唯一/位于临时目录、TASK 不影响目的地、显式 OUT，以及默认子测试运行不改写临时模拟归档 sentinel。
- `default-regression.json`：76/76，**移除 OUT，保留 TASK=P1-05**；覆盖 helper、原生角色、独立角色、Docker、race、ledger、local 独立测试。
- `explicit-regression.json`：72/72，为后六个测试文件明确设置本次 `D-4/explicit` 输出目录。
- `verification.json`：确认显式目录内 7 份预期报告全部存在；比对已有 303 份归档文件，变化 **0**。
- `archived-files-sha256.json`：本次回归前已有 303 份归档的 SHA256 清单，回归后逐项相同。

默认回归曾遇到 local 独立测试的 PG backend 统计异步可见问题：`pool.end()` 后立即读取 `pg_stat_activity` 偶尔仍显示一行。仅将该测试改为最多 1 秒轮询等待；旧池泄漏需要约 10 秒空闲超时才释放，仍会被该断言拒绝。未修改生产代码，复跑 76/76 全绿。

## 可复验命令

工作目录 `/Users/guangjieyu/.codex/worktrees/research-foundation/ReinLab`，Node22 与 pnpm 路径：

```sh
export PATH=/Users/guangjieyu/.local/share/reinlab/toolchains/node-v22.23.3-darwin-arm64/bin:/Users/guangjieyu/.nvm/versions/node/v24.14.1/bin:/usr/local/bin:/usr/bin:/bin
env -u REINLAB_EVIDENCE_OUT REINLAB_EVIDENCE_TASK=P1-05 pnpm exec vitest run services/control/test/test-evidence.test.ts services/control/test/role-runtime.test.ts services/control/test/independent-role.test.ts services/control/test/docker-independent.test.ts services/control/test/role-system-race.test.ts services/control/test/ledger.test.ts services/control/test/local-independent.test.ts --reporter=json --outputFile=evidence/P1-10/D-4/default-regression.json
REINLAB_EVIDENCE_OUT=/Users/guangjieyu/.codex/worktrees/research-foundation/ReinLab/evidence/P1-10/D-4/explicit pnpm exec vitest run services/control/test/role-runtime.test.ts services/control/test/independent-role.test.ts services/control/test/docker-independent.test.ts services/control/test/role-system-race.test.ts services/control/test/ledger.test.ts services/control/test/local-independent.test.ts --reporter=json --outputFile=evidence/P1-10/D-4/explicit-regression.json
pnpm lint
```

显式报告均为 loopback fixture/专用测试 PG；不声明真实模型、云端或真实容器验收。审计发现的其他普通测试对历史 evidence 为只读，临时 fixture 写入保留原用途；E2E runner 本身默认临时目录，无需修改基线。
