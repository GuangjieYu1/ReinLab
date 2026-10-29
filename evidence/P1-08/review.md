# P1-08 独立评审（首轮红灯）

日期：2026-10-19。对象：当前工作树未提交实现；此报告只覆盖修复前所读版本，不是云端验收结论。

结论：**不通过，暂不进入下一任务**。现有 13 项测试全部独立复跑通过，但两个新增故障/安全样本未通过，且 §7 生命周期合同尚有本地可实现缺口。父任务已收到问题，准备修复；以下问题未复验前仍视为未关闭。

## 验证范围与方法

只读审查 `design/CODEX_SPEC_RESEARCH.md` §2/7、`design/ACCEPTANCE_RESEARCH.md` 红线、`docs/tasks/P1-08.md`、Q-028/Q-029，以及 provisioner、0013 迁移、Fly 镜像/启动/健康脚本、运行时及插件依赖锁。只写本报告；未读取任何 `.env` 或本机凭据，未调用真实云账户。真实 PG 使用明确指定的 localhost:55432/reinlab_test 测试连接；新增样本均使用随机账户，两个独立故障样本数据已清理。

运行环境：Node 22.23.3（通过指定 PATH）、pnpm 11.5.2。命令：`pnpm exec vitest run services/control/test/provisioner.test.ts`。实际结果：1 个文件，13/13 通过，605ms。该套件的 Vault 成功路径和 Fly API 为测试实现，仅 PostgreSQL/RLS 为真实执行，不能外推到真实 Vault、Fly 创建或网络隔离。

## 阻断问题

### R1 / P1：持事务锁时嵌套借连接导致池饥饿

位置：`services/control/src/provisioner/index.ts:20-23` 及 `tokens/save`。每个 ensure 先借一个连接，整个外部网络/健康流程持续持有事务锁；随后反复通过同一个 Database 再借连接。并发达到连接池上限后，等待同一账户 advisory lock 的请求占满连接，持锁者无法借到执行插入/保存的连接，所有请求互相等待。175 秒 deadline 只在健康循环中使用，无法解除这一等待。

独立复现：测试池 max=2、connectionTimeoutMillis=500；管理员会话临时持有该随机账户 advisory lock，启动两个 ensure，确认均占连接后释放管理员锁。观察为：

```json
{"phase":"two_ensure_waiting","poolTotal":2,"poolIdle":0,"poolQueued":0}
{"phase":"holder_needs_nested_connection","poolTotal":2,"poolIdle":0,"poolQueued":1}
{"results":[{"status":"rejected","error":"账户机器尚未就绪，请重试或查看运维状态。"},{"status":"rejected","error":"timeout exceeded when trying to connect"}]}
```

只有专门加入的 500ms 借连接超时打破等待；现有生产池未配置该超时，故会无限等待。原五并发测试使用 max=12，掩盖了该边界。建议使用不长期占连接的持久化 claim/lease，并对续租、失效持有者写回和资源创建未知结果进行测试；仅扩大池不足以修复。

### R2 / P1：资源对账未校验私网、镜像及常驻安全不变量

位置：`services/control/src/provisioner/index.ts:36-47`。现有机器只校验区域、账户 metadata、卷和挂载路径；未校验 `services`、镜像、重启策略、auto_destroy、运行环境。被配置漂移的账户机器会被再次标记 ready；健康接口相同版本不能证明其余不变量成立。

独立样本：先正常创建随机账户，再让 Fly 协议测试实现返回同一机器，但加入公网 services、将 image 换成另一镜像、restart 改为 no。随后 ensure 的实际结果：

```json
{"scenario":"public_service_image_restart_drift","result":{"state":"ready","machineId":"abcdef12345678"},"services":[{"protocol":"tcp","internal_port":4096,"ports":[{"port":80,"handlers":["http"]}]}],"image":"registry.fly.io/other:mutable","restart":{"policy":"no"}}
```

这是本地对账逻辑反例，**不是已证明真实公网泄露**。它证明“ready”不能维护 §7 私网/常驻及锁定镜像合同。建议在任何 ready 转移前校验全部关键不变量，漂移失败关闭；新增独立维度的配置漂移用例。

### R3 / P1：生命周期实现与任务文档不一致

§7 要求注册即创建、每晚 `/data/dossiers` 快照到对象存储、升级前等待运行结束或登记 interrupted、重启后对账 running。当前只有 ensure 和 CLI；`Machines.update` 没有调用方，没有快照上传、可信升级或 running 对账实现。`docs/tasks/P1-08.md` 却称“提供可调用快照前置检查和升级中断登记”，当前代码搜索未找到对应实现。

