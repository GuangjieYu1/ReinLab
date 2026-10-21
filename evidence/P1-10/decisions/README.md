# P1-10 DecisionService 作者验收

Node v22.23.3，真实PG16迁移与reinlab_app强制RLS；runtime端口为测试fixture。没有真实模型、Auth账户或Docker资源操作。普通测试不写仓库证据；本目录仅显式outputFile归档。

```sh
export PATH=/Users/guangjieyu/.local/share/reinlab/toolchains/node-v22.23.3-darwin-arm64/bin:/Users/guangjieyu/.nvm/versions/node/v24.14.1/bin:/usr/local/bin:/usr/bin:/bin
pnpm exec vitest run services/control/test/decisions.test.ts --reporter=json --outputFile=evidence/P1-10/decisions/red.json
pnpm exec vitest run services/control/test/decisions.test.ts --reporter=json --outputFile=evidence/P1-10/decisions/green.json
pnpm exec vitest run services/control/test/decisions.test.ts services/control/test/observer.test.ts services/control/test/observed-settlement.test.ts services/control/test/budget.test.ts services/control/test/mapping.test.ts --reporter=json --outputFile=evidence/P1-10/decisions/regression-green.json
pnpm exec tsc --noEmit -p services/control/tsconfig.json
pnpm lint
git diff --check
```

- preliminary-red.json：25项初始stub红；其中问题参数用例被it.each展开，已修为对象参数，不当成精确fresh问题行为依据。
- red.json：修正参数化后的有效stub red，24 failed/0 passed，真实fixture正常建立；随后才实现服务与010。
- setup-migration-failure.json：并行007_harness的SQL转义setup失败，24 skipped，不计服务红/绿。作者修复007后才继续。
- implementation-check.json：真实010+服务30/30绿。
- regression-green.json：decisions30+observer27+settlement31+旧budget34+mapping50 =172/172。
- green.json：最后保留外部expired状态及取消已resolved的竞争防护后，服务30/30绿。

control tsc、pnpm lint及diffcheck通过。关键验证：事务prepare不读runtime且回滚；同意图重放/异意图冲突；发送前CAS持久化，双dispatch仅一次SDK；未知/indeterminate重启后不重发，消失expired+runinterrupted；fresh问题错误400保持unsent；危险和未知permission不可approve；严格kind/account/session/request绑定；cancel只绑定目标，持久一次发送且不确定只读；DB拒sent倒退/intent改写。

已交docker_driver独立审查，作者记录不预先声称独立审查通过。实际原生SDK+DB端到端由root另验。

root追加API前置validate：validate-green.json **32/32**，证明400后未写意图、修正答案后能validate→prepare→dispatch成功，以及已resolved同hash重试不误判expired。API需先validate再commit prepare，dispatch仍二次fresh。最终连同调度器的组合回归 **182/182** 在 ../observation-scheduler/regression-green.json；control tsc/lint再次通过。旧30及172报告保留为历史，不冒充新增validate前的结果。
