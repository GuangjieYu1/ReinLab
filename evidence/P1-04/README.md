# P1-04 · 控制面骨架

实现：Hono/Node22 HTTP入口、Supabase JWT验证（显式HS256或固定issuer JWKS）、仅sub确定账户、非特权数据库启动检查、事务本地账户上下文、中文错误、持久化幂等、me/档案API。数据源全部为真实Postgres；没有连接模型或实现翻译层。

写入先验证schema并用账户+键哈希串行化；成功收据和业务数据同事务。相同请求复用原收据，内容不同409；进程对象重建仍有效。故障注入会使收据和档案整体回滚。新增http_request强制RLS且只允许SELECT/INSERT。

ToSpec/ToTDD：`docs/tasks/P1-04.md`；红灯见`red-test-report.json`。自选恶意输入与独立评审结果见本目录其他报告。

最终结果：本项45/45、全仓432/432通过，失败0；相关模块行覆盖96/96（100%）。独立复测85/85通过，评审通过；保留首次断连崩溃与角色成员关系问题的发现、修复和复测记录。类型检查、边界检查与mock构建通过。证据中的本地故障测试使用一次性密钥和限定PID，不包含凭据。

复现（Node22，先启动本地数据库）：
```sh
pnpm install --frozen-lockfile
pnpm db:up
pnpm test services/control/test/api.test.ts services/control/test/context.test.ts services/control/test/auth.test.ts --reporter=json --outputFile=evidence/P1-04/test-report.json
pnpm exec tsc -p services/control/tsconfig.json
pnpm exec tsc -p packages/contracts/tsconfig.json
pnpm lint
```

启动控制面：按`.env.backend.example`通过安全环境注入数据库应用连接与Supabase配置，再运行`pnpm dev:control`；迁移连接不交给HTTP进程，HTTP入口不运行迁移。就绪日志仅包含状态码与端口。

限制：未开通Supabase项目，JWT测试使用本地临时密钥与真实密码学签名、本地JWKS服务器，不是云Auth登录验收。`/internal/*`在账户机器验证接入前全部拒绝；未实现的业务API返回404，不返回占位数据。

参考：[Hono Node服务](https://hono.dev/docs/getting-started/nodejs)、[Supabase JWT](https://supabase.com/docs/guides/auth/jwts)、[jose验证API](https://github.com/panva/jose/blob/main/docs/jwt/verify/functions/jwtVerify.md)。
