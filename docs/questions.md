# 研究台实施问题

依据：CODEX_SPEC_RESEARCH.md 优先于背景草案。2026-10-19 用户确认以下推荐；后续新增问题注明状态、理由与影响。

| 编号 | 问题 | 推荐与理由 | 状态 |
|---|---|---|---|
| Q-001 | 前端大量未提交文件，任务 PR 需要可复现基线 | 原目录不动；独立 worktree 保存现有前端。P1-01 纳入运行所需基线，证据记录哈希；不纳入 promo、Claude outputs 等无关文件 | 用户已确认 |
| Q-002 | X8 与 SEC-4 的人工 danger 例外冲突 | 本批所有入口拒绝 danger，不开放删除档案；遵循红线与最小权限 | 用户已确认 |
| Q-003 | 同账户不同档案隔离不能只靠账户 RLS / project 目录 | 数据库补复合租户外键；应用校验档案范围；执行文件与工具权限必须在接入时实测，不把目录当沙盒 | 用户已确认；执行隔离待 SPIKE |
| Q-004 | account 自身无 account_id，role_def 是全局表 | account 按 id 隔离；role_def 全局只读、启用 RLS 且不给应用写权限；业务表强制 RLS | 用户已确认 |
| Q-005 | 当前未定位既有无头回归脚本 | 先保存现有 Vitest / build 结果与研究台基线；继续寻找原脚本；未找到前不声称原脚本已通过 | 审查方说明历史入口/tmp/rl-prof/*.mjs；待整理到e2e/legacy，不声称已复跑 |
| Q-006 | Fly、Supabase staging 项目不存在 | 用户明确答复“没有”。继续本地真实数据库与容器验证、交付部署步骤；P1-08 云端三分钟可用不可判完成，不擅自开通付费账户 | 外部条件缺失，云验收待补验；用户明确不阻塞P1-10本地开发 |
| Q-007 | 旧 WORKBENCH_SPEC 的 50%/80% 暂停与现行 80%提醒/100%停止不同 | live 遵循现行实现规格，mock 保留旧表现；同一视图从数据源取得状态 | 用户已确认 |
| Q-008 | 技术选型要求本地 Supabase CLI，目录示例又要求 compose Postgres | 迁移须兼容 Supabase；本地集成优先 Supabase Postgres 镜像，CLI 配置保留，不能降低 RLS 校验 | 推荐执行，随环境记录 |
| Q-009 | RunToken、运行确认字段、artifactRef、升级 items 未给完整 schema | 使用账户/档案/运行/会话/角色绑定令牌；明确 read/write 授权（无 danger）、只读引用与期限。启动绑定 estimateId+confirmed:true；artifactRef 复用带版本 Ref；升级每项必须有依据。结构与权限分开，schema 合法不等于已授权 | 推荐执行；P1-02 起落地 |
| Q-010 | finding_record 要至少1引用，而 swarm.deliver 允许无引用的负结果 | 保留各自合同：finding_record 要引用检索记录产物；swarm.deliver negative=true 可以无论文引用，但 summary 不为空并必须说明检索过程。语义核实留给服务端，不用字数或关键词假装验证 | 推荐执行；P1-02 已区分 |
| Q-011 | request_id/dedupe_key 草案全局唯一会让不同账户键冲突 | 唯一性限定(account_id,key)，保留同账户幂等与去重。外键补account_id和必要dossier_id，避免A写入关联B资源 | 推荐执行；P1-03 |
| Q-012 | 本地环境没有Supabase CLI实例，staging尚未开通 | 使用现有锁定pgvector/Postgres16镜像跑真实SQL/RLS测试，保留Supabase CLI配置。只宣称Postgres部分通过；Auth注册触发器、Vault/Storage及东京部署另需真实Supabase复验 | 条件限制，待Supabase项目配置 |
| Q-013 | 角色步数和权限JSON未给完整字段 | 种子采用只读allow、写入ask、无danger的精确工具白名单；read_scope限定本档案、本人消息和显式引用。步数按角色32–96，模板只读；翻译层接入时须再验证实际工具与权限语义 | 推荐执行；P1-03，后续依赖SPIKE |
| Q-014 | 基础API只给路径未给完整响应与幂等存储 | 响应补共享camelCase契约，不返回内部工作区路径。新增RLS的http_request表：只存键哈希、归一化内容哈希与成功收据，和业务写入同事务；账户+幂等键唯一 | 推荐执行；P1-04 |
| Q-015 | Supabase同时存在旧HS256密钥和新JWKS签名模式 | 显式配置密钥时只接受HS256；未配置时使用固定Supabase issuer的JWKS，只接受ES256/RS256。不根据JWT头切换模式；JWT账户只取已验签sub且必须已初始化 | 推荐执行；P1-04；云Auth待验 |
| Q-016 | 请求限制与安全应用角色检查的细节未给定 | 本批JSON接口限制1MiB、幂等键1–200位ASCII标识符；未来文件上传单独配置。应用角色不拥有表、不具超级/绕过/建库/建角色/schema-create权限，且不属于其他角色，防止继承或SET ROLE取得owner权限 | 推荐执行；P1-04；评审补充 |
| Q-017 | pg连接池/已借出连接的异步error会绕过Promise异常处理 | 连接池注册一次错误监听；借出连接临时监听并标记损坏，最终销毁坏连接。只记稳定错误码，不输出PG错误内容/连接串；以真实子进程分别断开其空闲和借出连接复验，不杀其他服务连接 | 评审/独立故障测试发现并修复；P1-04 |
| Q-018 | 全局bigserial对单档案存在间隙，且并发事务提交次序可能与序号不同；审计JSONL格式未定义 | 每账户事务锁后再分配seq，保证已提交可见顺序并避免跨档案追加的锁顺序循环；客户端按最后收到的全局seq续读，不要求不同档案连续整数。after与Last-Event-ID取较大值。审计逐行event，末行summary，金额六位小数字符串、未知单独计数，额度/GPU分列 | 推荐执行；P1-05 |
| Q-019 | 账本payload可能夹带凭据，规格未给序列化脱敏细节 | 追加前递归过滤凭据字段、Bearer/JWT/API密钥及带认证URL，引用也过滤；读取和导出再过滤以保护旧记录。保留非敏感结构与明确的[REDACTED]标记；不把脱敏当作引用核验 | 推荐执行；P1-05 |
| Q-020 | P1-06只指定状态机，未列阶段清单、门禁API及审阅引用 | 遵循背景§5六态语义；可信工作流初始化可配置线性链，不虚构研究阶段。新增用户transition接口，仅start/discuss/approve且需expectedState+expectedRevision，拒绝讨论再提交后的旧批准；submit/resubmit只供可信服务且需真实同档案artifact。批准只解锁后继，不自动开始；所有转移和账本同事务 | 推荐执行；P1-06 |
| Q-021 | models.dev按美元标价，尚无账户模型路由、汇率或token预估公式 | 路由与USD/CNY必须安全环境显式配置；缺失/未知价格拒绝预估，双零价格不当作已验证免费。每份估算固定目录摘要、模型/汇率和token假设，10分钟有效；token假设为可解释规划量，不冒充实际用量，后续按真实用量计费 | 推荐执行；P1-07，模型路由/汇率待配置 |
| Q-022 | 底座表缺层级划拨/工具费用保留，run.spent仅4位而账本6位 | 新增强制RLS预算划拨、费用保留及估算表；run累计扩为6位。账户只计根划拨，子预算从父预算内分配；工具先原子保留最大费用，再结算真实回报，超额有原因且停后续工具 | 推荐执行；P1-07 |
| Q-023 | 未知API实际费用如何避免预算失控，跨月运行如何处理 | API费用缺失记null并暂停等待对账；会员额度/GPU独立计量不伪造人民币。UTC月边界先停；用户明确追加本月预算后建立新月划拨，保留运行历史累计费用，旧月余额不结转。先结清在途/未知费用，上级运行或委托也须先确认新月。追加人民币不能自行消除未对账用量 | 推荐执行；P1-07 |
| Q-024 | 预算追加原schema只含人民币，无法解除会员或GPU门禁 | 同一路径显式接受cny/quotaRuns/gpuMinutes任一正追加；GPU换为整数秒，三类独立判断。子预算先用父未划拨余额，需要时才向上增加月预留；同步祖先运行/委托的限额，避免重复预留或账面不一致 | 推荐执行；P1-07 |
| Q-025 | 预估需要token/轮次假设，缺会员次数与GPU任务规模输入 | 暂用每轮每份输入10000/输出3000，精读1轮、群研4轮（默认8份）、自研16轮，2倍价格安全系数；完整返回并保存假设供用户确认，不冒充实际用量。默认预算精读5元、群研30元，自研用户指定；未知会员/GPU预估返回null。后续由实际规划器细化，任何改动仍需重新确认估算 | 推荐执行；P1-07，政策可由用户调整 |
| Q-026 | 委托预算含三类额度，初版层级仅约束人民币 | 依据PRD D4与research_request@1，运行/委托节点三维上限都约束子划拨，扣除父在途用量并向祖先累计；追加先用父剩余再同步祖先限额。账户仅定义人民币月总额，不捏造会员/GPU月总上限；根档案未指定这两种总额时标null，已有运行/委托上限仍严格执行。run累计表示含子级的整体预算用量，账本单次费用仍归属实际调用run，账户只计根不双算 | 独立评审发现并已修复；P1-07第三轮评审及62项独立复跑通过 |
| Q-027 | 预算来源链没有深度与收据身份变更规则 | 来源最长32层，数据库触发器拒绝循环/过深；应用不能更新划拨来源/账户/月份或工具收据身份和原始上限，只可更新计数/决定。累计费用按numeric(18,6)范围解析，单次费用仍按event的numeric(12,6)上限校验，避免合法多笔回报因累计额变大丢账 | 推荐执行；P1-07 |

外部凭据仅使用安全环境配置，不写入本文件、账本或证据。

2026-10-19 补充：用户询问无头回归含义，已解释后台浏览器自动操作；目前没有可确认的既有脚本入口。找到 `/Users/guangjieyu/Documents/OpenMAIC`，先只读核实单场景生成，不读取其 `.env*` 或模型密钥。

| Q-028 | OpenScience 2.0.150固定仅loopback绑定且拒绝Fly域名Host，与§7私网直连不符 | 自有IPv6代理在4096接Fly私网，转127.0.0.1:4096固定loopback Host，每请求验证账户Bearer且拒Origin；保持上游防护。Fly无公网services；不改上游 | 推荐执行；P1-08 |
| Q-029 | P1-08要求注册创建、快照与滚动升级，但Auth/Vault/Storage/Hatchet项目尚无 | 本批提供可信provisioner入口、加密与故障恢复、运维CLI和真实容器验证；注册事件/夜间快照调度在后续长流程接入。没有Vault时失败关闭，云SLA/真实Vault必须待环境补验，不用明文替代 | 外部条件缺失；明确未完成云验收 |

| Q-030 | Docker Desktop 4.18.0构建/拉取/新建容器请求返回内部backend.sock设置服务超时，既有PG仍可用 | 不重启共享Docker以免中断其他项目；保留Engine错误与真实原生运行时探针，改用独立GitHub runner构建验证镜像/root新卷/OCR工具；云三分钟SLA仍待真实Fly。没有实际CI结果前不标通过 | 本机环境阻塞；独立Linux CI已通过7项真实容器检查 |
| Q-031 | 快照需要Storage专用身份而现有变量只有通用service_role | 增加STORAGE_SERVICE_TOKEN，限定JWT角色reinlab_snapshot_writer；Supabase存在时迁移创建私有桶与限桶RLS，拒通用管理员key。JWT由Storage验签，不能把本地协议fixture当云授权证明 | 推荐执行；P1-08，云权限待验 |

| Q-032 | 2.0.150公开runtime.prompt硬编码research且严格拒绝agent；规格default_agent回退也无效 | 保留runtime收据，采用/data/roles/<dossierId>/<roleId>非git project覆写research；最终*deny、路径规则、taskdeny。角色prompt与权限必须经实际模型HTTP和工具攻击测试，不用旧session.prompt替代runtime；不改上游 | 用户/Claude中期审查已批准附条件；P1-10首PR仅角色边界，待审查方确认后续 |
| Q-033 | 说明文件会按类型向上聚合并加入全局/显式instructions，不能仅凭文件名推断隔离 | 采用角色过滤后的project AGENTS.md；全局仅公共安全规则，控制project/Git根和额外instructions，后续实际注入与工具越权实测 | SPIKE-2源码结论；执行隔离待后续 |

| Q-034 | OpenMAIC已有单场景scene-content接口，但其content是html/widgetType，无课程content.type；部署还校验Origin | 采用直连OpenMaicAnimProvider，单outline+allOutlines=[outline]+临时stageId，取content.html；保留Origin/认证校验，正式适配再做引用/HTML/费用门禁。真实simulation已生成，服务内部用量/费用未返则null | SPIKE-3真实验证通过；后续适配待实现 |
| Q-035 | 规格未给动画CDN白名单细目 | 本次样本只含jsDelivr固定KaTeX0.16.9脚本URL，人工逐个核对；生产白名单应固定所需域名/路径/版本并验证重定向与资源，不能放开任意外部脚本。截图不替代安全测试 | 推荐执行；生产HTML验证待P2后续 |

2026-10-19 中期审查后补充（按用户指示推荐继续，未新增外部付费/凭据操作）：

| 编号 | 问题 | 推荐与理由 | 状态 |
|---|---|---|---|
| Q-036 | 原生write/edit/patch/apply_patch/multiedit统一用edit权限，单放write会连带暴露编辑别名 | edit按相对角色project的write_targets收紧；可信全局插件逐tool_grants再检查实际工具名。首PR只支持受控单文件write/edit，其余多文件patch失败关闭，后续正式工具再扩展 | 已实现；原生先read再强制未授权edit负例通过 |
| Q-037 | runtime.parts.subtask是显式用户委派路径，会绕过agent的task权限检查 | 首PR桥接只接受sessionID/requestID/message，拒绝parts、agent、model、directory等额外输入；内部delegation=true下仍须验证taskdeny | 已实现并测试；丰富输入后续另审 |
| Q-038 | 自动说明文件读取与配置引用展开不经过工具read权限，且可能运行中被换链 | 管理role目录只允许三个受控普通单链接文件；配置全文拒绝{file:/{env:，创建/提交/每次模型与工具前校验。AGENTS按角色过滤后由调用方写入，本PR不代替完整记忆服务 | 配置注入和运行中跨role泄漏红灯已保留并修复；宿主恶意同UID任意竞态不冒充OS隔离 |
| Q-039 | approve模式将external_directory视作risky，配置allow仍会等待filesystem授权 | 控制面只给新会话当前dossier只读及实际编辑所需write_targets精确写路径，scope固定session；保留路径read/edit规则，不切full/不关闭sandbox/不自动回答pending | 原生正向读写及注入宽grant后越权拒绝均通过 |
| Q-040 | sandbox开启时上游跳过project-controlled插件，最初fixture漏掉部署的全局注册 | 复现现有account-entrypoint的可信全局插件注册；roleproject不注册插件，桥接创建/提交前核验全局精确URL，缺失失败关闭。用hardlink、read后edit别名及实际hook日志验证，不凭配置判断生效 | 初始假证明已纠正，红灯/失败观察保留；sandbox保持开启 |
| Q-041 | SDK默认禁用请求timeout，内核不响应会一直等待 | 每SDK请求默认10秒deadline，可安全配置100–30000ms；稳定OS_UNAVAILABLE，prompt结果未知时查原编号收据，绝不自动重新提交 | 真实HTTP stall、0自动重试及原requestID通过 |
| Q-042 | canonical路径不能识别硬链接数据别名，FIFO等特殊文件可挂住检查 | 数据读写及管理文件拒绝多硬链接；元数据打开O_NONBLOCK，拒绝FIFO/socket/device。只证明当前文件链接/类型边界，不声称审计已复制内容的历史来源 | 独立原生hardlink与特殊文件回归通过 |

2026-10-20 第三批：Q-005 已关闭。用户提供主仓库 e2e/legacy 的17场景，19文件原样入库，mock全17/17通过，证据evidence/T-REG；后续送审必附新报告。三份第三批/延期权威说明已原样收录design/，新本地与模型决定按下一任务执行。

| Q-043 | 原样T-REG runner的三处变量动态导入被全仓lint拒绝，不能为变绿修改用户场景 | 仅对已审查runner的精确SHA-256允许变量导入，仍检查字面量SDK导入；任何字节变化和其他源码继续严格拒绝。用真实runner+变更runner+生产动态加载负例验证，不全局跳过e2e/测试目录 | 推荐执行；T-REG lint补验通过 |

2026-10-20 用户决定生效：Q-021、Q-025关闭，三档路由均deepseek/deepseek-v4-flash、汇率7.2；每轮输入10000/输出3000 token与2倍余量。Q-006/Q-012/Q-029及P1-08三分钟SLA状态统一「云端补验」，本批改验完整本地CLI栈与Docker驱动。多模态项「待多模态模型」，GPU仅提议、不执行。

| Q-044 | 共享DockerDesktop容器列表超时，且SupabaseCLI2.121.0实测拒绝原配置db.major_version=16 | 使用独立Colima reinlab、显式Unix socket且不激活默认context；本地完整CLI改PG17，保留现PG16和CI回归，迁移须两边真实验证。CLI状态/启动输出只在内存解析，凭据写保护文件 | 推荐执行；PG17全套真实验收进行中 |
| Q-045 | DeepSeek官方现说明旧deepseek-v4-flash已转由V4.1-Flash提供服务，且CNY与USD原生价目并非严格按7.2换算相等 | 保留用户指定路由名，费用记录请求/实际模型、原生计费币种、当次7.2汇率及价目来源；按账户真实计费币种核对，避免把CNY价误当USD再换算；缺失用量/价格保持null | 推荐；真实冒烟前核实账单币种与价目 |
| Q-046 | CLI提供的postgres连接执行既有ALTER ROLE NOBYPASSRLS迁移真实返回42501；PG17本地角色并非超级用户 | 初始化仅在CLI的loopback端口使用supabase_admin（已实测为superuser）；旧迁移保持摘要不变，运行时仅给reinlab_app/reinlab_provisioner各自凭据并检查无超级用户/绕过RLS/角色成员/表所有权。管理凭据只在本地setup文件，不进HTTP进程 | 推荐执行；本地首次迁移已通过 |
| Q-047 | CLI2.121.0真实Auth签发ES256，而现有可选JWT_SECRET使控制面限定HS256，真实登录返回401 | 本地运行时不下发JWT_SECRET，沿既有JWKS验签路径验证ES256及issuer/audience/role/时限；初始化仅用CLI旧JWT密钥签发专用Storage JWT，不把管理员签名密钥留在HTTP进程 | 推荐执行；真实红灯见P1-08-local/integration-attempt-1 |
| Q-048 | 独立Colima重启后首次CLI start泛型失败而稍后成功；同tag反复build又实测导致旧containerd镜像metadata消失 | 不猜首次失败根因；仅CLI基础设施start对两类启动失败最多3次有界恢复，业务/模型不在重试闭包。镜像按全部COPY内容生成tag并固定不可变ID，存在pin或旧容器时不重build/替换基线。数据盘扩20GiB仅涉及本任务profile，保卷；本地真实9/9及重复启动通过 | 推荐执行；云仍补验 |
