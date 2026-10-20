# Docker 账户驱动独立测试

结论：修复后 **独立 13/13 通过**；限定 Docker + 原 Fly/provisioner/lifecycle 的五文件回归 **73/73 通过**。Node **v22.23.3**，分支 `codex/p1-08-local`。未修改生产实现、原测试或 Fly 校验。

测试文件：`services/control/test/docker-independent.test.ts`。只使用测试专用 fake Engine、临时 Unix HTTP socket，以及现有 PG（独立随机账户与 operation ID）；未连接真实 Docker、未拉取或运行镜像。

## 有效先红发现及修复复验

在合法受控容器创建成功后，再逐项篡改 Engine inspect 响应。下列四种隔离配置最初均被 `listMachines()` 接受，独立报告为 **8 通过 / 4 失败**，保存在 `docker-independent-red.json`：

| 攻击 | 风险 | 修复后 |
|---|---|---|
| ExtraHosts 将 host.docker.internal 映射至 203.0.113.9 | 可能将账户控制面凭据送往错误宿主 | 拒绝 |
| NetworkSettings.Networks 另附 foreign 网络 | 账户容器超出预定 bridge 网络 | 拒绝 |
| SecurityOpt 追加 apparmor=unconfined | 放宽隔离配置 | 拒绝 |
| DeviceRequests 追加 GPU 请求 | 超出预定账户资源与设备权限 | 拒绝 |

最终每项同时验证 list/start/update 拒绝，篡改后的请求均只有 GET，没有 start/stop/delete/create 副作用。驱动开发者修复配置校验后，独立复验通过。最初另有一次因开发者并行加入 Entrypoint 与镜像基线校验而导致 fake fixture 不完整的准备失败；更新 fixture 的 Engine 镜像语义后再取得以上有效红灯，该准备失败不计为产品缺陷。

## 其他通过边界

- 合法具名卷被 foreign label/name 容器挂载时拒绝，不删除任何资源。
- 已停止容器重启，以及替换镜像后均保留原具名卷；仅创建一个卷，不发卷删除。
- 临时 Unix socket 返回包含测试 sentinel 的畸形 JSON、或超过 4 MiB 的响应，均返回通用 PROVISIONER_UNAVAILABLE，不外露响应中的敏感内容。
- 真实 PG 持久化 volume/machine 创建意图后，模拟 Engine 已创建但响应丢失；重建 AccountProvisioner 实例后，根据 Engine 可见资源恢复，不重复创建。
- 相同未知创建场景中，资源暂不可见时连续重试均返回 PROVISIONING_INDETERMINATE，每类 create 只有一次。
- 真实 PG 升级创建替换容器后响应丢失，operation 持久化为 indeterminate；重建 AccountLifecycle 后，同 operation 恢复 applied。容器 create 总共两次（初始和替换），具名卷仍只有一个。

## 命令与证据

工作目录 `/Users/guangjieyu/.codex/worktrees/research-foundation/ReinLab`；下列命令均设置：

```sh
export PATH=/Users/guangjieyu/.npm/_npx/52027bd8fc0022aa/node_modules/.bin:$PATH
pnpm exec vitest run services/control/test/docker-independent.test.ts --reporter=json --outputFile=evidence/P1-08-local/docker-independent-report.json
pnpm exec vitest run services/control/test/docker-driver.test.ts services/control/test/docker-independent.test.ts services/control/test/provisioner.test.ts services/control/test/lifecycle.test.ts services/control/test/independent-lifecycle.test.ts --reporter=json --outputFile=evidence/P1-08-local/docker-independent-regression.json
```

- `docker-independent-report.json`：独立 13/13 的原始 Vitest JSON。
- `docker-independent-regression.json`：五文件 73/73 的原始 Vitest JSON。
- `docker-independent-observations.json`：逐项观察摘要，无 Engine Env、认证头或凭据。
- `docker-independent-red.json`：修复前四项有效红灯原始报告。

测试结果证明驱动协议校验与 PG 恢复行为；不代表真实 Docker Engine、内核隔离、实际镜像启动或本地 Supabase 全套验收。真实 Docker 待主任务提供 socket/镜像后独立补验。