Q-029 可以准确记录外部条件和调度后续接入，但不能把可本地实现的生命周期入口视作已交付。建议补齐可测试调用的生命周期合同（真实存储协议与失败处理，不用空实现），如调度确需后续阶段则精确记录未完成范围，不能将 P1-08 整体标完成。

## 已确认的正向检查

- 三包 `@synsci/openscience`、SDK、plugin 均声明 2.0.150；未发现改动上游源码。
- 新建 machinePlan 无 services，东京 nrt、单卷 `/data`、always restart、auto_destroy=false；控制面 URL 要求私网。
- AES-256-GCM 使用随机 12 字节 IV，AAD 绑定账户 UUID；现有测试验证密钥错误、tag 篡改和跨账户解密失败。数据库只保存信封；key buffer 在 finally 清零。
- 新秘密表启用并强制 RLS；PG 下跨账户读取为零行。Vault 函数撤销 PUBLIC execute，应用没有直接 Vault 表授权；缺 Vault 时实测失败关闭，未创建 Fly 资源。
- 卷/机 POST 前持久写入意图，丢响应后先查列表；未知结果未找到时不直接重建；现有故障测试通过。
- Q-028 的自有 IPv6 代理保留上游 loopback，逐请求校验账户 Bearer，拒 Origin，固定上游 Host；没有关闭上游防护。实际 IPv6/Fly 网络及真实镜像行为尚待运行验证。

## 验证限制及下一步

Fly/Supabase 云项目不存在：真实 Vault 成功路径、两云东京部署、私网 DNS/SEC-8、公网不可达、注册链路、Storage 上传及夜间调度、3 分钟 SLA 均未验证，不能写为通过，也不要求以假账户伪验证。Docker 构建/真实容器运行由父任务独立执行，本报告尚无其结论；Fly 新卷挂载后目录 UID/权限亦需以真实挂载或相同 root-owned 空卷验证。

推荐：先修 R1/R2/R3，再复跑独立反例和受影响安全测试；完成真实容器与持久卷启动验证。可以交付“本地实现已验证、云验收待配置”的阶段状态，但在用户要求独立测试/评审通过后才下一任务的约束下，当前不应进入 P1-09。

# 第二轮复审（租约及生命周期扩展后）

本轮结论：R1/R2 已按下述独立样本关闭；生命周期已有实际调用实现，R3 的“无入口”实现缺口关闭，但集成部署边界仍未完成。新发现 R4/R5 仍阻断本地代码通过。保留上轮红灯历史，不以测试覆盖率代替正确性结论。

独立复跑命令：`pnpm exec vitest run services/control/test/provisioner.test.ts services/control/test/lifecycle.test.ts`。结果：2 文件，29/29 通过，1.01 秒。审查范围新增 `lifecycle.ts`、维护 CLI、0014 租约/runtime_id、0015 Storage 专用身份及 RLS、备份 tar 代理。

## 已关闭问题与证据

- R1：PG max=1、connectionTimeoutMillis=800，3 个同账户 ensure 并发均 ready；卷创建 1 次、机创建 1 次。短事务 claim 不再长期占连接等待，原饥饿反例消失。
- R2：逐一修改 services、image、restart、auto_destroy、env，五项均拒绝为 `PROVISIONING_CONFLICT`；不存在未预期 ready。
- R3 的本地入口缺口：新增可信 registered 调用、运行重启对账、升级前中断与账本同事务、流式 Storage 快照及 CLI。账本写入失败可回滚运行状态/runtime_id，Vault 失败不访问网络。其注册 hook、运行 boot 事件接线、Hatchet/cron 夜间调度、真实 Storage/Vault 及 Fly 部署仍未执行；这只关闭代码入口缺失，不代表 §7 生命周期整体验收完成。

## R4 / P1：升级未知结果未对账，同操作可重复外部更新及变更内容

`AccountLifecycle.upgrade` 的 operationId 仅进入账本去重键和 phase，未建立持久操作内容/状态；每次调用都执行 Fly.update。独立 PG 随机账户样本让第一次 update 已应用目标镜像后丢响应，再以同 operationId 重试，并以同 operationId 改成另一目标镜像，结果：

```json
{"scenario":"upgrade_unknown_result_same_operation","first":"LIFECYCLE_UNAVAILABLE","retry":{"code":"UPDATE_REQUESTED"},"differentContent":{"code":"UPDATE_REQUESTED"},"updateCalls":3,"finalImage":"registry.fly.io/reinlab-accounts:other"}
```

