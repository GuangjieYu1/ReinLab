# P1-10 observed settlement 作者验收

执行环境：Node v22.23.3，真实本机 PG16 专用测试库，应用连接为受强制 RLS 的 reinlab_app。未调用真实模型/Auth/账户 Docker 资源。新测试普通运行不写仓库证据；以下 outputFile 是显式本次归档。

```sh
export PATH=/Users/guangjieyu/.local/share/reinlab/toolchains/node-v22.23.3-darwin-arm64/bin:/Users/guangjieyu/.nvm/versions/node/v24.14.1/bin:/usr/local/bin:/usr/bin:/bin
pnpm exec vitest run services/control/test/observed-settlement.test.ts --reporter=json --outputFile=evidence/P1-10/observed-settlement/behavior-red.json
pnpm exec vitest run services/control/test/observed-settlement.test.ts services/control/test/budget.test.ts --reporter=json --outputFile=evidence/P1-10/observed-settlement/green.json
pnpm lint
pnpm exec tsc --noEmit -p services/control/tsconfig.json
git diff --check
```

- `design-red.json`：设计阶段缺内部入口，1 failed/2 passed，不能替代行为回归。
- `setup-failure.json`：首次真实 fixture 违反004 role_options约束；不是功能红灯。
- `setup-parameter-failure.json`：修正 fixture 后 SQL 参数类型推断冲突；不是功能红灯。
- `behavior-red.json`：修正 fixture 后 23 failed/3 passed；运行/绑定/保留/usage/ledger fixture 正常建立，结算入口尚不存在。此后才实现。
- `implementation-check.json`：实现后新增26+旧34 =60/60。
- `green.json`：补足 ancestor run、漏 cost、null精确匹配、aggregate 溢出与缺 binding，新增31+旧34 =**65/65**。

Node22 静态检查初次结果：`git diff --check`通过；lint 被并行 Harness 文件 packages/contracts/src/bench.ts 与 bench-manifest.test.ts 的 require 属性调用阻断；tsc 被 harness/manifest.ts:23/:92 undefined 类型诊断阻断。未改这些非本任务文件；budget 未报告 TS 诊断。后续结果单独记录，不把此次失败改成通过。

已交 docker_driver 独立评审，作者报告不宣称独立评审已通过。所有旧归档证据未修改。

后续最终 Node22 复跑：pnpm lint 与 control tsc 均已通过；diffcheck通过。并行 Harness 的初始阻断已消除，初始记录保留。
