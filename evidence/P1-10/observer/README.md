# CR-3 observer 作者验收

Node v22.23.3。测试仅用 runtime read-port 与 sink fixture，不声称 SDK/native/DB 集成已通过；root另做最终集成。普通测试不写仓库证据，下列CLI明确 outputFile 才归档。

```sh
export PATH=/Users/guangjieyu/.local/share/reinlab/toolchains/node-v22.23.3-darwin-arm64/bin:/Users/guangjieyu/.nvm/versions/node/v24.14.1/bin:/usr/local/bin:/usr/bin:/bin
pnpm exec vitest run services/control/test/observer.test.ts --reporter=json --outputFile=evidence/P1-10/observer/red.json
pnpm exec vitest run services/control/test/observer.test.ts --reporter=json --outputFile=evidence/P1-10/observer/green.json
pnpm exec vitest run services/control/test/observer.test.ts services/control/test/observed-settlement.test.ts services/control/test/budget.test.ts services/control/test/mapping.test.ts --reporter=json --outputFile=evidence/P1-10/observer/regression-green.json
pnpm lint
pnpm exec tsc --noEmit -p services/control/tsconfig.json
git diff --check
```

red.json是空实现17失败/1通过；implementation-check.json为首轮18/18；green.json为扩展后的25/25。lint/control tsc/diffcheck通过。组合定向回归 **140/140**，完整报告为regression-green.json。

覆盖严格提交顺序与backpressure、DBcursor恢复、500/1000ms退避及三连接上限、EOF/稳定故障码、replay/SSE过期及cursor-ahead、终态前入账/异run与异session/非法终态body、快照终态独立同步、asked新快照、sink失败不重试、abort不记服务故障。gap仅委托sink事务移动游标，不从snapshot私跳。独立评审已请求，尚不声明评审通过。

最终追加可信ingest的CURSOR_GAP/CURSOR_EXPIRED恢复两项，gap-green.json **27/27**。gap reason已扩展两种稳定码，其他sink错误仍停止不重试。此前组合140/140为25项observer版本历史。docker_driver独立27/27通过，另有store/independent/observer组合36/36，其独立报告由评审者另写。