重复更新可能再次重启运行时；同幂等标识不同内容也没有冲突。建议持久化 operationId、目标 image/mode 和请求状态；未知更新先读取实际机器对账，目标已生效则返回既有结果，无法确认则失败关闭；同操作不同内容应返回 `IDEMPOTENCY_CONFLICT`。独立样本数据已清理。

## R5 / P1：tar 子进程退出时响应提前结束，慢消费会截断快照

`account-entrypoint.mjs` 对 archive.stdout 使用 `pipe(res,{end:false})`，却在 archive 的 `exit` 事件立刻 `res.end()`。进程 exit 不保证 stdout 已排空。

独立复现使用真实 `tar -cf - /bin/sh`，保持完全相同的 pipe/end 时序，目标 Writable 以 highWaterMark=1、每次写入延迟 10ms 模拟 Storage 背压。完整归档为 112640 字节；exit 时只收到 61440 字节、`stdout.readableEnded=false`，随即触发 `ERR_STREAM_WRITE_AFTER_END`。该反例不修改仓库文件，也不依赖云服务。

建议等待 stdout 排空且 tar 成功关闭后结束 HTTP 响应；非零退出销毁响应，保证上传不能把截断归档当作成功。补充大于管道缓冲且慢消费的 tar 完整性验证。

## 本轮环境限制

已阅读 `container-environment.json`：Docker 后端 settings 超时导致真实 Linux 镜像尚未验证；没有擅自重启共享 Docker。父任务继续原生上游/代理探针，这不能替代 Docker 镜像、工具安装、真实新卷权限或 Fly 私网部署验收。0015 在本地无 storage schema 时为条件跳过，不能据此声称真实 Supabase Storage RLS 或专用 JWT 已实测。当前仍不应将 P1-08 整体标完成。

# 第三轮独立复审（0016 升级操作表及 tar close 修复后）

**最新结论：本轮审查范围内的本地代码通过；R1—R5 的代码阻断均已关闭，未发现新的代码阻断。P1-08 整体 DoD 尚未完成，不能标记整个任务完成。** 上文保留历史失败和修复前证据，不代表当前修复版仍有这些缺陷。

新增审查：0016 `account_machine_operation` 的租户主键、RLS、列级更新权限；upgrade 的请求哈希、pending/indeterminate/applied 持久状态、更新结果对账及冲突处理；tar stdout 关闭后的响应完成；startAccount 可注入原生探针路径、root 卷目录初始化和降权、上游独立进程组及清理逻辑。默认生产 root、二进制、插件路径仍与镜像对应；注入接口本身不构成运行时伪验证。

独立复跑：`pnpm exec vitest run services/control/test/provisioner.test.ts services/control/test/lifecycle.test.ts`。实际 2 文件、33/33 通过，1.09 秒。

## R4 关闭：未知升级结果的独立重放验证

另建两个全新随机 PG 账户和操作 UUID，分别让 Fly 协议样例在已应用/未应用更新时丢失响应。每组均重复相同操作两次，再以相同操作改 image 和 mode：

```json
{"applyBeforeLostResponse":true,"first":{"code":"PROVISIONING_INDETERMINATE"},"retry":{"code":"UPDATE_REQUESTED"},"repeated":{"code":"UPDATE_REQUESTED"},"imageConflict":{"code":"DEDUPE_CONFLICT"},"modeConflict":{"code":"DEDUPE_CONFLICT"},"updateCalls":1}
{"applyBeforeLostResponse":false,"first":{"code":"PROVISIONING_INDETERMINATE"},"retry":{"code":"PROVISIONING_INDETERMINATE"},"repeated":{"code":"PROVISIONING_INDETERMINATE"},"imageConflict":{"code":"DEDUPE_CONFLICT"},"modeConflict":{"code":"DEDUPE_CONFLICT"},"updateCalls":1}
```

结论：已生效更新可对账恢复，不重复 POST；未知且目标未生效时失败关闭；同操作不同内容稳定拒绝。独立样本已按操作表、秘密、机器、账户顺序清理，无测试凭据写入报告。

## R5 关闭：真实 tar 与慢消费完整性验证

使用真实 `tar -cf - /bin/sh /bin/zsh`，将同样的 `stdout.pipe(...,{end:false})` 结束逻辑改为 child `close`；目标 Writable 保持 highWaterMark=1、每次写入延迟 10ms，以复用第二轮触发截断的背压条件。实际：

