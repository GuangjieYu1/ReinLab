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
| Q-049 | 容器/data不在控制面宿主FS，且同一逻辑角色的记忆/提示词更新不能覆盖旧收据绑定的AGENTS | 单一受管角色规划源复制到账户镜像，现有认证代理只提供固定根/插件的窄准备操作；控制面核对预期路径与三文件摘要后才取得远端能力。角色physicalId用logicalId前28字+--+规范输入SHA256前32字，完整摘要也存DB；旧内容目录不覆盖。保持/data/roles在档案外、非git、默认deny及taskdeny。Node22锁定镜像通过原生类型擦除执行该TS模块，zod作为账户明确生产依赖 | 推荐执行；原生与远端合同测试后才标通过 |
| Q-050 | 原生fixture实测一次最小角色请求另触发title模型调用，不能仅按主研究请求数证明无重复或核对费用 | 全局明确禁用辅助title agent，控制面创建时提供研究运行标题；保留真实研究模型调用。全局默认/小模型与enabled provider也锁到安全配置路由（本阶段DeepSeek），不隐式调用其他提供方。原生fixture复用同一账户配置函数，核对所有provider请求数，避免只在测试里关闭标题掩盖live费用 | 推荐执行；fixture-request-inspection保留原先2请求的观察 |

## Q-051 P1-10提交与观察的启动边界
- 背景：Hatchet明确延后P1-13，P1-10需要真实提交/持久观察，不能靠观察器重发模型。
- 推荐并采用：新增独立可信RunBridge，由用户明确创建后的控制面提交入口调用；run独占session，先保存身份与send intent，HTTP不确定结果只能读snapshot取原收据。观察器仅持read-only端口；重启只恢复已绑定active观察，绝不提交queued任务。P1-13再把admission接入Hatchet，不改幂等语义。
- 状态：实现中，不代表已验证。

## Q-052 问题卡答案的请求字段
- 背景：§6只列decision/scope，但SDK question决定必须有answers二维数组。
- 推荐并采用：仅question approve允许bounded answers:string[][]，permission拒绝该字段；question reject不带answers。scope只once/session，权限绝不project/always。先确认真实snapshot pending，再保存决定意图；结果未知不自动重发。
- 状态：实现中。

## Q-053 实际费用与原生币种/价格窗口
- 背景：只读DeepSeek后台确认账户以CNY计价；官方原生CNY价与USD价×7.2不是完全一致。官方还存在peak/offpeak，不能凭models.dev静态USD价格冒充本次账单。
- 推荐并采用：实际step费用用官方原生币种价目、明确价格窗口；固定FX7.2每次记录，CNY标conversionApplied=false，USD才换算。价格有效区间/币种未配置或实际用量/来源无效记null并暂停，不猜免费。定价与后台对账是两件事，未核对前providerInvoiceReconciled=false。
- 当前窗口不从节假日日历猜测；冒烟前以只读后台及官方规则确认的短区间固定下来，绑定时持久化。跨区间用量标未知等待核对。长期窗口同步由后续对账任务完善。

## Q-054 P1-10最小真实冒烟的执行上限
- 背景：研究种子角色默认48步，P1-11工具预算钩子尚未实现；本批只允许一次真实模型回合且≤¥1。
- 推荐并采用：运行输入可提出更紧的limits.maxSteps（1～种子steps），只能收紧不扩权；冒烟取1步，仍使用真实研究角色提示词/模型/账户容器与原生用量。禁用辅助title agent，模型默认与small_model统一DeepSeek且仅此provider启用。真实执行前按实际上下文与模型输出上限核对≤¥1；无法保证则不提交并保留待验。
- 不改变role_def授权、requestID、生产模型、不引入桩。P1-11再接完整逐工具预授权。

