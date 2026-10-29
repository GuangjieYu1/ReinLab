# P1-04 独立测试

最终结论：修复后通过。85 项检查全部通过、0 失败；其中 78 项自选安全/故障样本全部通过。首轮为 77 项检查中 76 通过、1 失败，真实 HTTP 进程在自己的空闲数据库连接断开时直接崩溃；历史与失败输出保留在下文及 JSON `history`。

## 阻断问题及真实复现

使用 Node22 启动原始 `services/control/src/main.ts` 子进程，数据库连接增加唯一 `application_name=independent_disconnect_<随机值>`，使用本地临时 JWT 配置、PORT=0。进程发出 CONTROL_READY，真实 `/health` 返回 200。管理员只对该 application_name 查询 `pg_stat_activity` 并调用 `pg_terminate_backend(pid)`，终止恰好 1 条该子进程自己的空闲连接。

实际结果：Node 子进程退出码 1，stderr 包含 `Unhandled 'error' event`。没有终止其他服务或测试的连接。主入口未监听 pool 的异步 error，数据库连接故障可以直接终止整个 HTTP 服务。此前对已借出 client 的独立断线探针也观察到 `Connection terminated unexpectedly` 未处理事件导致测试进程退出，说明仅处理查询 Promise 不足以覆盖断线事件。

首轮主入口故障的 stderr 保留在 JSON `history[0].failureDetails`；`real-http-idle-db-disconnect-survives` 已更新为修复复测结果。该问题已在第二轮按下述真实故障复测验证修复。

## 修复后独立复测

重新启动原始 main.ts 子进程，使用新的自建账户和唯一 application_name：真实 GET /v1/me 返回 200，管理员定向断开恰好 1 条该进程自己的空闲连接；进程继续运行，随后 GET /v1/me 仍为 200 且返回自己的账户。stderr 只有稳定的 `{"code":"DATABASE_POOL_ERROR"}`，没有 PG 连接对象或底层错误栈。

另用真实 max=1 应用连接池借出 client，在事务内等待外部同步；定向终止该 client 的 backend，等待异步错误事件后继续查询。进程没有退出，事务错误被正常捕获；下一事务使用不同 backend PID，并读回新的账户上下文。释放后 `disconnected` 监听已移除，裸连接查档案为 0 行，未遗留租户上下文。连续构造 11 个 Database 对象后，pool error 监听仍只有 1 个。

自建 INHERIT 和 NOINHERIT 两种非特权角色，与另一角色建立成员关系后均被 assertApplicationRole 拒绝；创建/授权操作在管理员事务中全部回滚。现有套件还真实覆盖了经该成员角色获取表 owner 权限的两种攻击。复测 lint、control 严格 tsc、API/auth/context 三文件 45 项测试全部通过。

第二轮只改数据库连接恢复与角色守卫，已独立重测相应故障/攻击；未变化的 JWT、API、幂等样本与前端回归沿用首轮结果，没有宣称所有旧攻击在第二轮再次执行。当前实现哈希与范围记录在 JSON `snapshot` / `history`。

## 已通过的独立样本

- JWT：篡改已签名 sub、错签名、service_role/anon/数组/对象/null 角色、非法/空/未初始化 subject、错误 issuer/audience、缺 exp/iat、未来 nbf、过期、HS384/none 算法混淆全部按预期拒绝；已验签 metadata 中的账户和角色不能替换 sub。独立本地 JWKS 使用真实 ES256 和 RS256 密钥验证有效签名，拒绝 HS256 公钥混淆和未知 kid。
- A/B API：me、档案列表、创建、详情均使用真实 Postgres；A/B 互相读取详情 404，列表无对方记录，客户端 accountId 注入 400，响应不返回内部 workspace_path。
- 幂等：8 路相同内容只得到同一档案；8 路混合内容得到 4 个成功的同一收据与 4 个 409；重建应用和连接池后复用原收据；不同账户相同键互不冲突。
- 事务故障：真实 SQL `select 1/0` 导致业务写入整体回滚；在收据 INSERT 阶段，通过测试连接代理执行同样真实 SQL 错误（没有伪造 pg 返回值、没有修改实现或数据库触发器），HTTP 返回脱敏 500，档案和 http_request 都为 0 行；同键重试成功，随后重放仍为同一收据。
- http_request：强制 RLS，无上下文/跨租户读取 0 行，跨账户 INSERT 42501，UPDATE/DELETE/TRUNCATE 42501，键存储均为 SHA-256。
- 管理员连接拒绝创建应用；SQL 失败后连接账户上下文无泄漏；数据库已关闭时错误体只有中文通用错误，不包含连接地址、角色、端口、栈或凭据。
- DELETE 危险入口和未验证 internal 调用全部 403；尚未实现的运行/审批/升级/派发业务 API 返回 404 NOT_FOUND，没有占位业务数据。

## 基础回归

首轮独立执行 lint、control 与 contracts 的严格 tsc、API/auth/context 三文件 42 项测试、原前端 20 文件 162 项测试、mock 构建，全部通过；修复复测 API/auth/context 已为 45 项且全部通过。250 个前端基线文件哈希一致。复现命令：

```sh
export PATH=/Users/guangjieyu/.npm/_npx/52027bd8fc0022aa/node_modules/.bin:$PATH
pnpm lint
pnpm exec tsc -p services/control/tsconfig.json
pnpm exec tsc -p packages/contracts/tsconfig.json
pnpm exec vitest run services/control/test/api.test.ts services/control/test/auth.test.ts services/control/test/context.test.ts
pnpm exec vitest run src
VITE_BACKEND=mock pnpm build
```

## 清理与限制

只创建并清理本测试自己的账户、档案和幂等收据；按随机账户 ID 精确清理，没有修改其他账户数据。SQL 恶意写入以事务/savepoint 回滚；HTTP 正常写入由接口提交，随后按自建账户 ID 清理。发生探针进程崩溃时遗留的自身 fixture 已确认并清理。

没有修改实现、迁移或角色种子，只写这两份证据。本地真实签名 JWT/JWKS 不是 Supabase 云 Auth 登录，未验证 Vault、Storage、Fly 或 staging；未实现 API 的 404 不视为业务能力通过。Q-005 既有无头浏览器回归入口未定位，不以 Vitest 冒充其通过。
