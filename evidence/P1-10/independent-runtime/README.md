# 角色存储、恢复与观察接口独立回归

结论：Node **v22.23.3** 定向测试 **17/17 通过**，无失败或跳过。未改生产代码；只执行已有新增测试，无额外故障注入或外部目标。

| 测试文件 | 通过 |
|---|---:|
| account-role-store.test.ts | 1 |
| role-plan.test.ts | 4 |
| remote-role.test.ts | 6 |
| runtime-recovery.test.ts | 3 |
| runtime-observation.test.ts | 3 |

覆盖角色受管回执与摘要、不可变角色版本、并发准备；远程回执账户/路径/摘要/插件核对及复用前复查；控制面重启、进行中重放、内核重启三种情形取得原收据且不增加模型 fixture 请求，变更内容仍冲突、外角色不能恢复；只读观察端口、真实 SDK SSE、cursor 冲突、决定转发与取消等现有断言。

runtime-recovery 使用实际锁定 npm OpenScience 2.0.150 + loopback 模型 fixture；其他涉及网络的测试使用本地 HTTP 服务或明确传入的 fixture transport。没有真实模型、真实 Auth signup、真实账户容器或真实凭据操作。只读检查了测试实现后执行；不把测试通过扩展为全部翻译层设计审查。

工作目录 `/Users/guangjieyu/.codex/worktrees/research-foundation/ReinLab`。本次实际输出目录为仓库外 `/tmp/reinlab-independent-runtime.4A1Sri`，测试环境 `REINLAB_EVIDENCE_OUT` 指向该目录；完成后只将本次 Vitest `report.json` 复制至当前证据目录，并新增本说明。未复制旧归档或整个临时目录，未做 git 提交。

执行命令：

```sh
export PATH=/Users/guangjieyu/.local/share/reinlab/toolchains/node-v22.23.3-darwin-arm64/bin:/Users/guangjieyu/.nvm/versions/node/v24.14.1/bin:/usr/local/bin:/usr/bin:/bin
REINLAB_EVIDENCE_OUT=/tmp/reinlab-independent-runtime.4A1Sri pnpm exec vitest run services/control/test/account-role-store.test.ts services/control/test/role-plan.test.ts services/control/test/remote-role.test.ts services/control/test/runtime-recovery.test.ts services/control/test/runtime-observation.test.ts --reporter=json --outputFile=/tmp/reinlab-independent-runtime.4A1Sri/report.json
```

完整机器报告：`report.json`。本轮未发现测试失败或需反馈的实现问题。