## Q-055 第三批补充Harness清单的初始来源
- 主仓库ADDENDUM/HARNESS均已读取，实际benches/research.bench.yaml和prompts/目录尚不存在；HARNESS中的YAML是节选示例，不能当完整已审查角色表。
- 推荐并采用：从已审查role_def迁移10个角色及提示词到研究台清单/提示词资源，保持现有ID与权限上限；入口角色映射、模型位置、write_targets、阶段和默认预算均显式声明。工具risk由独立通用注册契约提供，未实现的P1-11能力标planned，不能假称可执行。现role_def保留历史FK/兼容，不再作为研究台运行授权来源。
- T-HAR-1/2/5/10本批完成；版本升级收件箱、完整门禁钩子、卡片生成/回放等按HARNESS落地顺序留后段，不假称完成T-HAR-4/6/8/9。

## Q-056 网关与旧SPIKE-3接入方式变更
- 用户补充决定：模型key以后仅在LiteLLM网关，运行使用临时预算key；本批只预留费用来源gateway_callback接口，不部署/伪装网关。本轮真实冒烟仍遵循已授权受保护DeepSeek配置与≤¥1限制，并标清direct_provider_usage。
- SPIKE-3原结论保留为当时源码/接口事实；未来P2-07**接入方式将变更**：课堂引擎内使用@openmaic/generation，AICallFn连网关，不再以站点scene-content作为正式接入。当前不实现课堂引擎、不改现有前端跳转。

## Q-057 Harness权限放宽审批的持久化
- 原approval表run_id必填且kind没有harness，档案偏好调整可能尚无run。
- 推荐并采用：本批新增租户隔离harness_proposal存放精确patch/原有效摘要/用户决定收据；账户/档案身份+CAS有效摘要核对后才应用。未经批准，含放宽的patch不改变有效配置，只生成审批卡；批准后写harness.loosen账本。纯函数或调用者布尔approved不能构成授权。

## Q-058 前端基线更新与第18个场景
- 用户明确批准仅src/、e2e/legacy/、package.json的scripts段同步主仓库现成基线，逐文件哈希；旧17任一失败停止，不改场景。
- 实际新增5个看板文件、更新AutomationStudio；scripts源5key本已与分支相同，保留分支后端脚本和所有依赖。18/18已通过，源/目标逐字节一致，主仓库哈希未变。证据evidence/T-REG/baseline-refresh，初始缺看板失败保留evidence/T-REG/live。

## Q-059 P1-10账户内恢复范围
- Hatchet全局持久调度到P1-13才实现。应用DB角色不具跨租户扫描权限，不能为了自动恢复放宽RLS。
- 本批选择：已认证账户请求/SSE或明确用户重放时恢复该账户已accepted会话的观察；发送结果未知仅查询原snapshot/收据。无人访问时的全局主动恢复仍待P1-13，不作已完成声明。观察器最多3次连接，外层不无限重启它。

## Q-060 Harness记忆注入最小规则
- 当前角色scope有layers/current/own/explicit，完整检索和引文授权由P1-15实现。
- 推荐并采用：新run无本人旧thread，L1不读；自动注入仅role允许的L2当前档案且无thread、L3/L4账户全局且无dossier/thread，排除revoked/被supersedes。若显式memoryRefs UUID[]（含空数组）则仅取该集合与上述范围交集，绝不扩权。assigned-citations无已核验分配引用时本批memory为空并保留待办，不猜path或任意ID授权。

## Q-061 无效问题答复的纠正
- 决定意图一旦发送必须不可变，不因400就解开sent围栏。
- 本批API在保存新意图之前先只读fresh snapshot验证答案；无效答案400不保存intent，可更正后提交。真正dispatch之前再次fresh核验；结果未知不自动重发。历史replied不等于ReinLab用户批准，无控制面intent时原pending只会expired。

