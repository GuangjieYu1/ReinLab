# P1-12 控制面配置迁移独立安全复核

日期：2026-10-23。工作树：`/Users/guangjieyu/.codex/worktrees/research-foundation/ReinLab`，分支 `codex/p1-12-approvals-inbox`。此报告针对复核当时未提交修改；未修改实现。

## 结论

**通过，可随当前控制面小步提交。** 核心控制面入口的凭据文件迁移安全边界通过本次定向验证；首轮提出的脚本入口边界不一致及HTTP审计覆盖建议均已修复并复核。未发现待关闭的安全问题。

### 已修复 P2：verify/smoke 脚本曾先通过较宽松的旧读取器消费 runtime.env

- 位置：`services/control/scripts/verify-local.ts:32`、`services/control/scripts/smoke-local.ts:154`，旧读取器 `tooling/local/config.ts` 的 `readPrivateEnv`。
- 新 `readRuntimeConfiguration` 要求 runtime.env 的直接父目录为当前uid、700；旧读取器不要求该父目录700。verify先创建数据库连接、执行assertSafeRole及注册/登录认证，再在environmentDriver调用中间接触发新读取器；因此不能保证不安全runtime.env在使用前被拒绝。smoke亦先消费旧读取器结果建立数据库连接。
- 合成fixture实际确认：父目录755、文件600时，旧reader接受=true，新reader拒绝=true。仅使用PORT合成配置，未连接真实服务。
- 建议：这两处runtime.env首读统一使用`readRuntimeConfiguration(paths.runtime)`；其他用户/准入文件不在此建议范围。
- 修复复核：verify-local.ts第33行、smoke-local.ts第154行现在均在消费runtime.env前直接调用严格`readRuntimeConfiguration(paths.runtime)`；身份/准入文件仍走原读取器，符合本轮范围。此项关闭。

### 已采纳测试建议：HTTP环境审计原采用全值相等检查

- `services/control/test/fixtures/config-environment-audit.ts:4-7` 的`selected.includes(value)`只能发现ENV值恰等于凭据；可改为ENV值包含任一非空凭据，防止前后缀/拼接漏报，并补齐文件中存在的DATABASE_URL_PROVISIONER、FLY_API_TOKEN等字段。
- 这是覆盖改进，未发现实现向ENV写入凭据。
- 修复复核：敏感字段现在由`TOKEN|SECRET|PASSWORD|_KEY$|DATABASE_URL`从合成配置键选择，对每个ENV值检查是否包含任一所选凭据；真实HTTP入口定向测试通过。此项关闭。

## 修复后实际执行（最终状态）

- `vitest run services/control/test/configuration-file.test.ts services/control/test/configuration-security-review.test.ts`：2文件、4/4通过。
- `vitest run services/control/test/api.test.ts -t 'Node22真实HTTP入口验签与优雅退出'`：1/1通过、38项按定向筛选跳过；使用修改后的原样HTTP环境审计fixture。
- 复核了reader返回类型及字符串过滤：文件读取返回冻结`Readonly<Record<string,string>>`，仅过滤parseEnv的undefined项；公开ENV fallback仍返回optional/public-only，未引入秘密字段回退。
- 未运行全量、真实verify/smoke/local:up或真实模型，未读取真实配置值。

## 实际执行

所有shell均`login:false`，先unset DEEPSEEK_API_KEY，使用任务指定Node22 PATH。未读真实.env/key，未使用浏览器，未执行真实模型、smoke、local:up或local:verify。

1. `vitest run services/control/test/configuration-file.test.ts`：2/2通过。
2. 新增独立测试`services/control/test/configuration-security-review.test.ts`（2项）：FIFO、Unix socket、目录、祖先symlink、非规范绝对路径、NUL、固定错误、不回退旧secret ENV、坏显式配置路径fail closed、ENV不变。断言仅输出布尔值，合成凭据不输出。
3. 最终命令：`vitest run services/control/test/configuration-file.test.ts services/control/test/configuration-security-review.test.ts services/control/test/api.test.ts`：3文件、43/43通过，含Node22真实HTTP入口验签、数据库断连恢复和优雅退出。
4. 单独合成临时目录比较新旧reader：`legacyAccepted=true`、`strictRejected=true`。

首次独立fixture把待拒绝路径传入path.join，路径在到达reader前已被规范化，导致1项测试失败；修正fixture为保留`/./`原文路径后通过。这是fixture问题，不是实现缺陷。

## 仅代码复核

- 已只读主仓库`design/reviews/BATCH4_REVIEW.md`第3/5节，目标为旧部署鉴权和本地runtime.env从ENV迁移至进程内读文件。
- `configuration.ts`：绝对且规范路径，realpath阻断静态symlink路径；父目录700/uid；O_NOFOLLOW与O_NONBLOCK；fstat核实常规文件、600/uid/nlink=1；读取前后128KiB限制；NUL拒绝；固定RUNTIME_CONFIG_UNSAFE；返回冻结对象；不赋值process.env，读取Buffer在finally清零。
- `runtimeConfiguration`只允许公开配置ENV；显式文件路径失败不会旧secret ENV回退。签名key路径等路径配置仍可通过ENV。
- `main.ts`从文件值配置DB、JWT、provisioner及pricing，启动要求REINLAB_RUNTIME_CONFIG_FILE；文件路径仅作为ENV传入。
- `provisioner/index.ts`、`lifecycle.ts`、`production-factory.ts`已改为读取内存配置；扫描control/src未发现这些旧凭据字段直接从process.env读取。
- `tooling/local/control.ts`只把runtime.env路径写ENV；migrate/provision-account/account-maintenance改为文件配置读取。未实际运行这些维护入口。
- 未测试跨uid文件归属（无须特权更改）、并发路径替换竞态或真实部署配置；上述文件归属检查仅代码复核。未把同uid主动篡改本机私有目录视为本次独立威胁模型。
