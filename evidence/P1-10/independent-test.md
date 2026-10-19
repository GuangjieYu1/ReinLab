# P1-10 独立攻击测试

范围：`services/control/test/independent-role.test.ts`，独立于 `role-project.test.ts`、`role-runtime.test.ts`；只经控制面 bridge 调用运行逻辑，故障注入仅用本地原生 HTTP。未导入 SDK、未执行或修改上游源码。

环境：Node 22.23.3；实际 npm OpenScience **2.0.150**；隔离 HOME/XDG；测试 loopback OpenAI-compatible provider。不连接真实模型、不读 `.env`、不访问外网，不输出认证 token/headers。原生服务就绪事件断言版本，实际模型 HTTP 请求均来自 fixture。保留原生 sandbox，正式插件注册在受信任全局配置中，模拟 account-entrypoint 部署。

攻击面：

- 复制/继承合法 descriptor 的对象伪造；roleId 路径注入及 writeTargets 规范化逃逸。
- `openscience.json`、`AGENTS.md`、`.role-policy.json` 的内容、hardlink、symlink 篡改；现有受管文件不被覆盖。
- 祖先 `.git` 文件；已签发 project 的 dossier 目录替换和目标目录 symlink。
- 其他 runtime 的 session 在 prompt/snapshot/messages/children 上均拒绝；额外 agent、parts.subtask、directory、delegation、effort 字段均在模型 HTTP 前拒绝。
- 给同一原生 session 注入其他档案及其他 role 目录的持久 filesystem read grants，强制模型 read 仍拒绝；不依赖缺少 filesystem grant。
- exact write target 与授权 edit 正向执行；同前缀 sibling 文件及目标 symlink 拒绝。
- 当前档案中指向其他档案文件的 hardlink read；外部文件 hardlink 的 write/edit。
- 本地 HTTP 正常响应 createSession/filesystem grant 后吞掉 prompt 响应；150ms deadline，稳定 OS_UNAVAILABLE/503，原 requestID 保留且无自动重交。同一 HTTP fixture 还验证缺少全局必需插件时 createSession 拒绝、已有 session 的 prompt 拒绝，且没有 prompt 提交。此项仅测试传输故障与部署前提，不代表模型验证。

## 先红发现

1. **跨档案 hardlink read 泄露**：原插件只验证 `realpath`，当前档案内 hardlink 与外档案源文件同 inode，路径规范化仍在当前档案。真实 npm native 的 read 工具成功并读出独立 sentinel。已向实现方报告并保留回归断言。hardlink write/edit 的原生工具防线已拒绝，外部文件未变。
2. **未授权 edit 别名成功**：仅授权 read+write 的角色，同一会话先 read 目标后再强制 edit，原生工具成功并修改文件。原有未先 read 的负例只能证明原生编辑前置条件，不能证明插件按工具名拒绝。独立测试已加入先 read 的对抗顺序。
3. **无传输截止时间**：本地 stall fixture 在 800ms 观察窗仍 pending，未产生要求的 OS_UNAVAILABLE/503。已向实现方报告并保留回归断言。

## 执行

```sh
PATH=/Users/guangjieyu/.npm/_npx/52027bd8fc0022aa/node_modules/.bin:$PATH pnpm exec vitest run services/control/test/independent-role.test.ts
pnpm lint
pnpm exec tsc -p services/control/tsconfig.json --noEmit
```

最终复验：**独立 9/9**；与 role-project/role-runtime 三文件合跑 **32/32**；`pnpm lint`、control 与 contracts 两个 `tsc --noEmit` 全部通过。

根因及修复：project-controlled 插件被默认 sandbox 拒绝加载，原 fixture 未复制真实账户入口的受信任全局插件部署。改为受信任全局插件并由 bridge 在 create/prompt 前核验精确必需插件 URL，插件内增加普通文件 hardlink 检查；传输增加明确 deadline。原有未先 read 的别名测试补充了同会话先 read 的对抗顺序后复验通过。

边界：hardlink 规则识别当前仍具有多个链接的普通文件，不声称审计已解除原始链接的内容来源；未验证真实模型、云端或多租户操作系统账户。

最终结果与逐项观察见 `independent-test.json`。该 JSON 仅记录版本、计数与工具状态，无请求认证信息。
