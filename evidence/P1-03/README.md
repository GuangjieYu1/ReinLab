# P1-03 · 迁移、RLS 与角色种子

实现合同§4.1的14张底座表；所有表启用并强制RLS，account按id隔离，role_def全局只读。应用角色NOSUPERUSER/NOBYPASSRLS且不拥有表，不能创建schema或删除业务数据；event额外撤销UPDATE/DELETE/TRUNCATE。跨账户与档案关联由复合外键拒绝。幂等键/去重键限定账户；解释见Q-011。

10个角色的中文提示词、分档与授权种子随迁移提供。普通应用无角色写权限、无账户代建权限；Supabase Auth注册触发器仅在auth.users存在时安装。

ToSpec/ToTDD：`docs/tasks/P1-03.md`；缺迁移文件的红灯见`red-test-report.json`。真实数据库SQL/RLS测试与迁移故障测试见`test-report.json`及独立报告。

复现（Node22，Docker）：
```sh
pnpm install --frozen-lockfile
pnpm db:up
pnpm db:migrate:local
pnpm test services/control/test/database.test.ts services/control/test/migrate.test.ts --reporter=json --outputFile=evidence/P1-03/test-report.json
pnpm exec tsc -p services/control/tsconfig.json
pnpm lint
```

迁移器用专用锁、每文件事务与SHA256记录：并发执行不重复，失败整体回滚，已应用文件内容变化直接拒绝。HTTP进程不调用迁移器。

环境限制：使用回环端口的可丢弃pgvector/Postgres16容器，测试登录不含密钥；应用查询仍使用独立非特权角色与完整RLS。不是Supabase Auth/Vault/Storage或staging验证，不据此宣称上述集成完成。仅迁移连接建立测试样本；应用不使用管理员连接。Supabase CLI配置与迁移目录保留，待真实环境复验。

官方参考：[PostgreSQL RLS](https://www.postgresql.org/docs/16/ddl-rowsecurity.html)、[Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)。

结果：91项数据库/迁移测试、387项全套测试、140项独立检查均通过，0失败；迁移器行覆盖率100%（24/24）。独立评审通过，所有45条外键已另选样本攻击验证。
