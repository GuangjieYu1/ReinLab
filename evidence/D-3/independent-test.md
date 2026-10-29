# D-3 独立测试

结论：**通过**。Node **22.23.3**，真实 npm OpenScience **2.0.150**；HTTP/构造参数测试 **10/10**，原生 T-ROLE4 两种开关状态 **2/2**。仅选择 D-3 相关测试，未启动全仓测试。

依据：主仓库 `design/reviews/CODEX_BRIEF_BATCH3.md` 第四节 D-3。检查当前分支 `codex/d-3-delegation-default` 的 `role-runtime.ts` 后，独立运行作者的 `delegation-default.test.ts` 和原生 T-ROLE4，并新增 `services/control/test/delegation-independent.test.ts` 验证边界。

| 验证 | 结果 |
|---|---|
| 未传测试开关时，实际本地 HTTP prompt payload | `delegation: false` |
| 测试环境显式 `testOnlyDelegation: true`，实际 HTTP payload | `delegation: true` |
| `production` 默认构造并发送 prompt | `delegation: false` |
| production/development/未设置 NODE_ENV/`test ` 开启测试开关 | 均 `SCOPE_DENIED` |
| 构造后修改传入 options | 默认 false 保持 false；显式 true 保持 true |
| prompt 请求体注入 `delegation: true` 或 false | 均拒绝，无额外 HTTP prompt |
| 原生关闭 delegation，模型 fixture 强制 task | task 未向模型提供，强制调用失败，children 为 0 |
| 原生开启 delegation，模型 fixture 强制 task | task 未向模型提供，强制调用失败，children 为 0 |

两种原生情况同时核对 parts.subtask/agent 注入拒绝，以及注入前后模型 HTTP 请求数量不增加。开启 delegation 的测试证明 task 权限防线仍在起作用，拒绝并非只靠总开关。

执行命令（均使用指定 Node22 PATH）：

```sh
pnpm exec vitest run services/control/test/delegation-default.test.ts services/control/test/delegation-independent.test.ts --reporter=json --outputFile=/tmp/reinlab-d3-unit-independent.json
pnpm exec vitest run services/control/test/role-runtime.test.ts -t T-ROLE4 --reporter=json --outputFile=/tmp/reinlab-d3-native-independent.json
```

发现一项测试准备问题：首轮作者的 HTTP fixture 缺少必填 `role.steps`，两项在 `prepareRoleProject` 处失败，未进入 payload 断言。通知作者补 `steps: 8` 后复跑全绿。此准备失败不能作为旧实现的有效回归红灯；本报告不作此声明。当前未发现 D-3 产品实现缺陷。

完整机器报告见 `independent-test-report.json`，包含两份原始 Vitest JSON 及观察摘要。测试只用临时目录、本地 HTTP 和 fixture provider，不连接真实模型，不读取 `.env`，不记录认证 token/headers。未改生产实现；原生套件因待修 D-4 改写旧 `evidence/P1-10` 文件，按要求未提交或还原，由主任务统一处理。
