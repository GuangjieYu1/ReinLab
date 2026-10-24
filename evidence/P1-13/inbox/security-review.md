# P1-13 收件箱后端/数据适配独立安全评审

日期：2026-10-24；工作树`/Users/guangjieyu/.codex/worktrees/research-foundation/ReinLab`，分支`codex/p1-13-reconcile-inbox`。仅安全评审和测试，未修改Claude的`src/components/inbox/`、主仓库或worker，未调用真实模型或读取真实key。

## 最终结论

**本次后端/API与adapter安全评审通过，无未关闭必要问题。** 后端superseded读取及会话代次隔离通过；adapter首轮三个fail-closed问题已在root完成T-REG后修复，独立红→绿复验完成。本评审未修改adapter实现或Claude组件；后续Q086发现角色/恢复worker迁移尚未实现，不含在此通过范围。

## 已关闭加固与红测试

独立`services/control/test/p113-adapter-security-review.test.ts`首轮5项：3失败、2通过。

1. evidence响应仅核ref/at，未验证event.dossierId/runId匹配load时promotion.source；合成错档案/错run响应仍被展示为该提议的来源。应在adapter拒绝。真实后端同源API本身已有严格绑定，本项是adapter来源校验而非已观察到服务器越权。
2. superseded响应未核返回id/key等于提议items实际引用项，合成错误memory或key仍被接受。应验证响应id及对应引用item.key。
3. decideApproval只看pending，不检查sent；合成pending+sent=true仍调用decide。应拒绝已发送标志，不能仅依靠状态完全一致；服务端现有send fence继续是最终防重复保障。

修后代码复核：evidence同时要求ref、at及event.dossierId/runId匹配load时p.source；superseded核对响应id、实际引用项key及value存在；任何sent均拒绝decide，返回UI的DTO还投影为indeterminate以隐藏再批准。三项首轮红测试现全部绿，既有正向fixture只补真实API本就包含的dossierId/runId，未放宽断言。

已通过的独立并发测试：A的load在途期间切换generation至B，B load先完成、A随后返回，A结果无法覆盖B缓存或读取A evidence；B登录尚未完成时旧A session已立即清空，API不发送A bearer，B成功后只发送B bearer。

## 亲自执行

全部shell login:false，先unset DEEPSEEK_API_KEY，指定Node22 PATH；使用固定测试PG55432与合成ports/fetch。

- `vitest run services/control/test/p113-adapter-security-review.test.ts`：首轮5项中3红2绿，原因如上；合成结果不涉及真实秘密。
- `vitest run services/control/test/p113-superseded-security-review.test.ts services/control/test/inbox-api.test.ts services/control/test/browser-session-security-review.test.ts`：3文件、11/11通过。
- 新独立superseded负面/并发测试：同时请求本账户真实引用、同账户未引用、同账户错key、跨账户memory、错层、错档案L2、正确档案L2，状态分别200/404/404/404/404/404/200；另一账户实际promotion也404。
- 未运行整仓全量、浏览器T-REG或真实native/模型；root的T-REG不计为本人执行。

最终亲自执行：`vitest run services/control/test/p113-adapter-security-review.test.ts services/control/test/p113-superseded-security-review.test.ts services/control/test/inbox-adapter.test.ts services/control/test/inbox-api.test.ts services/control/test/browser-session-security-review.test.ts services/control/test/inbox-security-review.test.ts services/control/test/session-api.test.ts`，7文件、23/23通过。独立adapter测试新增sent DTO必须投影indeterminate，以及evidence/superseded在途时generation变化必须拒绝返回旧账户值；两类均实际通过。此前修后未补这项在途读取时，同命令22/22通过；最终以23/23为准。

## 已通过代码复核

API在Database.withAccount/RLS下关联promotion→同账户run→同账户memory，要求memory.thread_id为null；全局层需匹配promotion.target层且dossier null，L2需匹配来源run.dossier。jsonb_array_elements限真实数组，exists要求该提议items实际supersedes引用及相同key。无通用memory ID读取口，返回scrub后的id/key/value。

adapter只允许load过的提议决定、evidence ref和supersedes读取；路径ID使用encodeURIComponent，eventRef限定canonical安全整数。generation变化拒绝旧缓存和旧异步响应；load取得响应后先核generation再提交cache。直接问题approve因Adapter接口无answers而拒绝，reject不会编造answers；indeterminate拒绝再次提交。业务请求沿用既有稳定幂等key/服务器业务收据，不将“丢HTTP回复”等同于可重做原生动作。

research-live在login开始即递增generation、清session/refresh/intents并发会话通知；B未完成时没有A bearer可用。成功与失败旧refresh不能写新代次，会话API在取得token及读取响应后双重检查generation。LiveSessionBoundary以generation:loggedIn作为live children的key，退出及账户切换卸载旧UI状态；Claude组件仅通过既定InboxAdapter接口接线，未被本评审修改。

## 限制

adapter负面测试使用合成不一致响应/DTO验证防御边界，不声称真实后端曾返回这些越权数据。root完成原样19场景T-REG后才应用src/data修复，本评审已亲自复跑独立红测试及既有adapter正向用例；未冒充亲跑浏览器T-REG。P1-13后续数据迁移不在本次范围。

## Q-086只读设计评审：最小全局账户发现

原则可通过，尚未实现/实际验收迁移。独立LOGIN发现role仅SELECT account.id并有该role专属FOR SELECT USING(true) policy，比管理员池或跨租户definer入口更窄；发现ID后仍使用原app RLS逐账户恢复。

强制实施边界：

- role须NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOREPLICATION/NOBYPASSRLS/NOINHERIT，无业务对象/DB/schema所有权与schema CREATE；仅public USAGE、account(id)列SELECT，policy不能TO PUBLIC或ALL。
- NOINHERIT不阻止SET ROLE；检查pg_auth_members两个方向。旧同名role若有任何多余ACL/继承关系/ownership须迁移硬失败，不能只ALTER flags后假定安全。app不得成为发现role成员。
- 公共SECURITY DEFINER函数执行权是独立旁路；对可读业务/机密的definer撤PUBLIC执行权限。单独REVOKE FROM discovery不能抵消PUBLIC grant。迁移需实际负面验证SELECT */display_name、WHERE display_name、业务读写、双向SET ROLE拒绝。
- 发现Pool独立私有连接串和启动角色断言，不把admin/migration连接给worker；业务Pool继续assertSafeRole与withAccount。account UUID只用于发现和受控调度，不是绕过RLS的新授权凭据。
- cron全worker按account全局并发1、keyset分页；随机UUID意味着每轮完成必须reset cursor，否则新账户可能永远落在已扫区间。页游标在派发确认后推进，重复调度由DB sink幂等再次兜底。
- follow:false须在SSE/events打开前生效，snapshot/replay固定本轮high-water并有页数/条数/超时上限。观察reader不能持有prompt/decide/cancel接口，resolver不能隐式ensure/start/bootstrap；不新增任意账户HTTP/MCP恢复入口。
- Hatchet并发限制不覆盖已有API observer，不能替代DB sink事务锁/持久cursor幂等。只复核原已登记session/runtime绑定，unknown提交/审批不重发。

本节仅阅读Q086及既有角色/观察器代码后给设计建议，未实现迁移或worker，也未测试实际Hatchet全局并发语义。