## Q-062 / B-1 DeepSeek 旧目录别名不可用
- 原生2.0.150在连接后过滤 catalog 的 deprecated 模型；官方价格页确认旧 deepseek-v4-flash 与当前 deepseek-flash 均服务于 DeepSeek-V4.1-Flash-1017。保持三档产品路由 deepseek/deepseek-v4-flash，通过 SDK 模型配置 id=deepseek-flash 映射 API 名；不改上游，也不把旧目录行伪标 active/beta。内核实际发送 API 名与产品路由分别留证。
- 临时冒烟配置完成后，先读真实 provider 列表核对 alias、API id、可用状态、1024输出上限/非思考，再核对受信 raw config 的本地临时端点；未生效即清理临时 auth/config，禁止开始 prompt。guard 两个等价 API 名共用一个不可回退 marker，不能增加请求次数。
- 已保留的前置失败只接受了本地内核请求，真实提供方转发0、usage空；不修改该失败运行，不重发其 requestID。之后唯一真实冒烟必须按用户最新要求，先确认新计划再执行。

## Q-063 / B-2、B-3 清单可调字段与目录声明
- resolver现逐字段执行tunable白名单，未列入字段（即使为空或同值）400拒绝；研究台原tunable不扩容。可调整目录/记忆/附加说明的通用能力仅在专门声明这些字段的清单中可用，审批不能跳过白名单。
- B-3处理选择：layout表示初始目录骨架，不是写权限白名单；write_targets可声明本档案内的其他纯相对子目录，仍须工具授权与路径校验，实际写入时才按授权建立。当前read/layers/、findings/、experiments/属于这种目录。初始化骨架物化与相应业务工具未在本批实现，不把允许路径称为磁盘目录已存在；后段必须按目录合同物化。维持已发布1.0.0内容及摘要不可变，不为文档观察静默改清单。

## Q-064 本地全量测试资源上限
- 中期修复后默认全量使用宿主10核推导出的9个文件worker，同时运行真实PG和多个原生内核，三个旧预算用例触及原5秒测试上限；相同文件单跑28/28，相关用例约0.5秒。尚不声称某一条数据库锁是唯一原因，红报告保留。
- 为稳定资源占用，独立vitest.config.ts只将文件worker上限设为4，低核机器不超过默认CPU-1；复用原Vite配置。不加重试，不加大5秒超时，不跳过测试、不改业务/RLS/预算断言。最终需两版本全量及CI证明。

## Q-065 唯一真实冒烟返回思考模式400（未关闭）
- 用户明确确认后在2026-10-22 02:31北京时间空闲窗口执行唯一真实转发。DeepSeek返回400：思考模式要求回传reasoning_content，无usage；账本保留unknown/unpriced，未把spent=0当免费，marker保留且不再发送。
- 官方文档称思考默认打开，须显式thinking.type=disabled关闭。只读上游transform仅对API id匹配deepseek-v[4-9]注入disabled；B-1改成deepseek-flash可能绕过此分支。当前只有源码推断与真实400，尚无原始wire请求存档，不把推断写成已证根因。
- 推荐后续先用原生fixture截获实际wire字段，再通过SDK模型options显式关闭思考并核验，保持产品路由/上游源码不变。guard目前允许省略thinking，不能把能力reasoning:false当成线上关闭证明；应一起收紧其验证。此涉及安全守卫改动，应按用户约定独立安全评审。**本轮只取证送审，不改行为，不再真实重跑。** P1-10暂不关闭，需审查方确定修复范围；第二次真实验证必须取得新的明确授权，不能绕marker。
- 后台已在延迟5分钟后导出，只有小时聚合、缺request_id且存在其他调用；未能单独归因本次费用，对账仍false。原始导出留仓库外0600，入库无其他调用金额/token/key标识。

## Q-066 B-6/B-7/B-8与第二次授权（用户/审查已确定范围）
- 追加审查确认Q-065根因：API别名绕过上游thinking自动注入。按B-6在SDK模型options显式disabled并核raw config；B-7守卫必须收到disabled，缺失也拒绝；B-8 fixture按本次非思考合同拒绝缺失/非disabled，原生截获实际出站体核对。未改上游。
- 独立安全子agent仅评审B-7及相关配置/第二次固定目录边界，35/35，无P1/P2；其余改动作者自行复核。普通回归不读真实key/不发真实请求。
- 用户已更换ReinLab专用key，位置/变量不变。该说明只确认凭据就绪，不构成第二次真实发送授权；本轮停在SECOND_SMOKE_PLAN.md计划后。未来按该key单独核账，第一次unknown/unpriced及已消费marker不回退。
- 第二次固定目录p110-second-authorization与新幂等键/内核requestID隔离；默认入口仍使用原p110-one-shot，禁止任意第三次selector。新目录/marker/admission只在未来明确授权执行时创建，证据须写明第二次授权。

