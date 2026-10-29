# P1-03 独立测试

结论：本地真实 Postgres 数据库范围通过。140 项检查全部通过、0 失败，其中自行设计的数据库检查 133 项，包括实际目录枚举的全部 45 条外键攻击。开发者数据库/迁移套件 91/91 通过，原前端测试 162/162 通过。

## 环境与边界

依据 `docs/tasks/P1-03.md`、本期 README 与 Q-011–013。环境是 `127.0.0.1:55432/reinlab_test` 的真实 pgvector/Postgres16。普通 SQL 使用实际登录 `reinlab_app`，没有使用 postgres 会话切换角色代替应用连接。管理员只读目录/既有测试样本关联 ID，以及创建和销毁迁移测试用的临时数据库；没有读取凭据内容或修改角色种子。

独立应用样本与恶意写入全部在事务内运行，使用 savepoint 分隔预期失败并最终回滚。迁移原子性测试使用随机名称的独立可丢弃数据库和临时 SQL 目录，finally 中关闭连接、删除数据库与临时目录。未修改实现、仓库迁移或角色种子，仓库只新增这两份独立证据。Postgres 序列在回滚后可能留下正常的编号间隙，不将其视为业务记录残留。

## 独立数据库检查

| 范围 | 核验结果 |
|---|---|
| 应用权限 | NOSUPERUSER、NOBYPASSRLS、NOCREATEROLE、NOCREATEDB、NOINHERIT；public 表所有权 0 |
| 14 张底座表 | 全部启用并强制 RLS |
| 13 张账户表 | 无上下文 0 行，A 读取 B 为 0 行；事务结束不残留上下文 |
| 账户隔离更新 | A 更新 B 的 12 张可更新账户表均 0 行；event 另被权限明确拒绝 |
| 全部 45 条外键 | 从 pg_constraint 自动枚举并逐一攻击，全部遭 RLS 或 FK 拒绝 |
| 同账户不同档案 | event/run、artifact/run、artifact/supersedes、memory/thread、delegation 源/目标 run 六种错配全部 FK 拒绝 |
| 账本 | 正常追加允许；UPDATE、DELETE、TRUNCATE 全部 42501 |
| role_def | 10 个模板可读；INSERT、UPDATE、DELETE、TRUNCATE 全拒绝；read=allow/write=ask，无 danger 授权 |
| 提权 | SET ROLE postgres、ALTER ROLE SUPERUSER、CREATE SCHEMA、关闭表 RLS、读取迁移内部表全部 42501 |
| row_security=off | 设置本身不能绕过 RLS，后续查询以 42501 拒绝 |
| Q-011 | 同账户 request_id/dedupe_key 重复 23505，不同账户复用相同键均允许 |

外键攻击是以合法必填数据为基础替换关联资源，避免仅凭缺必填字段得到失败。引用 account 的外键以伪造 B 的 account_id 测试，预期 42501；租户资源关联保持 account_id=A，改用 B 的关联 ID，预期 23503；全局 role_def 的外键使用不存在的角色 ID，预期 23503。单列外键可能由并存复合外键先行拒绝，结论是关联绕过整体不可行，不声称只由被命名的那条约束独立拒绝。完整约束清单、SQL、预期和实际 SQLSTATE 见 JSON。

## 独立迁移故障检查

自行生成两次迁移：第一份建立样本表；第二份先 INSERT 并 CREATE TABLE，再调用不存在的函数，实测得到 42883。失败文件的 INSERT 与 CREATE TABLE 全部回滚，迁移记录仅保留成功的第一份。

替换临时失败文件为单次插入迁移后，四路并发调用 applyMigrations，只有一次返回已应用文件，数据恰好一行。再执行返回空数组；篡改已应用文件得到 MIGRATION_CHANGED，原数据仍在，篡改 SQL 未执行。共 8 项独立迁移检查全部通过。所有操作均发生在独立临时数据库，没有改写仓库 SQL。

## 回归与复现

```sh
export PATH=/Users/guangjieyu/.npm/_npx/52027bd8fc0022aa/node_modules/.bin:$PATH
pnpm lint
pnpm exec tsc -p services/control/tsconfig.json
pnpm exec tsc -p packages/contracts/tsconfig.json
pnpm exec vitest run services/control/test/database.test.ts services/control/test/migrate.test.ts
pnpm exec vitest run src
VITE_BACKEND=mock pnpm build
```

以上全部成功；前端 250 个文件 SHA-256 与 P1-01 基线一致。独立额外检查以 Node 导入 pg/applyMigrations，使用真实 app 连接、事务/savepoint、实际 pg_constraint 清单执行。JSON 包含逐项结果及迁移/迁移器 SHA-256。

## 明确未验证

本轮没有验证 Supabase Auth 注册触发器的真实环境路径、JWT、Vault、Storage、Fly 或 staging。账户上下文 GUC 由可信服务端设置；数据库应用角色不是 HTTP 终端用户身份，本轮不把数据库隔离测试当作 JWT/API 授权测试。角色模板工具与真实 OpenScience 权限语义仍依赖后续 SPIKE。Q-005 原有无头浏览器回归脚本未定位，不以 Vitest 冒充其通过。
