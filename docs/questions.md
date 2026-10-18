# 研究台实施问题

依据：CODEX_SPEC_RESEARCH.md 优先于背景草案。2026-10-19 用户确认以下推荐；后续新增问题注明状态、理由与影响。

| 编号 | 问题 | 推荐与理由 | 状态 |
|---|---|---|---|
| Q-001 | 前端大量未提交文件，任务 PR 需要可复现基线 | 原目录不动；独立 worktree 保存现有前端。P1-01 纳入运行所需基线，证据记录哈希；不纳入 promo、Claude outputs 等无关文件 | 用户已确认 |
| Q-002 | X8 与 SEC-4 的人工 danger 例外冲突 | 本批所有入口拒绝 danger，不开放删除档案；遵循红线与最小权限 | 用户已确认 |
| Q-003 | 同账户不同档案隔离不能只靠账户 RLS / project 目录 | 数据库补复合租户外键；应用校验档案范围；执行文件与工具权限必须在接入时实测，不把目录当沙盒 | 用户已确认；执行隔离待 SPIKE |
| Q-004 | account 自身无 account_id，role_def 是全局表 | account 按 id 隔离；role_def 全局只读、启用 RLS 且不给应用写权限；业务表强制 RLS | 用户已确认 |
| Q-005 | 当前未定位既有无头回归脚本 | 先保存现有 Vitest / build 结果与研究台基线；继续寻找原脚本；未找到前不声称原脚本已通过 | 待提供脚本入口；不阻塞底座 |
| Q-006 | Fly、Supabase staging 项目不存在 | 用户明确答复“没有”。继续本地真实数据库与容器验证、交付部署步骤；P1-08 云端三分钟可用不可判完成，不擅自开通付费账户 | 外部条件缺失，云验收待配置 |
| Q-007 | 旧 WORKBENCH_SPEC 的 50%/80% 暂停与现行 80%提醒/100%停止不同 | live 遵循现行实现规格，mock 保留旧表现；同一视图从数据源取得状态 | 用户已确认 |
| Q-008 | 技术选型要求本地 Supabase CLI，目录示例又要求 compose Postgres | 迁移须兼容 Supabase；本地集成优先 Supabase Postgres 镜像，CLI 配置保留，不能降低 RLS 校验 | 推荐执行，随环境记录 |
| Q-009 | RunToken、运行确认字段、artifactRef、升级 items 未给完整 schema | 使用账户/档案/运行/会话/角色绑定令牌；明确 read/write 授权（无 danger）、只读引用与期限。启动绑定 estimateId+confirmed:true；artifactRef 复用带版本 Ref；升级每项必须有依据。结构与权限分开，schema 合法不等于已授权 | 推荐执行；P1-02 起落地 |
| Q-010 | finding_record 要至少1引用，而 swarm.deliver 允许无引用的负结果 | 保留各自合同：finding_record 要引用检索记录产物；swarm.deliver negative=true 可以无论文引用，但 summary 不为空并必须说明检索过程。语义核实留给服务端，不用字数或关键词假装验证 | 推荐执行；P1-02 已区分 |

外部凭据仅使用安全环境配置，不写入本文件、账本或证据。

2026-10-19 补充：用户询问无头回归含义，已解释后台浏览器自动操作；目前没有可确认的既有脚本入口。找到 `/Users/guangjieyu/Documents/OpenMAIC`，先只读核实单场景生成，不读取其 `.env*` 或模型密钥。