## Q-067 第二次真实冒烟与工具读取敏感弹窗事件
- 用户已明确第二次授权；本次新requestID、单次转发1，真实回复“链路已通”，run completed，usage已知、账本¥0.002766、hold settled；第一次失败unknown/unpriced不变。后台按ReinLab专用key的零基线单独核对，实际对账结果见real-smoke-second-authorization/。
- 本次进入Safari时，用户前台仍在新key创建弹窗，初始AX工具响应自动包含明文。未复制到Git、业务日志、账本或证据；这里不复述任何key或片段。对话工具输出发生敏感信息暴露，不能声称本轮全程无凭据暴露。已告知用户，建议核账后由用户轮换；Codex不擅自创建/删除/更换凭据。
- 后续操作在返回AX文本前静默读取并遮盖key形态，避免再次输出。该事件及用户轮换处理须在关闭审查时如实说明，不能因模型成功而隐去。
- 后台延迟后按ReinLab专用key导出：零基线→1请求、输入2754/输出3、费用¥0.002766；与账本误差0%，本次核账通过。业务原始元数据未回写历史标志，独立对账报告为最终核验依据。原始截图/ZIP留本机0600，值不入仓库。P1-10送Claude审查，凭据事件仍待用户轮换处理，不自行判验收通过。

## Q-068 第四批规格优先级与令牌传递
- 用户第四批明确key/能力令牌不进任何环境变量，优先于MCP_LAYER.md第8节的旧环境注入描述。本批新增令牌使用进程内存与角色project/档案/备份范围外的临时0600配置（父目录0700），结束清理；不修改上游。
- 真实模型调用仍等待用户轮换已泄露key及新明确授权；旧两次授权均已消费。本批不会操作浏览器或调用真实模型，T-MCP-10保持待授权。
- 发现既有OpenScience2.0.150部署鉴权只读OPENSCIENCE_AUTH_TOKEN（server/server.ts:227、host-guard.ts:82）；原账户容器沿用ENV，未找到文件/FD接口。保持现有鉴权，不为了避开ENV而取消该层。用户已明确接受推荐：旧部署鉴权令牌迁移单列待处理，本批新增key/MCP令牌不进入环境变量，T-MCP-9不宣称消除此既有缺口。

## Q-069 能力目录与已发布清单摘要兼容
- 不改research@1.0.0字节/角色名/版本，也不改旧bench_version.registry行。tools/registry.json新增capabilityRevision/capabilities/aliases，严格整体解析后，harness仍仅接收原v1核心投影；旧registryHash保持35f5aaf3682f03ab094c30074beacef5a76071b08ed0bab49188800d39fa906e。
- 新能力目录单独digest/revision，以append-only能力版本和每run快照固定；令牌必须绑定该快照，旧run缺快照不得自动采用current。新字段不是未哈希授权输入，权限仍与冻结清单求交。
- 原清单mcp/cards均为空。按清单schema发卡必须有定义，当前research1.0.0发卡会明确UNDECLARED_CARD；T-MCP-6使用显式声明schema的独立测试bench。真实T-MCP-10除key轮换授权外，需要审查决定如何发布含finding schema的新版本，不能用fixture或静默补schema代替。此为后续真实验证前待决定项，不阻碍通用服务器与fixture开发。

