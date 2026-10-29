# P1-04 独立评审

最新结论（修复后复审）：**通过。角色成员资格阻断已关闭，空闲及借出连接异步断连可恢复，未发现未关闭的评审阻断。**

首轮失败记录保留如下，最终复审见文末。

范围：任务 ToSpec / ToTDD、Q-014/015、API app/auth/context/errors、Database/main、新增 http_request 迁移、共享输出契约、真实 API / JWT / 事务测试。未读取真实凭据；数据库额外验证仅在事务内创建 scratch 角色 / 表并整体回滚，未修改现有表、实现或迁移；仅写本报告。

## P1：assertSafeRole 接受可继承表所有权的应用连接

位置：`services/control/src/db/database.ts:7–10`。

检查仅验证当前角色自身属性，且以 `tableowner=current_user` 判断所有者，忽略 PostgreSQL 成员资格带来的所有者权限。非特权角色可以从 owner 角色继承表所有权、执行 ALTER TABLE 关闭 RLS，同时通过当前启动检查。

真实 PostgreSQL 中事务回滚复现：

```sql
BEGIN;
CREATE ROLE review_owner NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE review_app NOLOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
GRANT review_owner TO review_app;
GRANT USAGE ON SCHEMA public TO review_app;
CREATE TABLE public.review_table(id integer);
ALTER TABLE public.review_table OWNER TO review_owner;
ALTER TABLE public.review_table ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.review_table FORCE ROW LEVEL SECURITY;
SET LOCAL ROLE review_app;
-- 使用同一真实连接执行 Database.assertSafeRole()：被接受。
ALTER TABLE public.review_table DISABLE ROW LEVEL SECURITY;
-- 成功：当前角色实际拥有绕过架构保护的所有者能力。
ROLLBACK;
```

独立执行时角色 / 表名加入随机后缀避免冲突；使用真实连接适配 query 给 Database 检查，输出 `assertSafeRole accepted inherited table owner` 与 `inherited owner disabled RLS successfully`。所有创建对象和角色变更已随事务回滚。

当前默认 reinlab_app 角色本身没有该成员资格，因此不是已验证默认连接正在越权；缺陷在启动检查承诺拒绝不安全连接，却接受此类常见 owner-group 配置。仅检查 NOINHERIT 也不够：成员可能通过 SET ROLE 获得权限。

建议：检查当前角色通过成员资格 / 可 SET ROLE 获得的 public 表所有权与超级、BYPASSRLS、创建角色等特权；可使用 pg_has_role 对受保护表 owner 和特权角色进行检查，或明确仅接受受控应用角色并验证其角色图无危险成员关系。补真实数据库继承 owner / 可 SET ROLE 的负例，以及正常 reinlab_app 正例。

## 其他已审查项

- JWT 模式由可信配置确定；HS256 与 JWKS ES256/RS256 算法集合分离，固定 issuer/audience，要求 sub/exp/iat/iss/aud 与 authenticated role；账户仅取已验签 UUID sub，元数据不参与账户选择。
- 未初始化账户拒绝；RLS 上下文由事务本地 set_config 设置；正常提交、异常回滚，rollback 失败时销毁连接。数据库连接与迁移入口分离。
- 幂等 key / 请求内容只存 SHA256；账户+键 advisory transaction lock 串行化，同键冲突比较归一化 method/path/schema 数据；业务写入与收据同事务，跨账户键隔离，进程重建不依赖内存。当前副作用仅在同一数据库事务内，未接外部模型调用。
- http_request 强制 RLS，仅应用 SELECT/INSERT，无 UPDATE/DELETE/TRUNCATE。后续若加入外部副作用，需新的幂等 / outbox 设计，现有事务不自动覆盖外部执行。
- 中文错误统一且不暴露数据库详情、堆栈或凭据；内部路径在账户机器验证前拒绝，DELETE 拒绝，未实现接口为404。共享响应不含内部 workspace_path。
- 独立运行 auth/context 测试 **6 / 6 通过**，lint 通过。已审阅开发报告与42测试覆盖内容，未重复执行会持久建立 API 测试样本的完整套件。

范围限制：本地真实签名 / JWKS / PostgreSQL 不等于云 Supabase 登录、Auth/Vault/Storage 或 staging 验收。


## 修复后独立复审

结论：**通过，首轮 P1 已关闭，未发现本轮修复引入的阻断问题。**

### 角色保护

`assertApplicationRole` 现额外查询 pg_auth_members，任何角色成员关系即拒绝；不会仅依赖 INHERIT 标志，因此也覆盖 NOINHERIT 后 SET ROLE 的权限取得路径。正常 reinlab_app 无成员关系，仍可通过。

独立在真实数据库事务中创建随机 owner / derived 角色，分别赋予 INHERIT 与 NOINHERIT 成员关系，切换 derived 后调用同一检查：**两者均拒绝**；事务已回滚，未留角色或数据。正常 reinlab_app 另行登录检查通过。代码内真实 owner scratch 表负例与两种继承模式回归已审查。

### 异步断连保护

Database 对每个 pool 仅安装一次 error 监听；借出 client 时安装独立监听，异步异常标记坏连接，事务退出时销毁并清除本次监听。日志仅记录固定错误码，没有异常原文 / 连接信息 / 凭据。原有事务提交、回滚和账户本地上下文逻辑保持。

独立真实数据库验证：

- 已释放的空闲应用连接被管理员按 pid 终止，捕获 `DATABASE_POOL_ERROR`；随后 withAccount 新建连接并返回正确账户上下文，进程存活。
- 在真实子进程运行 connection-recovery fixture，按其 BORROWED pid 终止借出连接；观察到 `DATABASE_CONNECTION_ERROR` 后放行后续查询，坏事务失败，后续连接恢复成功，子进程退出码 **0**。

这些验证仅操作本次创建的数据库连接，不修改业务数据。独立 auth/context **6 / 6 测试通过**，lint 通过；完整45测试、类型检查与覆盖结果由独立测试报告提供，本评审未重复创建完整 HTTP 套件的持久样本。

本轮只更新本报告，没有改实现或迁移。仍仅为本地 PostgreSQL / JWT / JWKS 验证，不将其表述为 Supabase 云集成完成。
