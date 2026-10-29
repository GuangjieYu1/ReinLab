# P1-12 收件箱、用户决定与会话独立安全评审

日期：2026-10-23；工作树`/Users/guangjieyu/.codex/worktrees/research-foundation/ReinLab`。只做安全/数据库评审与独立合成测试，未修改普通实现，未用真实key、模型、浏览器或真实容器Env。

## 结论

**当前安全评审通过，无未关闭必要问题。** 首轮发现的浏览器会话刷新竞态、跨账户旧视图和刷新清空intent幂等键问题均已由root修复并复核。此次结论不替代root进行中的类型、完整E2E和整批业务验收。

## 已关闭发现

1. **旧refresh可恢复已退出会话或覆盖新账户。** 原实现logout后in-flight refresh成功仍写session；A刷新期间登录B后，旧A成功或失败分别可能覆盖或清空B。独立测试首轮实际红。修复使用session generation与原session identity，login/logout推进代次；refresh成功/失败都不能改写新代次，会话相关API在取token与返回数据后均核对代次。最终独立三种竞态断言通过。
2. **跨账户旧视图残留。** 原LiveInbox退出未清data，旧请求也可晚返回写入A数据。现退出清data/error/status/busy，refresh/act在改React状态前检查代次；退出卸载children/LiveResearch，新账户重新读取档案。此项代码复核通过，未声称亲自做浏览器E2E。
3. **refresh清空同intent幂等键。** 修复会话竞态时曾在refresh finally清intents，导致常规刷新或旧A刷新清除B的key缓存。现只在退出清空，刷新不清；独立测试验证首次决定发生刷新且HTTP回复丢失时，同intent重试继续使用同一key。

## 亲自执行

所有shell login:false，先unset DEEPSEEK_API_KEY，指定Node22 PATH；仅测试PG及合成fetch/native runtime fixture。

- `vitest run services/control/test/browser-session-security-review.test.ts services/control/test/inbox-security-review.test.ts services/control/test/inbox-api.test.ts services/control/test/session-api.test.ts`：4文件、10/10通过。
- 新独立browser-session测试4项：退出后旧refresh不复活；A refresh成功不替换B；A refresh失败不清B；同intent跨refresh/丢回复幂等key稳定。断言只输出布尔，不输出token值。
- 新独立inbox-security测试：对真实其他账户promotion/approval ID决定均404；foreign supersedes拒绝；多条目第二条非法时第一条memory也回滚、promotion仍pending；同账户同层同key合法supersedes只写一个successor；promotion_decision跨租户不可见、UPDATE权限拒绝；006两张决定表RLS+FORCE元数据均true。
- 原inbox-api实际覆盖四动作L2/L4落点、来源DTO、并发同key/不同key收据回放、相反决定冲突、过期/无依据拒绝、账本故障整体回滚、仅once卡决定、过期gate review快照拒绝。
- 原session-api实际覆盖固定上游URL、同源/Content-Type/Fetch-Site拒绝、上游多余字段不输出、no-store。
- `vitest run services/control/test/mcp-engine.test.ts services/control/test/decisions.test.ts -t 'once|approval|session scope|uncertainty|indeterminate|MCP|mcp'`：2文件、9/9通过，25项按定向筛选跳过。覆盖现有MCP/原生决定once及unknown不可重发相关分支；未执行真实内核模型。

## 代码复核

### Promotion API与memory scope

认证账户来自后端JWT verifier，所有业务SQL通过Database.withAccount设定RLS上下文，不能由URL/body选择账户。列表仅当前账户pending且未过期提议。决定使用mutate事务与HTTP幂等收据，再以账户budget锁、promotion行锁及独立promotion_decision业务收据串行化不同幂等键的竞争。

approve/edit落目标L3或L4的账户全局memory（dossier/thread null）；keep_local固定L2且绑定来源run的当前档案；reject不写memory。Items严格key/evidence非空、有界、key不重复，编辑不能传目标层/账户。supersedes查RLS内的同层/同dossier/无thread/同key/未revoked前项，且不能已有successor；006唯一索引提供数据库最终竞争约束。过期检查在读取与最终更新时均用clock_timestamp；写memory、状态、决定收据、event与HTTP收据处于同一数据库事务。

### 审批、MCP包装与unknown

列表绑定账户/run/dossier与被接受os_binding，区分原生及MCP/卡请求；包装权限引用对应MCP approval时去掉重复展示的直接MCP卡，公开DTO过滤原生session/request ID及reinlabMcp内部字段。该去重是展示行为；真正授权仍由原生DecisionService的bridgeMcpDecision按账户/run/capability/requestId/argsHash逐项匹配，不能用包装字段授予任意权限。

直接卡决定schema只允许once，业务card_decision收据阻止不同HTTP key冲突；MCP交给engine.decideClient并验证run有效，实际能力调用仍要求原request/argsHash匹配并消费单次审批。gate请求保存review state/revision/artifact快照，决定时再次匹配档案与artifact，transitionGate按预期revision执行。