## Q-070 别名的副作用与多文件原子性
- literature虽是旧read工具，papers.fetch由控制面落论文，至少ask；不能从literature allow推出任意写。finding/layer/quiz附带的files.write只授权各自固定子目录与role.write_targets交集；冲突取更严格权限，不派发通用写权限。
- memory.propose仅创建L3/L4升级收件箱，不是memory.write，原write=[]不变；实际内容永不因此改变。assigned-citations在无已核引用分配时仍返回空，L1继续Q-060。
- files计划使用档案目录的原子交换提交与目录级串行化；Linux renameat2(RENAME_EXCHANGE)、macOS renamex_np(RENAME_SWAP)无支持时明确拒绝，不降级为顺序rename假原子。预提交故障无副作用，提交点后整个新目录可见；旧目录成为受保护版本，最近50份。已通过真实文件、提交前故障注入和独立路径评审；Linux 镜像复核另附容器报告。

## Q-071 MCP 参数默认值与版本产物范围
- memory.read 不传 layers / refs 时只采用已绑定 run 的范围；显式 refs=[] 仍返回空。files.list 不传 path 时列本档案根，不接受绝对路径或 ..；这些可选默认值写入能力 input schema，并不从调用方推导更宽授权。JSON schema 的 UUID 格式使用明确本地校验，不关闭格式校验。
- 卡片 schema 原文随非空 cards 的新 bundle 冻结，发布时逐字节核对 referencedHashes；research@1.0.0 cards={} 的 bundle 字节和摘要不变。
- files 版本放在角色与档案目录之外的 /data/mcp-state/<dossier>/，备份包含 dossiers 和 mcp-state，明确排除 /data/mcp-clients 的临时能力配置。调用的批准提交为授权生效点，已登记副作用结果未知时只保留围栏，不自动重做。
- 原生 write/edit/patch/apply_patch/multiedit 本批全部拒绝。前批测试中原生写入的正向期待按这一更严格合同更新，实际读与越权负面检查保留；正向写入由 files 的真实文件和原子性测试承担。
- 运行级 MCP 吊销永久阻止本 run 后续签发；终态通过每次在线核验立即失效。磁盘临时配置按过期清理；原生内核集成测试另已验证运行终态主动删除（含 ended_at 非空而 state 为 paused_budget 的费用未知运行），与令牌在线失效分别核对。

## Q-072 本批收口边界与运行时依赖
- 尚待决定：research@1.0.0 的 cards={}。建议由审查方批准后发布含 finding 等 schema 的下一版本；本批不静默修改已冻结清单。通用卡片能力使用独立 fixture bench 验证，真实卡片调用仍明确拒绝未声明 schema。
- papers 本批严格 fixture 验证；生产网络实现只允许白名单 HTTPS，并将公开 IPv4 DNS 固定到真实连接、逐跳重新验证。纯 IPv6 来源当前明确不可用；真实提供方可用性、OpenAlex 实际接入要求等留待后续明确授权，不冒充已验。
- 第一批单文件写入≤1MiB、补丁≤4MiB/32文件、档案 staging 总量≤64MiB/4096项；固定 papers PDF 导入≤8MiB，经控制面落至 papers/<assetId>.pdf 与元数据 JSON。PDF 文本层要求宿主安装 Poppler；CI显式安装 poppler-utils，账户镜像已有。过限明确拒绝，不截断全文或假称成功。
- 新 MCP 账本与观察器复用账户 budget/ledger 首锁，避免 run/FK 与 ledger 锁反序；用户决定/吊销在同一个 HTTP 幂等事务与连接内完成，单连接池也必须可用。真实 npm 内核 + fixture provider 验证发现的死锁与 Zod4 接口不兼容已修复，保留红绿报告。
- ended_at 非空时即清理 MCP 配置，包括费用未知而保留 paused_budget 的已结束运行；不把未知费用改成零。测试证明批准前无文件、once 批准后才写入、终态删除私有配置，全部为本地 fixture，非真实模型。
- T-MCP-9 按实际值扫描另列：用户已接受的旧部署鉴权 ENV 接口迁移仍待处理；历史凭据泄露日志不因本批新增能力通过而消失。既有 local 控制面 runtime.env 的旧 key/token 环境传递也如实列为遗留项，不扩大已同意例外或宣称本批消除了全部旧凭据问题。真实模型仍等待轮换与新授权。

