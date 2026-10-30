# 地基第 5 项 · 登录会话 · 前后端约定

依据 `02-foundation.md` 第 5 节（grill 已完成）。本文件只写前端需要的接口和语义，服务端怎么存、怎么续期由 DSH 定。

## 1. 浏览器侧只有一个 Cookie

- 名字 `rl_session`，内容是不透明的会话标识。设置为 `HttpOnly`、`SameSite=Strict`、`Path=/`；HTTPS 下加 `Secure`，本地 HTTP 不加。
- 页面里不再拿到任何 access/refresh token。localStorage、sessionStorage、URL 里都不放长效凭据。
- 上游身份 token（Supabase）由控制面保管和续期，不回给浏览器。

## 2. 接口

所有路径都走现有同源前缀 `/backend`。

| 方法与路径 | 请求 | 成功 | 失败 |
|---|---|---|---|
| `POST /auth/login` | `{ email, password }` | `200 { accountId, displayName?, idleExpiresAt, absoluteExpiresAt }`，并 Set-Cookie | `401 { code: 'INVALID_CREDENTIALS' }` |
| `GET /auth/session` | 无（靠 Cookie） | `200 { accountId, displayName?, idleExpiresAt, absoluteExpiresAt }` | `401 { code }`，见第 3 节 |
| `POST /auth/lock` | 无 | `204`，撤销服务端会话并清除 Cookie；重复调用也返回 204 | — |
| `POST /auth/touch` | 无 | `204`，把空闲期限往后顺延（不超过绝对期限） | `401 { code }` |

- 打开页面时调一次 `GET /auth/session`，这次算"使用"，会顺延空闲期限。登录本身也算使用。
- `POST /auth/touch` 由前端在用户真实操作（点击、输入、切换档案）时调用，最多每 10 分钟一次。
- 轮询、SSE 心跳、后台拉取都不算使用，不能顺延空闲期限。

## 3. 前端要区分的状态

| 前端状态 | 怎么判断 | 页面表现 |
|---|---|---|
| 恢复中 | `GET /auth/session` 还没返回 | 不闪登录页，显示入口的加载态 |
| 已登录 | `/auth/session` 或 `/auth/login` 返回 200 | 正常进入 |
| 已退出 | `401 { code: 'NO_SESSION' \| 'SESSION_REVOKED' }` | 登录页 |
| 已过期 | `401 { code: 'SESSION_EXPIRED' }`（空闲 30 天或绝对 90 天到期） | 登录页，提示"登录已过期" |
| 连接失败 | 网络错误或 5xx | 显示连接问题，可重试，**不**当成退出 |

所有 `/backend/v1/*` 请求返回 401 时也带同样的 `code`，前端按同一张表处理。

## 4. 业务接口改用 Cookie 认证

- `/backend/v1/*` 全部改成认 Cookie，包括 SSE `/v1/stream` 和运行事件流。浏览器请求不再带 `Authorization: Bearer`。
- 后端去掉浏览器用的 Bearer 旧路径，不能留一个绕过会话撤销的入口。Agent 运行自己的认证（运行 token）保持不变，锁定不影响它。
- 写操作（非 GET）防 CSRF：校验 `Origin` 必须是同源，并要求请求头 `X-ReinLab-CSRF: 1`。前端所有写请求都带这个头。

## 5. 锁定

- 前端点锁定：先立刻遮住页面、清空内存里的账户数据、断开 SSE，再调 `POST /auth/lock`；成功后通过 `BroadcastChannel('reinlab-session')` 通知其他标签回到登录页。
- `POST /auth/lock` 因断网失败时：页面保持遮住，显示"退出未完成，恢复连接后会自动完成"，联网后重试，不自动恢复显示。
- 锁定不取消正在跑的任务，也不批准或驳回待批请求。再次登录后结果和请求都还在。
- 重新登录后回到原来的 URL（比如 `?dossier=…`）；档案不可访问时进入该台的真实列表（第 4 项已有的行为）。

## 6. S5 的验法

会话表里存 `last_used_at`（空闲起点）和 `created_at`（绝对起点）。验收时 Claude 直接在本地库里把这两个时间往前改，再在页面上访问，不需要额外脚本或开发接口。DSH 用单元测试覆盖时钟逻辑。