原生审批继续走原DecisionService validate→prepare→dispatch流程；发送前持久decision_sent围栏，未知结果不重发；前端indeterminate卡无再提交按钮。客户端稳定intent key提供丢回复重试，服务端业务收据与native send fence是最终保障。

### Auth、代理和前端

session proxy上游从可信SessionPort配置固定，拒绝URL凭据/非HTTPS（仅127.0.0.1开发HTTP例外）/query/hash/path。只向固定/auth/v1/token端点发送JSON，redirect:error；登录/刷新参数不接受目标URL。Origin必须等于请求origin，Host/Fetch-Site/JSON类型检查；响应no-store/no-cache，只挑选有限session字段，不透传上游错误、用户附加信息或cookie。

前端只访问同源/backend代理，fetch credentials:omit、redirect:error、cache:no-store；access/refresh token仅模块内存，无localStorage/sessionStorage/cookie或日志。LoginGate读完立即reset表单，错误为固定文本；session generation防止旧请求污染新账户。Live组件用React文本渲染内容，未引入HTML插入路径。后端业务请求独立验证JWT issuer/audience/algorithm/role/sub，登录返回user ID本身不能绕过此验证。

### 006数据库

promotion_decision与card_decision使用(account,id)复合主键/FK，决定收据不能跨账户错接。RLS+FORCE tenant policy、仅select/insert权限、append-only UPDATE/DELETE触发器；memory_one_successor按(account,supersedes)唯一，禁止同一前项出现两个successor。现有基础表RLS/复合账户FK继续生效。

## 限制

未亲自跑浏览器E2E、生产Supabase登录或真实native网络审批。前端旧视图清理以代码复核为主；会话代次及API数据返回保护有合成异步测试。会话上游属于可信固定服务，本轮未进行其可用性/无限流响应压力测试。未将root全量结果计作本人亲自执行，也未宣称整批P1-12完成。

## 最终安全附录：opaque refresh与账户token扫描

refresh token现按非空可打印ASCII、上限8192作为opaque值传给固定Supabase Auth；不凭token长度承诺认证强度。JWT业务核验未改变。真实12字符形状的合成代理测试通过；本人执行session-api+browser-session-security-review，2文件6/6通过。

新增扫描分支首轮发现以下问题（现已修复）：显式account-root为空/不存在时glob零项仍可passed，仅选3个既有值；account文件未校验current uid/精确0600、父目录0700或accountId绑定。纯合成隔离HOME/CODEX_HOME/空git首轮复现（/tmp/reinlab-p112-scanner-security-review.py）：emptyRoot accepted/passed=true且selectedValues=3；合法1账户selectedValues=5；publicParent755与file0400同样accepted/passed=true。没有读取任何真实key或日志。

扫描器stdout与JSON报告只使用固定字段和计数，未发现凭据原值输出；顶层异常固定CREDENTIAL_SCAN_FAILED，Git stderr抑制。首轮另发现output直接write_text会跟随已有symlink/hardlink，已一并反馈并修复。

**附录修复后最终通过，无待关闭问题。** account_values现要求canonical绝对root存在且非空，root与每个UUID账户子目录0700/current uid；文件lstat及open后fstat核对regular/current uid/0600/单link，O_NOFOLLOW/O_NONBLOCK，schema字段集合严格、JSON accountId匹配目录、auth/container严格43位base64url string。报告给accountCredentialFiles数量。发布report拒绝已有symlink/hardlink/非本人目标，使用私有600临时文件、fsync、atomic replace，不跟随目标叶链接写入。

本人修后实际执行隔离扫描8个场景：empty root拒绝；合法1账户通过且selectedValues=5/accountCredentialFiles=1；0755账户目录、0400文件、错误accountId、硬链接凭据均拒绝；symlink/hardlink report输出均拒绝且原sentinel文件未改变。另本人运行tooling/security/test-scan.py，9/9通过。均未扫描真实凭据或真实Codex日志。

actual runtime审计脚本只在内存捕获docker logs、可读/proc环境及control ps，再与私有文件值比较，输出固定scope和计数；没有raw Env或logs输出。account环境PID筛选普通template的source双反斜线会生成正确单反斜线regex，并要求processes>=1；verify-container已改String.raw单反斜线/^\d+$/，强制readable>0，报告blocked及readable_processes_only。本人以静态source反斜线计数与代码复核确认此修复，没有再次读取真实/proc环境。EACCES只计blocked，不能冒称不可读进程已覆盖。

root提供的实际4账户scanner selectedValues=11/accountCredentialFiles=4、各scope零命中，以及runtime audit9/9（每账户2可读/1 EACCES）为root执行来源，不算本人亲自运行；未放宽系统权限，也未宣称扫描全部历史凭据/不可读进程。
