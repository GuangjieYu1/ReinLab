# 本地镜像 pin 增量评审与纯测试

结论：已补最小实现，启动时保存并复验不可变 image ID，禁止把覆盖/丢失镜像当作首次安装。`normalized` 的 immutable image baseline 没有修改。本增量未执行任何真实 Docker 操作，也没有读取凭据或容器 Env。

## ToTDD 证据

- ToSpec/ToTDD 见 `docs/tasks/P1-08-local-driver.md` 本地镜像 pin 增量。
- `image-pin-red.txt`：helper 尚不存在时的有效缺模块红灯（Node 24）。
- `image-pin-green.txt`：Node 22.23.3，`image.test.ts` 10 项 + 既有 `config.test.ts` 3 项，共 13/13。新增hash输入完整性红灯见 `image-hash-red.txt`。
- `image-pin-types.txt`：helper、test 及 up.ts 集成严格类型检查 exit 0（空输出）。
- `git diff --check` 通过。

## 行为与边界

`tooling/local/image.ts` 将纯决策与固定参数 CLI 适配分开：

| 状态 | 行为 |
|---|---|
| 有 pin，tag 当前 ID 相同，账户引用不冲突 | 复用，不 build、不重写 pin |
| 有 pin，tag 指向其他 ID | LOCAL_IMAGE_PIN_CHANGED，禁止 build |
| 有 pin，tag 消失 | LOCAL_IMAGE_PIN_MISSING，禁止同 tag 重建 |
| 无 pin，tag 存在且全部同 tag 容器 ID 相同 | 首次保存 pin，不 build |
| 无 pin，tag 缺失但存在同 tag 旧容器 | LOCAL_IMAGE_REFERENCE_CONFLICT，禁止 build |
| 无 pin，tag 当前 ID 与任一同 tag 旧容器 ID 不同 | LOCAL_IMAGE_REFERENCE_CONFLICT，禁止接受新基线 |
| 无 pin、无镜像且无同 tag 容器 | 允许首次 build，随后重新读取 ID 和引用并落 pin |
| Docker 读取失败、pin 损坏、启动中 tag 漂移 | 失败关闭，不当成首次安装、不覆盖原 pin |

CLI 使用 `image ls --quiet --no-trunc`、仅格式化 `.Id` 的 image inspect，以及容器批量 inspect 的 `[Config.Image,Image]` 二元组。没有完整 inspect JSON，也没有 Env 模板。容器列表包含所有容器而非只过滤 label，因此外国容器引用相同 tag 时也会阻止覆盖。批量列表上限 1000，每次命令都有 deadline，读取错误对外只给稳定 LOCAL_* 代码。

pin 路径由 up.ts 的 image 段指定为状态目录下 `account-image-local-<内容hash>.env`，只包含 IMAGE_REFERENCE 与 IMAGE_ID。沿用已有 private-env 的 mode600、owner、无符号链接/无多硬链接验证。首次写先完整写入随机临时 mode600 文件，再用不覆盖目标的原子 hardlink 发布；已有 pin 永不重写。进程崩溃可能残留临时文件/额外硬链接，此时后续读取失败关闭，要求人工核对，不能悄悄重建新基线。父任务负责整个 local:up 的排他锁，helper 不再实现第二层启动锁。

## 复验命令

```sh
export PATH=/Users/guangjieyu/.local/share/reinlab/toolchains/node-v22.23.3-darwin-arm64/bin:/Users/guangjieyu/.nvm/versions/node/v24.14.1/bin:$PATH
pnpm exec vitest run tooling/local/image.test.ts tooling/local/config.test.ts
pnpm exec tsc --noEmit --moduleResolution bundler --module esnext --target es2022 --esModuleInterop --skipLibCheck --strict tooling/local/up.ts tooling/local/image.ts tooling/local/image.test.ts
```

所有 Docker 协议在测试中通过显式 fake runner；只在系统临时目录创建 pin 测试文件，最后清理。

## 尚待真实复验与建议

1. 父任务完成旧测试账户的明确修复后，真实运行一次 local:up 保存 pin，再运行一次，验证原始 image ID 不变且无 build；本纯测试不能替代此结果。
2. 已按父任务授权关闭hash漏输入：`ACCOUNT_IMAGE_INPUTS` 包括 Dockerfile、所有 COPY 源文件（根 package.json、lock、pnpm-workspace.yaml、各 workspace manifests、入口/health/plugin），每项按路径+字节长度分帧后hash。纯测试从真实Dockerfile解析COPY源，确认无遗漏，并证明任一输入变化都产生新tag。此次会改变内容tag，父任务负责显式生命周期升级验证保卷；helper未执行构建。
3. 若需要跨机器/清理镜像后的恢复，应另外保留可信原镜像产物与 manifest/config 身份，不能删除 pin 或回退新 tag 来绕过 immutable baseline。

## canonical临时目录修补

private-env加强祖先符号链接拒绝后，macOS系统tmpdir路径包含/var别名。测试仅对mkdtemp生成目录先做realpath，再交给private-env；没有放宽生产校验、文件字节或权限要求。Node22全13项复验通过。
