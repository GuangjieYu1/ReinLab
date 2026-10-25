# 第七批独立安全/迁移评审（最终定向结论，测试范围冻结）

工作树：/Users/guangjieyu/.codex/worktrees/research-foundation/ReinLab，分支codex/p1-read-clarify；读到HEAD adb8f17及其未提交新增实现。重点001迁移、clarify/model、独立audience、plugin出站和read-clarify人类选择。未改任何实现；仅安全测试。未读真实凭据/浏览器、未调用真实模型。

## 已修发现与验证

1. 迁移初版chosen_approval仅单列FK，未绑定candidate/approval同account/dossier/run，且允许chosen/approval一侧NULL。主agent在应用001前补配对CHECK、choice_scope trigger及closed-run不可逆trigger；目前001/002/003已应用，后续不能改旧字节。独立PG测试跨账户chosen拒23514、候选UPDATE拒42501、RLS不可跨账户读，closed不能true→false。触发器均普通invoker并撤PUBLIC执行，不增加RLS旁路。
2. 新model guard原回归了SSE逐帧反射漏洞，且DONE+usage可缺完整finish/超max_tokens。已抽credential-reflection，核stop/tool_calls、输入usage≤wirebytes+4096、输出usage≤max_tokens、reasoning=0，未知固定body且durable unknown。独立合成Hono模型响应无终态/超usage/split-token三项通过；无真实HTTP上游。
3. authorizedModelPort.prepare原仅在读私有授权/合成key时核时间，DB准入等待后send可越过授权截止仍fetch。独立合成时钟红灯确认；最新send在实际fetch前重核保存VALID_FROM/UNTIL，红灯转绿，fetch次数0。

## 初次发现的源码边界（均已修复，以下保留发现背景）

A. credential-reflection对数组使用forEach push至LIFO，单帧tool_calls重复同一index的arguments片段被倒序累计。SDK按数组顺序append时可还原完整凭据，而guard检查倒序值不命中。纯helper合成判断实际返回duplicateIndexReflectionBlocked=false（未写第三测试、无网络）；建议反向push保持原顺序，或拒单帧重复index。标准跨帧/重排不同index已通过不覆盖此例。
B. pricing_context只核version/rate并直接比较validFrom/validUntil；缺字段/NaN/非数字使JS时间比较均false，未核实窗口会通过。保存JSON目前是可信后端来源，但模型独立准入应严格Number.isSafeInteger/顺序或schema检查，不能依赖隐式coercion。此项为源码复核，遵范围冻结未再新增测试。

## 硬预算、轮数与未知围栏

SQL before-insert获取账户ledger事务锁，检查dossier累计maximum_micros≤50000、count<6、无未completed请求及未closed父/run；identity/hash/maximum/created_at不可重写，forwarding只可到completed/unknown。独立真实PG同时两个30000请求仅一个成功；完成后再加20001拒绝；unknown阻后续且不能复活；六次即使每次仅1micro，第七仍拒。未知不会被释放为0。

模型HTTP先在线验专用audience/role research-clarify/version1.2/search-only，再body限制和固定模型/thinking disabled/output256，持久reserve+账本COMMIT后才send。prepare失败没有真实转发；commit未知残留forwarding仍阻后续。所有上游仅一次fetch，无重试，fixed DeepSeek URL/redirect:error/30s，512KiB响应；port未配置返回503且不预留。本批没有配置/读取真实授权文件。

modelMaximum采用输入wire bytes+4096与输出上限的峰值USD→CNY7.2保守费率，整数向上取整。DB测试证实“按该maximum不超50000”，不等于对供应商隐藏prompt开销/未来价格作无条件数学保证；仍需固定协议开销前提与已授权价表。实际usage超该上界已改unknown，不能继续，预算不退款。

## 独立token与出站

模型token aud=reinlab-clarify-model，MCP aud=reinlab-mcp互斥；verifyModel后仅将原MCP claims用于同jti/hold/claims_hash/在线撤销校验，不把模型token交MCP入口。独立签名fixture验证两端互拒/过期拒，使用内存生成ed25519而非真实签名文件。主agent已有在线撤销测试，本agent本轮独立文件仅验crypto audience；不冒称亲跑其撤销用例。

当前出站方案为可信plugin chat.headers附run标记、进程global fetch wrapper重定向固定127.0.0.1:9/v1闭环到control gateway；role私有配置只有public placeholder、禁其他providers/title。标记缺失或插件失效时落到闭合loopback而非真实key endpoint；有标记严格origin/path/method/body，forward到control时只传modelToken而非原provider Authorization。private modelToken沿既有mcp-clients文件，不进role文本/ENV/argv。

源码上fetchWithFreshConnection每次动态调用global fetch，支持该无上游修改接线；但正式Bun产物中的hook安装/SDK各种调用、headers携带与失败后无direct fallback仍需native fixture实证。本轮没有做该真实原生产物测试，不能把静态推导写成已覆盖所有native出口。