## Q-073 第四批实际值扫描与凭据遗留
- 当前实际值扫描：工作树、Git refs/reflog 可达全部对象、证据、本任务临时日志0命中；本机 Codex sessions 1个文件、shell_snapshots 3个文件命中当前 DeepSeek key。报告只含计数；MCP 私钥与选定实际签发/核验/吊销的 fixture token 在上述范围均0。
- T-MCP-9标部分通过。扫描覆盖列明目录与选定值，不包含历史截图OCR、全部历史令牌或整机。未读浏览器，不删除历史命中；继续等待用户确认轮换、清除旧 shell 自动加载及新真实调用授权。旧部署/控制面ENV迁移按Q-068/Q-072保留，不能声称已消除。
- 任务分支本地GPG签名因无交互pinentry失败，后续本批提交仅单次git参数关闭签名，没有修改用户全局配置。SSH认证不可用，使用已有系统HTTPS凭据助手推送，未读取、打印或导出凭据。

## Q-074 第五批凭据文件化与固定内核入口
- 用户已确认删除 .zshrc 自动导出并轮换 ReinLab 专用 DeepSeek key；本批不沿用旧两次授权，不执行 T-MCP-10，等待另行明确授权（≤¥1）。历史扫描报告保持原样，新的值扫描另记，不抹掉旧泄露事实。
- 本地 runtime.env 保留为项目外0600文件（父目录0700），名称兼容旧配置，不再 Object.assign 到 process.env。控制面、provisioner、lifecycle 与本地验证脚本在进程内读取；进程间只传配置文件路径。既有环境中的秘密字段不能作为隐式凭据回退，单元测试中的公开部署参数可保持环境配置。
- 锁定 OpenScience 2.0.150 的 CLI 无 token-file 接口。推荐验证自有网络 listener 认证部署适配：原内核源字节、Host/Origin、SDK及插件 internalFetch 不变；网络 listener 自第一请求起读取私有文件做等价恒时 Bearer 校验，不通过伪内部头放行，不运行裸监听后再补guard，不把文件值塞回虚拟或真实ENV。安全SPIKE和真实固定内核fixture证明完成前不标此部分已迁移。SDK仍是业务调用入口；若安全前提不能成立，明确保留阻塞，不能靠删鉴权交付。
- Docker/Fly按账户传递受保护文件。Fly files.raw_value只是Base64，不当成加密；app全局secrets默认ENV分发不作为无ENV方案。配置、日志、inspect和角色project的实际值检查与旧机器安全升级均需单独验证；云端实机仍为“云端补验”。

### Q-075 — 固定内核的文件鉴权部署适配与私有挂载

第五批已确认锁定npm standalone不执行preload且仅支持ENV鉴权；采用固定v2.0.150源码commit e700f00c0e4a45f7cd56d94d626d0e11b45b38c1的归档与SHA256、原Bun1.3.14/官方headless/encrypt插件和全部define重新构建，业务仍走原SDK；自有入口在首次网络bind前安装文件Bearer检查，保留原bootstrap、Host/Origin及插件可信internalFetch。上游checkout不修改。构建清单如实标注“原源码+ReinLab部署适配”，不冒称原npm standalone。LICENSE/NOTICE随镜像分发。

Docker凭据逐账户保存在项目外0700目录/0600文件，仅精确只读挂载一个文件；/data与角色project、备份都不含部署凭据。专用Colima只读挂载新增的account-credentials目录，未挂载整个用户配置目录。实测该macOS/Colima 9p文件uid映射为guest root，故darwin计划明确要求source uid=0；Linux原生bind要求宿主uid。部署不符合此权限契约时失败关闭，不自动放宽。其他macOS共享驱动映射需补实测后单独配置，不能猜为已兼容。

