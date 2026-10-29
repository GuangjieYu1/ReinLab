# P1-10 T-ROLE1～5 原生测试证据

2026-10-19，已安装 `services/account-runtime/node_modules/.bin/openscience`，ready.version=`2.0.150`；未运行上游源码。最终执行：

```sh
node_modules/.bin/vitest run services/control/test/role-runtime.test.ts --reporter=verbose --reporter=json --outputFile=evidence/P1-10/native-test-report.json
```

结果：**9/9 通过**，最终轮耗时 3.09 秒。机器可读报告为 `native-test-report.json`，原生 run 收据、终态及边界指标为 `native-test.json`。`model-requests.json` 保存 T1 两角色捕获到的完整 messages/tools 请求样本（仅 fixture、无 headers/token，临时 root 路径脱敏）。关闭前 readdir 确认 alpha/beta project 均仅包含 `.role-policy.json`、`AGENTS.md`、`openscience.json`。先于实现执行的红灯保留在 `red-test-report.json`（模块尚不存在，suite 导入失败）。

| 范围 | 实际断言 |
| --- | --- |
| T-ROLE1 | 对同一 dossier 的 alpha/beta 分别建立原生 session，捕获真实 provider HTTP 的完整 messages/tools；system 含自身 prompt 和自身 AGENTS memory marker，不含另一个角色的 prompt/memory。 |
| T-ROLE2 | 原生 read 成功读取当前 dossier sentinel；强制读取其他 dossier、另一角色 AGENTS、指向外部文件/目录/另一 dossier 的 symlink 共五种路径，均无成功 read，无秘密 sentinel 进入消息或后续模型上下文，run 均进入 completed。 |
| T-ROLE2 模板引用 | prompt 含 `{file:另一角色AGENTS绝对路径}` 或 `{env:TEST_FAKE_VALUE}` 时，prepareRoleProject 即返回 SCOPE_DENIED。两例 provider 请求增量均为零，没有新模型请求体携带对方 memory；只使用 fake env 名称，不读取真实环境值。 |
| T-ROLE2 故障安全 | 建立原生 session 后，把自身 AGENTS 换成另一角色 AGENTS 的 symlink；createSession 和 prompt 均在模型请求前返回 SCOPE_DENIED，provider 请求增量为零。 |
| T-ROLE3 | fixture 无视 offered tools，强制发出 bash/write/webfetch/todowrite；原生消息中有实际工具调用记录，均无原工具成功执行，无禁止文件，无 loopback observer 请求。 |
| T-ROLE3 写入授权 | 仅授 write + reports/：原生 write 确实写入授权文件；同 dossier 的非目标路径写入被拒；强制使用未授权 edit 别名被拒，授权文件内容保持不变。 |
| T-ROLE4 | 强制 task(subagent_type=data)，model offered tools 无 task，原生记录实际强制调用但无成功 task，children=[]；桥接拒绝额外 parts.subtask 和 agent，拒绝期间 provider 请求增量为零。 |
| T-ROLE5 | 同 session、requestID、内容的重放返回原 runID/acceptedAt，provider 请求增量零；变更内容返回 IDEMPOTENCY_CONFLICT/status409。 |

所有执行 helper 同时要求 snapshot.permissions=[]，不自动答复原生权限卡。原生可能把未提供工具转换成 invalid/unknown tool 或工具 error；负例以原工具无成功执行、无泄漏、无副作用与终态收口判断，不依赖单一错误文案。

## 原生差异与实现约束

初次执行发现：默认 approve 模式下 external_directory 属 risky，角色配置中的 allow 仍会形成原生 pending permission，正向 dossier 读取因此无法完成。生产桥接改为从 prepareRoleProject 私有计划中为新 session 预置当前 dossier 的只读 filesystem grant，并按实际编辑授权为 writeTargets 预置精确写入 grant。测试没有调 full、没有代答 permission，也没有在 fixture 内授 project/installation 范围。修复后正向读取与写入、五种跨边界负例全部通过。

## 隔离与费用边界

- 每轮创建独立临时 root、HOME、XDG config/data/cache/state；子进程 env 白名单仅含 PATH、这些隔离路径和显式 OPENSCIENCE 配置。未继承真实模型 key，未读取工作区 `.env`。
- 关闭默认插件、自动更新、models fetch、Claude prompt/skills、bundled skills、LSP 下载和自动压缩；显式加载仓库插件 file URL。
- 先绑定 loopback 端口 0 取得随机可用端口并释放，再用 `serve --port <随机端口> --format json` 启动已安装 CLI，解析 server.ready.url。避开上游 `--port 0` 优先尝试 4096 的行为。
- fixture 只监听 127.0.0.1，提供 OpenAI-compatible JSON/SSE，保存完整模型请求，使用 `fixture-not-a-secret`；关闭时终止 CLI 及原生进程组并等待管道关闭，随后删除临时目录。
- 最终轮 **39 次本地 fixture HTTP 请求，0 次 observer 请求，0 次真实模型请求，真实模型费用 0**。这些结果证明固定 fixture 下的原生执行与权限边界，不构成任何真实模型效果、token 费用或真实模型联网行为验证。