## 人类选择与候选真实性

plugin before question强制missing_authority，pick header用服务端candidate options覆盖AI参数、single-choice/custom=false；不会通过autonomous/planning分支自选第一项。候选由同search响应白名单sidecar，成功schema+在线token+账本事务内才publish；未修改原papers.search严格输出合同。页数缺失保留未知，公开书目范围带未PDF核验说明。

pick preflight与mutate都查询当前account/dossier/clarify run的native approval和候选；question pending、未sent、accepted receipt才准备once意图，DB约束再核scope。chosen先存pending意图但currentChoice仅approved返回，unknown不当已选；chosen非空时先关闭澄清run/model gate再dispatch/取消，阻选择后偷偷增加模型轮。unchoose不清空请求预算表/轮数，正式run在场阻改选择。原生question事件自身不能直接写chosen；模型文本/推荐结果不构成人类授权。

## 亲跑与冻结

按主agent最终要求只保留两份已有独立安全测试，不创建第三文件：
- services/control/test/batch7-security-review.test.ts：4/4，真实55432合成账户，SQL并发、50000/第7轮/unknown/closed/归属/RLS与audience。
- services/control/test/batch7-model-security-review.test.ts：4/4，纯合成模型transport、fake DB与临时私有授权/key文件；无终态/超usage/split-token，以及授权窗TOCTOU红→绿。

最终合跑2文件8/8通过。另一次node/tsx纯helper判断确认上述重复index反射残余，不输出任何合成token值。所有命令login:false、先unset DEEPSEEK_API_KEY、指定Node22 PATH。未跑全量、真实浏览器、真实供应商或native模型出站fixture。

A/B在下列最终复核前均已修复；早期8/8及全额maximum累计表述仅代表004之前的实现。最终结果以下列004–006定向结论为准。


## 2026-10-26 最终增量：004–006已知保守费用凭据

读到HEAD adb8f17及当前未提交004/005/006与API实现；未改生产代码。原两独立文件已完成并冻结，最终亲跑2文件15/15通过（DB/签名7项、模型transport/授权8项；最后合跑2.39秒）。

已修缺陷：
- 原A的LIFO数组倒序累计现按SDK数组顺序处理；同一帧重复tool index拆分arguments的凭据反射被阻断，不同index不误拼。
- 原B的pricing_context现核currency/window/version/rate与安全整数时间、有效区间；原授权截止TOCTOU仍在真正fetch前重新核时，合成fixture证实过期后fetch为0。
- 004初版receipt必需数字字段使用SQL NULL三值比较会漏拒缺字段；005用IS DISTINCT FROM修复，并固定responseModel白名单及pricingVersion。未改已应用004字节。
- 005只约束后续写入，历史不完整completed receipt仍可能被直接SUM低估；006新增普通invoker、IMMUTABLE纯函数reinlab_clarify_reservation。仅完整字段、整数token/非零总量、completion≤256、正确峰值公式、cost在1..maximum、hash格式及model/价表固定时返回costUpper；其他返回原maximum。函数撤PUBLIC执行、仅授reinlab_app，不增加表访问或RLS旁路。触发器与API两处累计查询均统一使用该函数，未修改历史记录。

预算最终语义：每次真正转发前仍以完整wirebytes+4096/输出256的最坏maximum原子准入；仅完整终态、合法usage及持久不可变receipt允许释放已知多余预留。有效累计为已验证completed costUpper + 其他maximum；unknown/forwarding不释放，失败/未知阻下一轮，六轮计数永久保留。独立PG同时两笔40000、既有已知3024时仅一笔成功，累计43024；unknown保40000且拒后续。此结论不把unknown当0，也不放宽单次真实转发上限。

实际新增/更新测试：
- receipt非法矩阵20类：缺p/o/cost/hash/model/price、字符串数字、负/小数token、completion257、全零、错误公式/超maximum、坏hash/model/价表均23514；失败后row仍forwarding且receipt NULL，合法后receipt与maximum不能重写。
- 006使用jsonb_populate_record(NULL::clarify_model_request,合成JSON)直接调用纯函数；合法completed返回3024，19类不完整/非法旧凭据以及forwarding/unknown均保留30000。未禁触发器、未插入或篡改旧历史行；确认该账户request表保持空。
- 模型usage重复帧减少或增加均永久unknown；相同重复usage允许合法completed并保存固定模型/价表/响应hash及计算上界。
- 保留SQL并发/六轮/unknown/closed、跨账户选择/RLS/候选不可变、独立audience、无终态/超usage/跨帧凭据反射、重复index反射与授权截止测试。

复跑命令（login:false，先unset DEEPSEEK_API_KEY，指定Node22 PATH）：
`./node_modules/.bin/vitest run services/control/test/batch7-security-review.test.ts services/control/test/batch7-model-security-review.test.ts`

