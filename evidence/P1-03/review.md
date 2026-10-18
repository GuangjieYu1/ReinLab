# P1-03 独立评审

结论：**通过，未发现阻断问题。**

评审范围：任务 ToSpec / ToTDD、实现规格 §4.1、Q-011–013、两份数据库迁移、10 份中文角色模板、迁移器与 CLI、真实数据库 / 迁移测试、研究 CI 和本地容器配置。冻结快照只读评审，额外数据库攻击全部在事务内回滚；仅写本报告，没有改实现或已应用迁移、没有提交 Git。

## 数据库与权限

- 14 张底座表均纳入 RLS；12 张业务表按 account_id 过滤，account 按自身 id 过滤，role_def 仅全局 SELECT。策略带 USING / WITH CHECK，缺少或清空账户上下文默认拒绝。
- 应用角色无超级权限、无 BYPASSRLS、非所有者、不能创建数据库 / 角色；表启用 FORCE RLS。普通应用没有账户 INSERT，不能创建 schema 对象，role_def 无写权限；event 不允许 UPDATE / DELETE / TRUNCATE，序列只授予追加所需权限。
- 跨账户引用通过复合外键绑定；event / artifact 的运行关联同时绑定档案；memory 的 thread / delegation 的来源与目标运行也约束账户和必要档案，nullable 关联补有对应 CHECK。request_id / dedupe_key 按 Q-011 限定账户唯一。
- 10 个角色种子与提示词存在；工具授权无 danger，写入为 ask，读取限定当前档案 / 本人消息 / 显式引用，核实者限定分配的引用。模板本身不能替代后续实际工具授权 / 运行令牌隔离验证，与 Q-013 一致。

## 迁移与注册触发器

- 迁移器使用同一专用连接持有 session advisory lock，串行检查与应用文件；每文件独立事务，提交时同步记录 SHA256，异常回滚；已应用内容变化拒绝，幂等运行不重放副作用，finally 解锁并释放连接。
- 已检查真实迁移测试覆盖：失败 DDL 回滚、已成功文件保留、同一迁移并发只应用一次、重复执行和 hash 篡改拒绝。现有 JSON 报告记录 91 个测试通过；本评审没有重复执行会建立持久测试样本的整个套件。
- 注册函数 SECURITY DEFINER 固定 search_path，写入显式 public.account，只取 NEW.id 与 display_name；没有动态 SQL 或客户端传入的账户参数。PUBLIC execute 已撤销，普通应用无 EXECUTE；仅检测到 auth.users 时安装触发器。防止普通应用借此代建账户的静态权限配置正确。
- CI 使用相同真实 pgvector/Postgres16 服务运行测试与类型检查，没有跳过数据库门禁；迁移 CLI 与后续 HTTP 进程分开。

## 独立真实数据库核验

环境为指定 Node v22.23.3 / pg 客户端与本地 127.0.0.1:55432 测试数据库。

使用真实 reinlab_app 登录，只读事务中确认：

| 检查 | 结果 |
|---|---|
| rolsuper / rolbypassrls / rolcreaterole / rolcreatedb / rolinherit | 全部 false |
| 无账户上下文查询 account | 0 行 |
| 全局 role_def | 10 行 |
| event UPDATE / DELETE / TRUNCATE | 全部无权限 |
| role_def UPDATE | 无权限 |
| public schema CREATE | 无权限 |
| reinlab_on_signup() EXECUTE | 无权限 |

另在管理员事务建立临时 A / B 账户和档案，SET LOCAL ROLE reinlab_app 并绑定 A；每项攻击使用 savepoint，结束整体 ROLLBACK，没有持久变更：

- A 的 thread 关联 B 的 dossier：23503 外键拒绝。
- 应用 UPDATE event：42501 权限拒绝。
- 应用 UPDATE role_def：42501 权限拒绝。
- A 查询 B 的 dossier：0 行。

## 验收范围

这是本地真实 **pgvector/Postgres16** 的 SQL / RLS 评审与验证，**不是 Supabase Auth / Vault / Storage 或东京 staging 集成验收**。本地没有 auth.users，注册事件的端到端行为仍须按 Q-012 在真实 Supabase 环境复验。账户上下文必须由后续经过 JWT 验证的控制面在事务内设置；自定义 GUC 与数据库租户 RLS 不替代身份认证或同账户内的角色 / 档案授权。
