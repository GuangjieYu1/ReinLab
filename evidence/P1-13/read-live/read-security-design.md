# 精读ReadAdapter只读安全设计复核

状态：方案可推进；以下为实现前必须固定的边界，不代表代码已经通过。已读主仓库design/RESEARCH_LIVE_FRONTEND.md、readTypes.ts及工作树Database/ledger/paper_asset/page receipt/card源代码。未改代码、未跑测试、未读凭据/浏览器、未调用模型。

## 1. 快照与历史一致性

推荐新增独立withAccountReadSnapshot入口，保留withAccount原行为。必须在连接上的首个查询前执行BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY，再set_config(app.account_id,...,true)；不能先进入现withAccount、执行set_config后才SET TRANSACTION ISOLATION（Postgres已开始查询，无法安全升级隔离级别）。复用相同UUID/连接错误清理与RLS非特权角色约束，不引入SECURITY DEFINER/管理员连接；业务回调或COMMIT失败不得自动重放。

同一快照事务内核requireDossier，再读取选定run、可见paper/receipts/cards/审批/费用以及本档案MAX(event.seq)为through；不可用sequence last_value、其他账户MAX或分散事务的Promise.all。空档案through=0。HTTP响应no-store。

历史分页固定dossier与through，验证after/through均非负安全整数、after<=through、limit有小上限，SQL为seq>after AND seq<=through ORDER BY seq LIMIT，下一游标是实际最后返回seq。账本seq为全局且可有间隙，不要求tenant事件连续+1。每页返回dossierId/through，adapter核对，不能翻页时重新提高through。SSE从已完成快照的through继续，历史页只补through以内，按原seq去重；不要以历史首个分页游标覆盖实时游标。

现appendEvent已有ledger:account事务锁，使同账户事件分配与提交有序；新页事件必须继续使用appendEvent，禁止裸INSERT event。否则sequence先分配后乱序提交会让固定through/SSE漏较低seq的晚提交事件。保持现有budget→ledger锁顺序；只读快照无需拿写锁。

## 2. 租户、运行与来源绑定

RLS只隔账户，端点还需严格dossier UUID归属和选定run.dossier_id一致。所有cards/receipts/approvals/history按同一选定run或显式历史范围返回，不能将“最近run”的预算/审批拼上另一个run的卡。paper asset允许同档案后续run复用，绑定应依据当前run的paper_page_read与同dossier asset，而非强求asset原创建run等于当前run。

ReadSnapshot只有一个paper，SourceSection.id却是p{page}，多资产的第1页会碰撞。必须明确由服务端选择并返回primary asset；p1等仅用于该asset，其他asset引用不得错误重定向到它。内部保留(assetId,page,text_sha256,runId)来源身份；跨资产不能无提示压成相同pN。无法用现接口无歧义表示的引用应不链接/明确不可表示，不猜来源。

## 3. view_metadata追加迁移

可用JSONB NOT NULL DEFAULT '{}'作旧资产兼容；只给未来INSERT写入，不改旧迁移、既有RLS/FORCE/appendonly trigger，不为补标题授UPDATE。旧资产缺信息返回“未提供”或paperId，不在只读接口临时联网抓取/改文件，不编造authors/title。

应用严格构造白名单DTO（title、作者公开姓名、venue/year等），约束字符串/作者数量/整体字节上限，禁止直接保存整个OpenAlex work或未知嵌套字段。size应来自已校验实际PDF bytes，不能信任未验证HTTP头或声明字段；abstract_only不得假称有全文size/页。公开字段仍是不可信文本：React文本渲染，不透传HTML；公开链接只允许安全协议/无userinfo，不能携内部URL、cache path、账户或能力凭据。view_metadata不能成为任意查询/文件读取参数。

## 4. 页回执事件原子性与大小

保留既有顺序：output schema通过、asset/pages与原请求匹配、在线token再次验证、同account/dossier的full_text资产检查后，才进入receipt事务。用同一个client在receipt插入事务追加appendEvent，失败全部回滚，不先发SSE/写另一个事务；相同run/asset/page重复读取不重复追加。

建议dedupeKey固定run+asset+page，payload带text_sha256；相同key不同文本必须冲突拒绝，不能覆盖旧页或把两个版本都显示成p1。现receipt主键含hash，应用需要显式处理同页不同hash，不能默认取最后一条。旧receipt无ledger事件可由快照恢复section，不伪造新的“刚读取”时间或游标。

page_text上限4MiB，不应整页复制进ledger/SSE。事件只带可验证receipt身份/摘要与有界显示片段，快照只返回有界section gist/实际已核引用；全文另走受账户/档案约束的分页读取。卡引用仍由当前run receipt精确原文验证，前端pN只是显示定位，不能代替服务器校验。receipt成功表示服务器提取/核验已完成，不应额外承诺模型一定收到未知HTTP结果。

## 5. quiz、费用与接口表示缺口

quiz keys只能保留服务端档案JSON。read-state/read-events/history/SSE均显式投影quiz公开字段，不select/spread档案JSON或native tool args/result；scrub不是quiz答案删除器（keys不一定命中其敏感字段模式）。建议服务端严格DTO并在adapter再只取id/q/layer/hint，禁止透传keys及旧raw card。grade继续throw，ask只产生本地用户文字与“第二期”说明，不能调用模型或伪造研究结果。

unknownCost应基于用量/hold/usage_uncertain语义，不把所有普通event.cost_cny=NULL都算未知，也不能把未知coalesce为0。当无可核对用量时spentCny=null；有已知与未知并存时展示已知额+unknownCost=true，最终费用仍由账本核对，前端不自行重算扣款。

ReadEvent.approval仅pending/approved/rejected，不能把sent/indeterminate/expired强转pending或approved；应隐藏可决定动作并提供“待核对/已过期”的真实说明。ReadAdapter.decide没有answers参数，question approve必须拒绝并引导完整收件箱回答，不能造空答案/选第一个；permission也仅once。源DTO需保留kind/sent用于适配器围栏。

## 6. 会话、确认与未知请求

同源fetch SSE使用现内存session与generation，token获得后、每次chunk分发前、load/分页响应返回后都复核代次；logout/切账户/切dossier要abort旧reader并丢弃旧缓冲、游标与estimate/intent。别用URL query传token，不写localStorage；redirect:error、credentials:omit、no-store。订阅与load先后竞态需明确缓冲/等待方案，不能load完成覆盖已应用较新事件，断线只读按最后已接受seq续接。

estimate必须绑定dossier/role/query/budget/有效期，变更任意用户输入重新预估；只有明确确认才POST confirmed:true。相同未知POST保存并复用完全相同HTTP幂等key与body，不能生成新key/新native requestID重派。页面重载丢失本地key时先只读恢复既有run/收据，无法确定则显示unknown并停止派发；不能把“查不到响应”当未运行。现run.request_id与HTTP idempotency key是两个不同层次，不应混用；native身份继续由后端绑定维护。

cancel/decide固定当前账户、dossier、run/approval，保持现有sent/unknown围栏；adapter load/subscribe只读，不能顺便prepare/grantSession、bootstrap模型或触发run。newReading只在用户调用时新建research@1.1.0；旧已钉1.0档案不能静默切版。

## 后续实现验收建议（本次未执行）

实现后定向验证：跨账户/跨档案拒绝；快照并发一致+固定through不混新页；page receipt/event故障同回滚与重复幂等；多asset p1不串引；quiz keys在所有出口无字段；unknown费用不变0；SSE旧会话/乱序重放不污染新账户；未知start不再次派发。当前仅设计评审，不作为实现安全通过或模型执行授权。