```json
{"scenario":"backup_close_after_stdout_end","code":0,"expectedBytes":1464320,"receivedAtClose":1464320,"stdoutEnded":true}
{"receivedAtFinish":1464320,"hashMatches":true}
```

归档长度与完整基准一致，SHA-256 相同，无 `ERR_STREAM_WRITE_AFTER_END`。这是独立的真实 tar/Node 背压时序探针；未声称它覆盖真实 Linux 容器 HTTP→Storage 全链路。父任务的真实原生启动及代理探针结果应另附，不能用协议样例代替真实上游行为。

## 当前可交付范围与剩余条件

可表述为：账户 provisioner 与生命周期调用入口在本地 PostgreSQL、独立故障/安全样本范围内通过评审，代码阻断已关闭。保持未完成项：真实 Supabase Vault 成功路径与 Storage 专用身份/RLS；真实注册 Auth hook、runtime boot 对账接线与夜间 Hatchet/cron；Linux Docker 镜像构建、科学工具安装和新卷 root 初始化/降权运行；Fly 东京创建、私网 DNS、SEC-8 公网不可达、重启恢复与 3 分钟可用性。

Docker 仍因共享后端 IPC/settings 超时未完成，未擅自重启。外部条件缺失应准确作为待验事实保留，不要求无账户伪验证，也不能据此宣称云验收通过。本地代码评审通过不等于 P1-08 整体完成；若要进入后续任务，应由主任务按用户对“通过后才下一任务”的实际范围决定，并清楚说明这些尚未通过的部署验收项。

# 第四轮补充审查（一次性 CI 镜像验证脚本）

范围：`.github/workflows/research.yml` 的 account-image job、`services/account-runtime/verify-container.mjs`、镜像基础摘要及 entrypoint 的 `node:process` 命名导入。此轮为静态评审与错误形状探针，没有在故障 Docker 上声称执行镜像成功。

设计方面：GitHub 托管 ubuntu runner 独立构建；无账户 secrets 引用；容器 `--network none`，认证值由 randomBytes 新生成；随机 UUID 命名容器与卷；finally 只删除对应名字，没有 prune、批量删除或重启 Docker。工具、root-owned volume-nocopy 初始化和 UID 降权、实际 HTTP 鉴权、12MiB 归档 SHA-256、重启后卷持久化均通过真实 exec/HTTP 执行，不是固定返回的伪测试。使用公开镜像 OCI 摘要固定基础镜像。原先 5 个 POSIX process API 改为 `node:process` 命名导入，未改变逻辑或放宽 lint。

## R6 / P1：CI 错误传播可能把新生成测试令牌写进日志

docker 封装直接 await promisify(execFile)，但 docker run 将 OPENSCIENCE_AUTH_TOKEN、REINLAB_CONTAINER_SECRET 的明文值作为 `-e` 参数。execFile 错误保留完整 cmd，message 同样包含命令参数；顶层仅 finally 没有稳定错误 catch，Docker run 失败/超时将输出未捕获错误及令牌。虽然是一次性测试凭据，也不应出现在公共 CI 日志。

独立安全形状探针使用不属于凭据的固定 marker，让 Node 子进程 exit(1)：实际 `error.message.includes(marker) === true`、`error.cmd.includes(marker) === true`。未生成或输出真实令牌。

建议 docker 包装丢弃原始 error/args/stderr/cause，抛稳定错误码；顶层仅写不含原始错误的失败报告，并保留 finally 精确清理。此问题已通知父任务。第三轮对业务实现通过的结论不变，但新增 CI 脚本应修复 R6 后再判其可用。CI 尚未运行，不能将存在 workflow 当作 Linux 镜像已验证。

## 第四轮 R6 修复复核

父任务修复后再次读取脚本：docker 封装 catch 丢弃原始错误，仅抛 `DOCKER_OPERATION_FAILED`，不附带 args/stderr/cause；顶层 catch 仅写固定 `CONTAINER_VERIFY_FAILED` 及已完成检查名称，不输出原始异常。finally 仍只清理该次 UUID 容器与卷。

独立合成故障让 exec 的 message/cmd/stderr 均携带非凭据 marker，再运行同样封装：实际输出 code=`DOCKER_OPERATION_FAILED`，错误属性不含 marker，且没有 cause。两个脚本 `node --check` 均通过。R6 关闭；CI 配置及验证脚本静态评审通过，没有发现误删现有资源或固定返回式测试虚化。

本轮没有执行 Docker 或 GitHub CI，不能据此宣称真实 Linux 镜像通过。此前独立本地实现评审通过结论保持；真实镜像与全部云端 DoD 继续待实际运行证据。
