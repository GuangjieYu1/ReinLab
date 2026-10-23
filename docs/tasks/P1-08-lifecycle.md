# P1-08 生命周期补充 ToSpec

依据 design/CODEX_SPEC_RESEARCH.md §7。仅受信任的服务调度器可调用生命周期模块；`registered` 的 accountId 必须来自已验证 Supabase Auth 注册事件，不允许接入公开请求 body。账户必须已初始化；复用 ensure 的幂等创建。

夜间运维任务逐账户运行 snapshot：仅固定私网机器 `/reinlab/backup` Bearer 认证读取 `/data/dossiers` tar，流式上传到固定 Storage bucket 的 `<account UUID>/<YYYY-MM-DD>.tar`；日期为 UTC，默认当天，POST x-upsert=false，409 为重放。Storage 专用权限 token 必须为三段 JWT 且 payload.role=reinlab_snapshot_writer；由 Storage 校验真实签名，权限限制该 bucket；禁止传入通用 service_role 或 opaque 管理员 key。调用方调度器每天夜间调用 CLI，不在模块内隐式启动计时器。无 Vault / Storage / Fly 配置均失败关闭，不读取 .env。

快照必须同事务检查有效租约 fencing、machine.state=ready 且没有 running；有效租约期间派发层必须拒绝新运行。升级先核对 Fly 机器 metadata、唯一私有卷、/data 挂载、无公网 services、auto_destroy=false、restart=always 与解密账户凭据对应的所有预期 env，再在事务中把 running 标记 interrupted 并写稳定去重账本；wait 模式有 running 就拒绝。准备结果持久化 phase=upgrade_pending、state=starting，阻止调度器继续派发。Fly update 仅替换现有 config.image，不重建资源，不输出 config/token。API 成功仅表示 UPDATE_REQUESTED；健康检查通过后方可标 ready。网络失败保留待对账状态与 interrupted。

健康上报 runtimeId 首次出现或改变时，在同一事务内中断 running、追加 ledger 并持久化 runtime_id。相同 runtimeId 幂等。首次见到 ID 也保守中断，避免升级前未持久化 ID 的运行漏账。

测试：先缺失模块红灯；真实 PostgreSQL 验证 RLS、事务、重复执行和失败回滚；HTTP fixture 验证认证、私网路径、流式 Storage POST、固定路径、错误脱敏。未配置云账户，不宣称云端验证。

## 本地证据与运维调用

2026-10-19 缺模块首轮 Vitest 红灯：Cannot find module `../src/provisioner/lifecycle`。实现后本地真实 PostgreSQL + fetch HTTP 协议 fixture 测试通过。fixture 并不代表实际云服务连接。

使用 Node22 / tsx 调用 `services/control/scripts/account-maintenance.ts`：

- `registered <account UUID>`：由已验证注册事件的可信 worker 调度；尚未部署 Supabase Auth Webhook 认证/接线。
- `snapshot <account UUID> [UTC YYYY-MM-DD]`：由夜间 scheduler 按可信账户清单逐账户调用。存储桶固定 `dossier-snapshots`，权限必须单独配置仅可写此 bucket，不得传 `service_role` JWT 或通用管理员 key。
- `upgrade <account UUID> <registry.fly.io/...:tag> <wait|interrupt> <operation UUID>`：真实调用 Fly Machines update；只输出 UPDATE_REQUESTED，随后须执行带认证健康检查与运行时对账。
- `reconcile <account UUID> <runtimeId>`：runtimeId 必须从认证的账户机器健康响应提取，不得直接接受公开用户输入。

配置：DATABASE_URL_APP、FLY_API_TOKEN、FLY_APP_ACCOUNTS、SUPABASE_URL、STORAGE_SERVICE_TOKEN、REINLAB_CONTROL_URL 及 Vault；注册另需 ACCOUNT_IMAGE。第五批起这些值从受保护配置文件在进程内读取，REINLAB_RUNTIME_CONFIG_FILE 只传文件路径；凭据禁止 export、shell source 或通过容器 Env 传递。Storage token 仅接受 role=reinlab_snapshot_writer 的三段 JWT；模块解码角色实施输入约束，Storage 服务校验签名和真实授权。fixture JWT 不代表云端身份验证，仍需部署并验证 bucket policy。当前未部署 cron、Auth hook 或 Storage policy；这些是云端上线接线，不声称已完成。运维 CLI 单次只处理显式可信账户，输出仅 JSON code。

并发：与 ensure 共用 200 秒 lease，外部流式操作 120 秒截止；升级先核对提供方资源，再事务写 phase=upgrade_pending:<operation> 与 interrupted + ledger，随后释放数据库连接执行 Fly update。提供方失败保留 pending 状态供人工对账；升级持久操作表保存 sha256(JSON {image,mode})。同操作 applied 返回原 UPDATE_REQUESTED，不再发 POST；异内容 DEDUPE_CONFLICT。pending/indeterminate 同操作仅查询 Fly 镜像确认，匹配才 applied，否则 PROVISIONING_INDETERMINATE，不再 POST。新操作要求机器 ready 且没有其他 pending/indeterminate。派发层必须拒绝 machine 非 ready 或存在有效租约，当前任务尚未接入真实模型派发。

## 复审补充证据

快照状态/Storage专用角色/升级安全不变量新增五项先红后绿。升级幂等新增三项先红（重复POST、响应未知无保护、未ready仍升级）后绿。最终真实 PostgreSQL + HTTP协议 fixture 20/20 通过，独立 strict TypeScript 检查通过；操作表采用父任务的0016迁移，不擅改迁移。
