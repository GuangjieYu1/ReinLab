# P1-10 其余翻译层 ToSpec / ToTDD

范围以CODEX_SPEC §8及BATCH3为准；本文件是实现计划，不是完成声明。P1-11工具/完整记忆服务与Hatchet不在本任务展开。三档DeepSeek、FX7.2、云端补验遵循DEFERRED。

## ToSpec

1. D-4普通测试默认临时证据；父子race只读本次报告，显式OUT才归档。安全模块纯排版单独提交，前后AST/注释等价。
2. 控制面不能把容器/data路径当宿主目录，也不能把数据库JSON强转为已授权RoleProject。角色内容规划复用同一源文件；账户入口新增经现有Bearer认证、固定根目录/插件的窄角色准备接口，只有三个受管文件。控制端对预期路径和全部摘要核对，提交前重新验证；现有全局插件在模型/工具边界继续核验。无任意路径/命令接口。
3. 每个run独占会话。DB先保存固定sessionID、角色版本、过滤记忆快照、规范提交内容与摘要；session.create/恢复验证目录与插件，恢复授权不能仅往内存Set加ID。requestID严格等于run.request_id。同内容拿原收据、异内容409；结果未知只查原编号，不从观察器提交。控制面重启、在途重放、内核重启三种原生测试必须核对实际provider请求与副作用次数。
4. 角色目录按不可变内容版本创建，避免更新AGENTS改变旧会话/收据的输入。目录仍在/data/roles/<dossierId>/<physicalRoleId>，logicalRoleId保存在DB。physicalRoleId=逻辑ID前28字符+双横线+完整规范输入SHA256前32字符，满足64字符上限；完整SHA也持久化防冲突。目录在暂存区完整写好后原子发布；已存在只能校验/复用，不能覆盖。见Q-049。
5. 观察器只依赖读取/订阅端口，不拥有prompt方法。先snapshot游标，闭合replay/subscribe空隙；SDK流禁无限内部重试，从DB已提交游标重连。每事件ledger、衍生状态、cursor同事务，<sessionID>:<sequence>去重；未知类型/结构记error/unmapped_event。游标缺口留下真实error并恢复当前状态，不冒充补全历史。
6. 权限/问题卡来自实时snapshot；用户在控制面决定后严格验证所属账户、run、真实pending及答案。只once/session/reject，不支持project/always；意图先持久化，indeterminate保持不确定不自动重发。旧pending消失则expired/run interrupted。取消由控制面调用runtime.cancel。
7. step-finish是逐调用用量源。缺失/非法计数不能当0免费，message.updated重复总量不重复结算；DeepSeek按原生币种/价目与固定FX记账，记录请求及实际模型/价目证据。现有budget hold预留/settle结算复用；未知费用暂停等待核对，会员/GPU保留字段但本阶段不用。
8. 真实冒烟仅收尾一次、最大¥1；真实Auth/API→原生模型→订阅→账本→费用→只读后台账单。key只从用户受保护环境加载，不进入仓库/账本/日志/证据。不满足用量真实性时保持未知、不能推算成已知免费。

## ToTDD

- 纯角色规划/版本与原子准备先写合同测试；原生已有14个工作区及角色边界测试继续绿，RPC认证/预期摘要/同内容复用与异内容拒绝做独立本地协议测试。
- 持久化恢复先做真实PG+原生fixture provider测试，分别中断控制实例、在途阻塞provider、重启内核，核对旧receipt及模型/工具调用计数；异内容409、session绑定越界和未知提交结果均失败关闭。
- 事件映射覆盖锁定内核当前26事件与13Part、未知/坏形状、重复事件/重复usage、游标冲突；订阅故障证明prompt调用0。真实流证明不是只测配置/静态样本。
- 决定只接受真实pending；覆盖普通批准、问题答案、拒绝、过期、indeterminate与重放，不自动批准。
- 最终Node22/24各全量、普通测试归档SHA不变、T-REG17场景、所有CI终态，再执行一次限额真实冒烟并导出账本/截图/费用核对。任一外部条件不足照实列待验，不放宽校验。

## 持久化绑定阶段验证记录（非最终交付）

- BindingStore先以缺模块红灯建合同，随后真实PG3/3绿。中间fixture的UUID/text参数推断与预期错误码（沿用RLS隐藏404）修正后复跑；没有放宽生产校验。
- 独立评审要求父run的logical_role/request同时约束，003已应用故以004新增复合FK及JSON目录/物理角色一致性CHECK，保留原迁移摘要。
- RunBridge三种真实PG+原生fixture provider重启场景3/3；此时仅服务级，不代表生产HTTP接线/真实模型已完成。默认title agent禁用，统计全部provider请求，三种都恰好1；角色内容异请求409。
- RT-1无效问题答案误报503，新增有效红灯后精确映射INVALID_ANSWER400，独立4/4复核关闭。

## 观察与费用的事务合同（待实现）

1. 绑定游标只在ledger event、派生run/approval、usage写入同一事务成功后推进。相同session:sequence保存原始规范内容SHA，异内容冲突；同一step part次级去重，重复上报不重复计费。
2. 每run先预留整笔模型预算，逐step-finish明细入cost ledger；terminal汇总结算同一hold、更新各级spent，但结算只追加gate/null-cost汇总，避免明细与汇总双算。没有usage、游标缺口、异常结束不能宣称免费；未知保留hold并暂停。
3. 观察器仅持RuntimeObservationPort，不持RunBridge.submit或RoleRuntime.prompt；故障最多bounded重连，事务cursor恢复，不调用prompt。snapshot游标缺口写真实error，不冒充恢复遗失事件。
4. 审批请求来自历史event，pending资格每次由fresh snapshot核对；重启消失记expired，用户明确决定后才发送，未知结果不重发。决定send intent单独持久且答案摘要冲突409。