旧机器必须经可信运维migrate-credentials命令、精确身份/原Vault令牌核对、活跃运行wait/interrupt与durable操作围栏后迁移。普通ensure、resolver拒绝旧ENV形态。Fly files仅在控制面内存交付raw_value，其实际落盘权限和云端生命周期统一记“云端补验”。

### Q-076 — research@1.1.0 卡片的保守存储与引用约束

只更新清单version/cards，1.0.0原字节归档并可重载；既有档案回填旧版本，新档案默认1.1.0，未实现升级收件箱时禁止静默改版本。schema的anchor.paperId使用papers.fetch返回的本地asset UUID，页码1..1000，quote1..300 Unicode字符且规范化后非空；文本与数组设有界上限以避免无限输入。anim仅字符串声明，前端只识别既有动画ID，不执行任意HTML。当前卡片引用必须来自同一run成功papers.pages输出的不可变页回执，并核对规范化原文包含quote；跨run/跨角色引用不默认放行，后续群研的assigned-citations链路需单独定义。quiz keys只写角色获准的read/quizzes/档案JSON，事件与返回仅含题面和cardId；服务器未配置档案存储时拒绝，而非回退到事件。finding n/at由服务端生成。已有L3/L4和其他权限字段不变。

### Q-077 — 本地完整栈资源不足与未知迁移的恢复

真实核验：专用Colima配置为2CPU/2GiB；完整Supabase和4个账户机器启动后，guest available约4MiB、无swap、loadavg33，Docker list耗时7~11秒且多次超过现有15秒deadline。daemon实际支持API1.41（minimum1.40），所以“API版本不兼容”假设已被实测否定，诊断期的协商实现已撤回。推荐并采用仅将本任务专用实例调整到4CPU/6GiB（宿主16GiB、10逻辑核），保留磁盘、卷与挂载；不放宽安全检查或把超时当成功。已进入indeterminate的迁移沿用原持久operation UUID对账，不盲目重建；所有本地迁移仍以真实结果为准。

## Q-078（第五批，按推荐实施）收件箱 live 登录与展示
现有登录为纯演示，尚无 Supabase 会话入口；研究台无上线收件箱容器。推荐在 live 下复用原两字段登录（邮箱/密码）和 AgentDock 的卡片/按钮，仅切换真实数据与必要文案；mock 分支保持现状。控制面进程内读取配置并代理固定 Supabase Auth，会话只存在浏览器内存，不写localStorage/构建变量/URL。登录或回前台读取待处理，按工作台分组。理由：满足P1-12真实JWT链路而不将服务密钥下放、不假造未实现的其他研究功能。

## Q-079（第五批，按推荐实施）旧提议缺依据及门禁请求过时
P1-11允许空依据的 memory.propose 成为pending；不将其默认为可上线。approve/keep_local 必须通过严格 PromotionItem，旧不合格项可编辑补全或驳回。门禁卡冻结 state/revision/reviewArtifact；旧无快照的卡只能驳回，需重新发起后才能批准。理由：保留已有接口兼容，同时不放宽引用或批准校验。

## Q-080（第五批，按真实协议修正）Supabase refresh token 是不透明字符串
本地真实 Auth 返回 refresh_token 长度12（未打印/记录值），并不满足开发时错误假设的16位下限，造成代理401。登录JWT仍由现有签名/issuer/audience/role/sub校验；刷新身份由固定Supabase Auth核验。代理仅要求非空可打印ASCII、≤8192，不自行规定上游token熵或格式。保留同源/JSON/固定URL/重定向拒绝/缓存禁止；增加真实形状12位合成契约红绿回归。没有放宽账户JWT或业务授权。

## 第五批状态更新（Q-068/Q-069/Q-072/Q-073）
用户已确认轮换专用key并删除自动export；两次旧授权均已用尽，T-MCP-10未重新授权，本批不执行。控制面runtime.env已改进程内读取；4个既有本地账户旧部署鉴权已迁移文件，旧操作/审计保留。research@1.1.0发布，旧档案1.0.0钉住不变。Fly实际私有文件投递、托管Supabase、staging统一为云端补验。

