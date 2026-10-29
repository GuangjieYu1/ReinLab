# 账户作用域观察调度作者验收

Node v22.23.3，普通read-port/sink fixture与专用PG16真实binding/RLS adapter。没有真实模型、Auth账户或Docker操作。普通测试不写仓库证据，下列CLI明确outputFile归档。

```sh
export PATH=/Users/guangjieyu/.local/share/reinlab/toolchains/node-v22.23.3-darwin-arm64/bin:/Users/guangjieyu/.nvm/versions/node/v24.14.1/bin:/usr/local/bin:/usr/bin:/bin
pnpm exec vitest run services/control/test/observation-scheduler.test.ts --reporter=json --outputFile=evidence/P1-10/observation-scheduler/red.json
pnpm exec vitest run services/control/test/observation-scheduler.test.ts --reporter=json --outputFile=evidence/P1-10/observation-scheduler/implementation-check.json
pnpm exec vitest run services/control/test/decisions.test.ts services/control/test/observation-scheduler.test.ts services/control/test/observer.test.ts services/control/test/observed-settlement.test.ts services/control/test/budget.test.ts services/control/test/mapping.test.ts --reporter=json --outputFile=evidence/P1-10/observation-scheduler/regression-green.json
pnpm exec tsc --noEmit -p services/control/tsconfig.json
pnpm lint
git diff --check
```

有效stub red为8 failed/0 passed，adapter真实PG fixture正常，缺实现断言失败；随后实现8/8绿。组合 **182/182**：decisions32+调度8+observer27+settlement31+旧budget34+mapping50。control tsc/lint/diffcheck通过。

start只观察合法accepted且未ended的本账户binding，读端口来自真实bridge.runtime(...).reader()投影；去重、默认4并发、排队/活动shutdown、账户作用域recover、SDK前范围核验、无外层无限重连有测试。无全租户扫描或新增角色。无人访问时全局自动恢复未实现，留给P1-13。main/app与sinkFactory接入由root负责，本证据不假称生产接线已完成。独立review由root转交sourceaudit，尚待结论。
