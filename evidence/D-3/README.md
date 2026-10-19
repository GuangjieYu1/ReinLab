# D-3：默认关闭内置委派

生产默认 delegation:false；仅 NODE_ENV=test 且构造参数 testOnlyDelegation:true 时开启。prompt严格schema拒绝客户端传delegation。默认和开启测试开关时，原生task:deny均拒绝派发、children为零。

ToSpec/ToTDD见docs/tasks/D-3.md。最终相关测试20/20、0失败、0跳过，test-report.json；独立HTTP/构造10/10、原生T4两种状态2/2，independent-test.md/json；独立代码评审通过review.md。lint、控制面类型检查通过。

red-test-report.json来自修正后的fixture对eedd591旧实现的回归：默认HTTP delegation与生产开关隔离两项失败，显式true项通过。最初缺steps只在setup阶段失败，单独保留setup-failure与initial-delegation-setup-failure报告，不将其作为有效行为红灯。修正fixture后恢复最终实现并全量重跑相关用例。

复验（Node22，锁定依赖安装后）：
```sh
pnpm exec vitest run services/control/test/delegation-default.test.ts services/control/test/delegation-independent.test.ts services/control/test/role-runtime.test.ts
pnpm lint
pnpm exec tsc -p services/control/tsconfig.json
```

本任务未改上游与前端。D-4仍按第三批顺序在P1-10后续修复，目前原生角色测试会写旧P1-10证据；本次重跑造成的旧证据改写已按提交版本原样恢复，未将它们混入D-3。T-REG将在下一任务原样入库并执行，本批送审会附最终报告。