## Q-081（第五批，覆盖限制如实保留）进程环境的可读范围
核对实际4账户时，每账户可读取2个进程环境，1个进程因Linux权限返回EACCES；未提权或取消隔离。旧verifier的PID正则多重转义存在空循环风险，改String.raw并强制readable>0、输出blocked计数，检查名明确readable_processes_only。凭据不得进ENV的实现约束仍由显式child ENV白名单、网络入口拒秘密ENV、Docker精确ENV规范化与原生fixture验证；实际日志/control ENV另外比较。文件/历史字节扫描仅覆盖当前11个选定值，不宣称所有历史key、全部进程、整机或历史截图OCR都已覆盖。

## Q-082（第五批，补齐原规格）升级依据的eventRef与可回看来源
BACKEND_MEMORY_SESSION §13要求evidence为eventRef并能回到原对话/作答，而旧MCP只约束JSON，非空字符串仍可伪造。推荐规范为`event:<账本seq>`，账户由JWT隐含；approve/edit/keep_local须在RLS下核对同来源档案与from_run的真实不可变事件，未知/跨来源拒绝。只读证据接口返回原已脱敏事件，前端可点开查看及复制引用；旧不合格pending仅可edit修正或reject，不把任意run:/文本当核对通过，也不偷偷生成“依据”。模型产生提议仍不自动生效。理由：满足明确的来源追溯要求，页quote核对及用户决定边界都保留。

## Q-083（第五批，冷启动可复现）Colima私有凭据根必须显式只读共享
复跑local:up发现CLI配置只保存工作树mount，已运行VM中此前手动添加的私有凭据共享不能据此保证下次冷启动仍存在。固定本任务Colima再加仓库外account-credentials根只读mount（无:w），先检查canonical/本人/0700，并将资源配置保持实测的4CPU/6GiB。Docker Desktop显式socket路径不自动改VM。理由：账户只读私有文件bind在冷启动后也能复现，不靠旧VM隐含状态；实际source uid继续严格检查。

## Q-084（第五批，局部网络故障）Docker Hub IPv6连接重置
冷启动最终镜像构建时，宿主Docker认证客户端IPv6连接被重置；IPv4探测正常。仅构建期间使用127.0.0.1 CONNECT代理，目的地白名单auth.docker.io:443/registry-1.docker.io:443，TCP选IPv4，TLS保持端到端，不解码/记录请求；进程结束关闭。未修改项目鉴权、镜像内容或全局网络策略，试验VM hosts已恢复、临时私有Docker认证配置已删除。最终镜像真实构建、4账户稳定操作ID升级并健康；不是云端验收。

## Q-085（第六批，Claude收件箱接口边界）问答与来源跳转
InboxAdapter只有approve/reject，无原生question的answers；因此live适配器不捏造答案，question仅可reject，approve失败并保留原项。已有API问答能力不删。EvidenceView映射真实同来源eventRef原文；目前Claude组件对href点击preventDefault且未给真实对话路由，因此不设置虚假href（尤其不使用#），原文查看仍可用。后续问答输入和对话跳转由Claude决定前端接口，本批不改组件交互。旧非结构化promotion.items无法符合组件类型时明确失败，不制造依据或隐式批准。

## Q-086（第六批，推荐方案待安全评审）全局恢复的最小发现权限
无人访问时不能靠普通JWT账户入口触发恢复。建议独立Hatchet worker用专属发现连接，只授予account.id列SELECT及该角色专属RLS SELECT策略；无账户姓名/凭据/业务表权限，无BYPASSRLS，不给reinlab_app角色继承。发现ID之后恢复仍通过原reinlab_app与SET LOCAL app.account_id执行逐账户读取和账本写入；每个account.reconcile只使用只读runtime observation，不提交prompt或重发审批/工具。全局定时由Hatchet持久cron驱动，worker断线重连后按DB游标重入。理由：需要全局发现但不扩大普通应用账户查询范围；不把管理员连接放进worker。
