# 第五批：研究卡片、档案版本钉住与页回执独立安全评审

日期：2026-10-23。工作树：`/Users/guangjieyu/.codex/worktrees/research-foundation/ReinLab`。仅安全/迁移复核，未修改普通实现，未读取真实凭据/容器Env或调用模型。

## 最终结论

**本轮安全与数据库迁移评审通过。** 首轮发现的空白quote绕过已由root修复，独立红→绿验证完成；最终定向5文件9/9通过。此结论不代表整个P1-12、真实模型端到端或本地旧账户迁移已完成。

## 已关闭发现：空白引用被错误视为原文子串

原`normalized(quote)`将仅空白quote变为`''`，而任何pageText.includes('')都为true；schema的minLength=1不能阻止此情况。独立测试实际确认原实现resolve而不是拒绝。

root修复在每个anchor验证前显式拒绝normalized quote长度0；同一独立测试现通过，错误为固定`CARD_CITATION_UNVERIFIED`。

## 本人实际执行与证据

所有命令login:false、先unset DEEPSEEK_API_KEY，使用指定Node22 PATH。仅测试PG及合成数据，无真实模型、key或浏览器操作。

- 最终命令：`vitest run services/control/test/bench-pin-migration-security-review.test.ts services/control/test/card-integrity-security-review.test.ts services/control/test/research-release.test.ts services/control/test/research-card-citations.test.ts services/control/test/research-pin.test.ts`：5文件、9/9通过。
- 新独立`bench-pin-migration-security-review.test.ts`：真实PG事务内创建隔离schema、最小迁移前表形状，执行原样202610230003 SQL；既有无override档案回填1.0.0、既有override档案保留其1.0.0-reviewed-override、新档案默认1.1.0、title/path不变；更新bench或bench_version均23514拒绝。整个隔离schema与数据rollback，不改共享真实表。
- 新独立`card-integrity-security-review.test.ts`：空白quote拒绝；真实paper_page_read启用RLS+FORCE、其他租户不可见、应用角色UPDATE/DELETE均42501拒绝；本run匹配页引用可通过，另一run即使同账户/档案/asset/page仍拒绝。
- 原研究引用测试实际验证未读/跨asset/错页/编造quote拒绝、成功papers.pages之后允许；quiz keys只进入注入的档案deposit，event/result不含keys，无deposit失败关闭。
- 原研究pin/release测试实际通过；额外字节/对象比较输出：旧1.0归档与HEAD原manifest逐字节相等=true，去掉version/cards后的新旧manifest对象相等=true，registry目录tracked diff为空=true。
- 未跑全量。未实际运行可信local迁移脚本；root报告的真实local迁移/围栏与资源诊断不计作本人亲自执行。

## 代码复核

### 数据库迁移

202610230003：新增bench_version先回填旧档案，再设置1.1.0默认及NOT NULL；已存在override通过同账户digest关联bench_effective保留对应version。before-update触发器禁止bench或bench_version变化，普通title更新不触发版本变更。触发函数撤回public执行权；触发器仍可调用。独立迁移测试验证原样SQL语义；并未声称重放了全量生产历史数据。

202610230004：receipt以(account,run,asset,page,text_sha256)为主键，run FK绑定(account,dossier,run)，asset FK绑定(account,dossier,asset)，阻止跨账户/档案错接；页号和文本大小约束存在。RLS+FORCE按当前app.account_id；仅grant select/insert，撤回update/delete/truncate，再加append-only触发器。

### 冻结版本与schema

HarnessStore首先读取dossier钉住版本，再从已发布bench_version加载对应bundle/registry；缺失钉住版本失败关闭，不套用当前默认。effective、propose与decide走相同pin选择。bench_version原有append-only与数据库权限保护继续存在。

新研究manifest只修改version/cards；原1.0字节归档保留。schema通过bundle引用哈希纳入冻结内容。CapabilityEngine.inputSchema在当前run_harness→bench_effective→bench_version关联中取得已冻结声明及schema，再校验引用hash并compile；MCP tools/list据该结果广告工具，未声明卡返回null，1.0不会因当前工作树发布1.1而广告卡。

### 原文回执与quiz内容

papers.pages handler结果先通过大小/output schema验证，要求assetId与请求相同、返回页属于请求页集合；写回执前在账户事务内lockBudget并在线validateClient复验token，只允许当前档案full_text asset。回执文本SHA由实际结果文本计算；conflict只接受已存在的同run/asset/page/hash记录。

card-integrity对当前account/dossier/run/asset/page查询回执，重新验证page_text SHA，再以空白规范化后的非空quote匹配原文；layer顶层paperId与anchor一致。quiz顶层paperId也必须在本run读过。卡片JSON先走当前run冻结schema，防类型coercion与额外字段。

quiz keys仅传CardDeposit写read/quizzes/<服务端UUID>.json，路径必须落在冻结role的write_targets；没有deposit失败关闭。event前删除keys，工具返回仅cardId；engine审计记录参数hash/resultHash而非原参数。该结论限定为“不进入event/result”；不声称档案文件是对所有有档案读取权限的代码隐藏的秘密。

### 可信local迁移脚本快速复核

services/control/scripts/migrate-local-credentials.ts只用严格readRuntimeConfiguration读取runtime.env，ENV仅传配置文件路径；强制docker和既定image，使用持久ACCOUNT_* operation及对应_IMAGE，目标变更拒绝。使用listLegacyMachines明确列出受管理对象，交给已评审生命周期身份/租约/幂等/unknown围栏；后续ensure对账，输出固定code和计数。证据JSON只含账户ID/状态/image，不写凭据。未实际执行，也未因root已尝试迁移而降低unknown检查要求。

## 范围限制

未验证生产备份规模或全量历史迁移时长；未执行模型端到端；未读取真实local文件或容器Env。引用收据是可信应用服务记录的成功schema-validated结果，不提供对已掌控reinlab_app数据库凭据的攻击者的独立真实性证明。MCP tools/list最终schema接线本轮主要代码复核，研究release/pin/citation及独立迁移边界由上述实际测试覆盖。
