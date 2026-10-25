# 精读live独立安全与迁移复核（最终定向通过）

工作树：/Users/guangjieyu/.codex/worktrees/research-foundation/ReinLab。范围仅安全边界与迁移，不作UI/一般功能评审。未修改实现或Claude组件，测试仅新增services/control/test/read-security.test.ts。未读取实际凭据/浏览器、未调用真实模型。

## 结论

当前必要安全问题已关闭，定向通过。独立迟到旧run快照改变cancel目标的红灯，经sourceVersion身份/水位围栏修复后转绿。原始tool output字符串可能携quiz keys的问题，主agent已通过read事件服务端白名单关闭，并经历史与read-SSE实际API验证。未扩大测试范围。

## 数据库与迁移

202610250000只追加view_metadata JSONB NOT NULL默认{}，要求object且≤32768 bytes；未改旧迁移或RLS/appendonly。实际合成PG测试验证非object与超限23514、跨账户不可读、应用UPDATE/DELETE均42501、RLS/FORCE及原immutable trigger仍开启。公开元数据仅构造title/50作者姓名/venue/实际PDF bytes长度，分别截长度并scrub；不存整个OpenAlex work、原始URL或私有路径，legacy缺字段明确回退，不以只读GET联网补写。

withAccountSnapshot在首个SELECT前BEGIN REPEATABLE READ READ ONLY，再事务局部set_config账户；原withAccount保持普通BEGIN路径。实际测试显示事务标志readonly/on+repeatable read、并发已提交title变更在同快照第二次查询仍旧值、快照内写入25006且无效果。连接前置重借/业务回调后不重放规则保留。

## 快照、事件和来源

read-state统一同一RR事务核档案归属、research bench、选定read run、assets/receipts/审批/费用和本档案through；跨账户档案及其他run绑定均拒绝。read-events严格安全整数after/through、顺序/未来水位限制、固定through分页。新增read GET及view=read SSE不触自动recover，真实Hono测试fake recover调用数0。

既有appendEvent按account持有事务ledger锁，固定水位不依赖全局seq连续。新页receipt验证output/schema、asset/pages与请求、在线能力token后，在原同账户预算锁事务以同client插receipt和appendEvent，事件故障会沿withAccount rollback；没有额外文件读取、模型或订阅写入口。该原子性为代码复核，本轮没有另做页事件故障注入。相同receipt hash冲突不重复append；现receipt允许同页不同hash，read-state显式PAPER_PAGE_CONFLICT拒绝展示，不选最后版本。页事件只带300字符片段/身份/hash，不整页复制4MiB原文。

publicReadEvent供read-events与view=read SSE共用：card去keys、capability.call只公共summary、runtime只message info和text part，移除tool/reasoning的raw/input/output。独立合成native output JSON字符串答案不出投影，实际API历史与SSE也不包含该标记；quiz projection只构造公开q/layer/hint，不返回档案存储keys。未读取quiz私有档案文件。

projection只选一个primary asset，pN引用必须paperId相同且已有该页receipt；另一论文同p1不会链接/生成finding。独立双资产负面通过。无可核对usage时spent=null，unpriced/unknown标志独立；不把未知强记0。finding n/at取服务器字段，不由客户端重编号。

## 审批、会话和模型准入

read决定端口只允许本wire/当前run、pending、未sent的非question；sent/indeterminate/question均不可重发，UI映射为不可操作说明而不假装批准。后端既有once与native CAS围栏仍在。generation在load/分页/响应和SSE chunk派发前校验，unsubscribe/load切epoch abort并取消reader；同源SSE token只内存header、omit/no-store/redirect:error，旧响应不能切换账户。

estimate不创建模型run，start才confirmed POST；intent在请求前设置，未知结果只读refresh并阻第二POST，不新建requestID重派；既有read-live-adapter合成丢响应测试证明只1次POST。newReading与estimate在queued/running/waiting或unknown时阻新运行；ask仅本地第二期说明，grade抛未接入。

## 本轮独立发现与修复证据

新增第6项实际红灯复现：旧completed run加载延迟，在新run确认并refresh后返回，旧快照覆盖runId，cancel向旧run。修复sourceVersion、expectedRun与单调cursor校验在响应/分页完成前再次核对，成功snapshot或确认new run递增版本；迟到load发现版本变更返回现snapshot。独立同一用例现在cancel只指向刚确认新run；未改测试预期。

## 亲跑范围

所有命令login:false、先unset DEEPSEEK_API_KEY、指定Node22 PATH。最终node_modules/.bin/vitest run：
- services/control/test/read-security.test.ts：独立6项（首次5绿1红，修后6绿）。
- services/control/test/read-state.test.ts：1项。
- services/control/test/read-live-adapter.test.ts：2项。

合计3文件9/9通过，约1.2秒。真实PG仅55432合成账户；Hono请求与SDK端口均fixture，无模型。未跑全量、真实浏览器或E2E，未宣称这些已通过。本报告不构成新模型调用授权。

## 送审前增量复核（通过）

仅检查本轮指定增量，未修改实现/普通测试，旧run快照→错误cancel目标的红绿结论保留。

1. read-state审批展示从同run、受RLS约束的rows中查隐藏base approval；原生绑定只取capability与base approvalId，展示只复制固定effects字符串和summary.files的path/整数bytes，不复制args/native tool input。action/title由能力标签确定，risk保持原值。最终仍经publicReadValue+scrub；原始args中的JSON字符串quiz答案未进入响应。真正批准仍由既有bridgeMcpDecision按account/run/capability/request/argsHash核验，展示摘要不替代授权。
2. 新档案POST未知保留createKey；load在createKey存在时明确失败，不回旧档案snapshot；estimate也拒createKey，成功同收据才清键。不会用旧档案偷偷运行或重新生成创建键。decide新增只有running/waiting且无endedAt的当前run可操作，终态、sent/indeterminate/question围栏继续保留。SSE同源header/401逻辑没有放宽代次校验或向URL持久化token；新增fixture由主agent执行，本agent本轮未重复跑前端大范围。
3. 已亲读并运行read-page-events故障注入：真实合成PG+内存签名key和合成papers.pages handler；相同请求重放及新request同页仅1条receipt/ledger事件；注入appendEvent失败后新页receipt=0、既有页事件仍1，证明同事务rollback。无真实模型或论文网络请求。

本轮亲跑node_modules/.bin/vitest run services/control/test/read-state.test.ts services/control/test/read-page-events.test.ts：2文件2/2通过，约1秒。read-state新断言验证公开files effect可见、原始args答案字符串不可见；page事件重复与回滚断言通过。全部login:false/unset DEEPSEEK_API_KEY/Node22，仅55432合成账户，未读真实凭据/浏览器。

增量未发现必要安全问题；不扩大一般功能评审。本轮未重跑全量/E2E，也不冒称已验证真实模型行为。