本次定向安全边界无未修必要问题。最终只修改上述两安全测试；未另建第三文件，未读真实凭据、未真实模型/浏览器/冒烟、未跑全量。正式Bun/plugin全部出口、供应商协议开销上界及真实模型行为仍不属于本次亲跑覆盖，不以主agent其它测试代替独立证据；本报告不是新增模型授权。


## 2026-10-26 最终窄复核：.invalid闭合出口、顶层选项及空搜索问题

只读复核当前role-project.ts、clarify-model.js、clarify/model.ts、app.ts及对应测试断言；未改生产/测试代码。

- modelCap角色固定deepseek公开placeholder与https://reinlab-clarify.invalid/v1，取消loopback导致usage被判local的地址。plugin只有在已登记run标记、在线verify通过、精确https origin及/v1/chat/completions、无query、POST/string body时才代理到私有配置中的control gateway；代理只携带独立model token，redirect:error。缺marker/未登记run走原fetch仍仅面对角色固定.invalid地址和公开placeholder；没有供应商URL/key fallback。URL userinfo/fragment不改变真实origin网络目标，但网关转发也不复用原headers。此变更不削弱现有预算准入/六轮/unknown围栏。
- model HTTP body新增顶层字段白名单，在prepare/reserve/send前拒enable_search/web_search_options等未声明付费扩展。固定model、stream、disabled thinking、n=1及max_tokens≤256检查仍保留。对应主agent测试中的非法付费字段断言已只读核对，不冒称本次亲跑该文件。
- 候选endpoint从在线MCP授权的同account/run真实read_candidate构造最多5候选，并固定追加“都不是”。故options.length===1明确表示零真实候选；plugin将其强制改REINLAB_CLARIFY、单选、唯一“补充说明”及custom=true。不能由模型构造W-ID成为已选论文，非空候选路径仍custom=false及真人paper pick，后端原归属约束保持。空结果补充文字不等于论文选择。

亲跑原两独立文件再次15/15通过，最后耗时7.51秒；未调用模型、未读取真实凭据。主agent报告native fixture2/2及provider=deepseek/route=byok，本次只读核到该fixture确有相应断言，未将其记作本agent亲跑。上述三处增量未发现必要安全问题；本轮范围冻结。


## 2026-10-26 扫描器CLI退出码窄复核

只读核scan-mcp-credentials.py结尾与test-scan-p113.py合成fixture。报告正常写入与脱敏计数stdout之后，所有status != passed均sys.exit(2)；SystemExit不被except Exception吞掉；异常仍固定CREDENTIAL_SCAN_FAILED且exit1。仅passed返回0，消除“已发现泄漏但CI仍成功”的错误。未放宽匹配规则、私有输入读取或原子报告规则。

亲跑python3 tooling/security/test-scan.py：9/9通过；亲跑python3 tooling/security/test-scan-p113.py：7个布尔检查全通过，包括model audience合成私有fixture纳入8个精确值、干净返回0、worktree命中返回非零，以及公开权限/硬链接/符号链接拒绝。测试隔离HOME/CODEX_HOME与临时git仓库；失败断言只包含布尔checks，不输出匹配值。没有真实配置或凭据读取，无模型调用。此CLI更严格退出变更未发现必要安全问题。


## 2026-10-26 Inbox与ReadPick共用真人选择增量

仅读clarify/candidates.ts、bridge/openscience/decisions.ts、api/read-clarify.ts接线，并核既有决定入口调用上下文。DecisionService.load仍在账户事务/ledger锁下校验approval所属账户、同run binding/session、accepted receipt；normalize仍拒问题缺答案、非once及非法输入。只有已认证真人决定prepare调用prepareHumanPaperChoice，模型事件/question.replied没有新chosen写入通道。

共用helper锁定同run澄清gate和同dossier clarification，核research-clarify、未closed/ended、仅running/waiting、无在场正式run；pickView由原生问题选项与DB同run/dossier真实候选核对，再严格单问题/单答案。未知选项和其它scope候选拒绝；“都不是”不产生chosen。候选意图、approval intent与ledger事件同事务，错误回滚。候选存在时先关闭澄清gate；currentChoice仍仅返回approved对应choice，prepared/indeterminate不会伪装完成选择。dispatch保留先持久sent再发一次、unknown不重发；只有精确resolved回执才走共用取消，cancel仍持久一次围栏。ReadPick已删除重复chosen写入，交共用prepare；旧permission/question授权规则保持。

新增仅一项独立安全测试到原batch7-security-review.test.ts：未知答案、其它账户/档案候选及多选均拒，且chosen/closed保持未写；合法意图关闭gate但pending/indeterminate的currentChoice均为空，关闭后不能重选。此项直接验证helper/DB投影，不冒称完整API未知transport覆盖；未知不重发结论另由dispatch源码核验。

亲跑原两安全文件及batch7-api.test.ts：3文件19/19通过（独立16项+现有API3项，7.38秒），包括research/inbox两入口参数化正向一致性。未改生产代码、未读真实凭据/浏览器、未调用真实模型。此增量未发现必要安全问题；独立测试再次冻结。
