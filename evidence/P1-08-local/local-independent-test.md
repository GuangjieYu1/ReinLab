# 本地配置与 Auth 队列独立测试

结论：最终 Node **v22.23.3** 定向回归 **26/26 通过**，无失败或跳过。范围为独立测试 16 项、配置作者测试 3 项、真实 PG 队列作者测试 4 项、verification-auth fixture 测试 3 项。未运行全仓、local:up 或真实 Auth 注册，也未创建、运行或删除真实账户容器。

新增文件：`services/control/test/local-independent.test.ts`。生产实现由主任务修复，本独立测试未修改生产代码。PG 使用 `127.0.0.1:55432/reinlab_test` 专用测试库，独立队列 fixture 在事务里写入随机 account/job 并最终 ROLLBACK；没有触碰实际 Supabase Auth 用户或读取真实 secret。

## 有效先红与修复复验

初始独立报告 `local-independent-red.json` 在 Node24 下 **8 通过 / 7 失败**；随后 Node22 确认同样 7 项失败，见 `local-independent-node22-red.json`（增加冷却重试项后为 9 通过 / 7 失败）。这些均为实际断言失败，而非测试准备失败。

| 问题 | 先红观察 | 最终复验 |
|---|---|---|
| DB URL query/hash 未拒绝 | host/port/sslmode 查询参数与 fragment 被 parser 接受 | 四项均拒绝，不发网络请求 |
| 子进程超时误成功 | 子进程处理 SIGTERM 后 exit 0，quietCommand 返回成功 | 明确 LOCAL_COMMAND_TIMEOUT |
| 祖先 symlink 导向其他目录 | 临时目录 redirect → outside，嵌套 private env 写入成功 | 写入前拒绝 |
| 私有 env 字符串编码不无损 | 允许的引号与反斜杠值经过写入/读取后改变 | 原样 roundtrip |

主任务同步加固了 bootstrap 的本地 DB URL 边界。这里未调用会实际改角色密码、迁移真实 Supabase 的 bootstrap；相关结论仅包括代码检查与 parser 回归，不冒充真实 bootstrap 集成验收。

## 其他通过项目

- 私有文件 hardlink 与 FIFO 均拒绝，原始 fixture 内容未改；所有文件均为临时生成，不读真实秘密文件。
- 子进程失败输出包含测试 sentinel 时，对外只有固定错误码。
- PG 业务角色不能 claim、finish 或直接执行 Auth 触发器函数。
- PG worker 不能直接读写私有队列，也不能读取业务 account 表。
- 租约到期后被新 worker 重领，旧 worker、其他 account 或重复 acknowledgement 均不能完成任务。
- 第八次尝试的有效租约保持 leased；过期后终结为 failed，清除 owner/lease 并记录固定耗尽码。
- 非法 error code 不会 acknowledgement 当前租约；失败重试在冷却期内不可立即重领，冷却结束才增加下一次 attempt。
- 特权 worker 启动被拒绝后，专属 application_name 的 PG 连接数归零。
- verification-auth 三项全部使用传入 fixture fetch；覆盖丢失注册响应后复用同身份、已注册后仅登录，以及瞬态故障不转为新注册。未调用真实 Auth 服务。

## 执行与输出

工作目录 `/Users/guangjieyu/.codex/worktrees/research-foundation/ReinLab`，分支 `codex/p1-08-local`；未切换分支或提交。

```sh
PATH=/Users/guangjieyu/.local/share/reinlab/toolchains/node-v22.23.3-darwin-arm64/bin:/Users/guangjieyu/.nvm/versions/node/v24.14.1/bin:/usr/local/bin:/usr/bin:/bin REINLAB_EVIDENCE_OUT=/Users/guangjieyu/.codex/worktrees/research-foundation/ReinLab/evidence/P1-08-local pnpm exec vitest run services/control/test/local-independent.test.ts tooling/local/config.test.ts services/control/test/provision-queue.test.ts tooling/local/verification-auth.test.ts --reporter=json --outputFile=evidence/P1-08-local/local-independent-report.json
```

`local-independent-report.json` 为最终 26/26 的原始 Vitest JSON；`local-independent-observations.json` 为独立 16 项观察摘要，仅包含状态与固定代码。测试 afterAll 默认写新建的系统临时目录，只有明确指定 `REINLAB_EVIDENCE_OUT` 才将观察写到该目录，遵循 D-4。

原先 Node22 npx 路径已失效导致的一次启动错误未执行测试，不计入产品红灯；最终使用主任务已验证的官方 Node22 工具链完成复验。未新增故障注入或扩大到外部目标、真实凭据或真实容器。
