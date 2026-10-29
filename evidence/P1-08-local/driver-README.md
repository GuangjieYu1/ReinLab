# P1-08 本地驱动证据

## 复验

在仓库根目录，用 Node 22：

```sh
export PATH=/Users/guangjieyu/.npm/_npx/52027bd8fc0022aa/node_modules/.bin:$PATH
pnpm exec vitest run services/control/test/account-entrypoint-lock.test.ts services/control/test/docker-driver.test.ts services/control/test/docker-independent.test.ts services/control/test/provisioner.test.ts services/control/test/lifecycle.test.ts services/control/test/independent-lifecycle.test.ts
pnpm exec tsc --noEmit --moduleResolution bundler --module esnext --target es2022 --esModuleInterop --skipLibCheck --strict services/control/src/provisioner/index.ts services/control/src/provisioner/lifecycle.ts
```

最新限定范围结果：6 个测试文件，74/74 通过。独立源码评审等待最终书面报告统一收口。

现有 PG 回归使用 127.0.0.1:55432/reinlab_test；新驱动测试使用测试专用 fake Engine 和临时 Unix HTTP socket，无真实 Docker/云端调用。`driver-red.txt` 为实现前缺模块红灯；`driver-green.txt` 为最新驱动和 Fly 回归结果；`driver-types.txt` 空输出表示类型检查 exit 0。

## 配置与语义

- 显式 `PROVISIONER_DRIVER=docker`；必需 `DOCKER_HOST=unix:///受控本地socket`。
- `ACCOUNT_IMAGE=reinlab-account:local` 等显式本地单段 tag；不允许 latest、registry 地址或 shell 字符。
- `REINLAB_CONTROL_URL=http://host.docker.internal:3001/`；Docker 宿主解析固定 host-gateway。
- 数据库 `fly_machine_id` 历史列存稳定账户容器名 `rl-<账户UUID去横线>`；`fly_volume_id` 存 `rl_<账户UUID去横线>`。Docker 破坏性操作使用刚检查的不可变容器 ID，避免名字重绑后误删。
- Docker 容器代理监听 0.0.0.0:4097，上游保留 127.0.0.1:4096；仅宿主 127.0.0.1 随机端口可达代理。Fly 保持 IPv6 4096。
- 镜像 inspect 的 Env 基线与账户计划合并后精确比较；入口固定账户脚本，拒额外 Cmd、提权、foreign 网络、GPU、挂载、端口和控制面主机映射。
- 升级保留具名卷、重建稳定同名容器。现有操作账本保持 pending/indeterminate，未知结果先发现核对，不盲重放。
- 本地 Storage HTTP 仅 docker 驱动允许 127.0.0.1 显式端口，专用 reinlab_snapshot_writer JWT 要求不变。

## 独立评审修复

1. Fly 卷占位不兼容 Docker：新增驱动 validateDeployment，真实 PG + fake Engine ensure/reuse 验证。
2. 入口与基础 Env 未完整验证：固定入口并基于镜像 SHA inspect 校验 Env。
3. 名字重绑导致操作错误容器：start/stop/delete 改用检查后的不可变 ID。
4. 独立攻击测试发现 ExtraHosts 重定向、附加 foreign 网络、apparmor=unconfined 与 GPU DeviceRequests：均失败关闭并通过独立回归。

5. 锁版本增量：入口全局配置固定 autoupdate:false，子进程环境强制 OPENSCIENCE_DISABLE_AUTOUPDATE=1；探针回归证明调用环境无法解除，并保留模型/插件配置。实现前红灯见 driver-version-lock-red.txt。

真实 Colima Docker 及完整 Supabase 验证待父任务提供环境与构建镜像后执行，不能将 fake Engine 结果当作真实运行证据。

父任务后续补验：完整真实9/9、实际两笔镜像升级及重复启动9/9已完成，见本目录README、integration-final/integration-repeat与upgrade-execution.json；本段以上是驱动作者交付时的历史状态。
