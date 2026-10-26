# 第八批第三次冒烟绑定独立安全评审

工作树：/Users/guangjieyu/.codex/worktrees/research-foundation/ReinLab；送审分支codex/t-mcp-10-third。仅源码与合成fixture，未运行smoke-mcp脚本、未读任何真实凭据/私有配置、未操作浏览器、未调用模型。只新增services/control/test/batch8-smoke-security-review.test.ts，未改生产实现。

## 必要发现及修复

初读发现授权截止仅脚本启动/初始化前核验，宿主mcp-smoke-guard未带截止；慢初始化或后续轮次可越过validUntil真实转发。已立即反馈主agent。最新修复经独立复核：guard新authorizationEndsAt安全整数且创建时未过期；请求进入时核截止并关闭；读取请求体及marker持久化后、真正transport调用前再次核截止，失败不转发。脚本传固定binding.validUntil，确认run/消耗RUN_KEY前再次validateSmokeBinding。没有移除旧marker/unknown/六轮围栏。

独立新增三项时钟fixture：创建已过期拒绝；等待请求体时越过截止拒绝；marker fsync后越过截止拒绝。三个情形transport调用均0。测试以合成clock、私有临时目录、mock transport和fsync钩子验证真实guard HTTP路径。创建过期直接拒绝是正确行为；首次测试曾因预期HTTP而失败，调整为预期配置拒绝后全绿，此失败不作为旧漏洞的动态红灯证据；旧缺口由源码确认。

## 当前边界结论

- thirdSmokeBinding冻结精确授权标识、执行人Codex、独立新目录、1.1.0及预算1；CLI必须execute-once及完全匹配authorization/executor。未知/旧绑定或过期拒绝，启动及确认还要求距截止超过10分钟。当前硬编码授权时段已经过期时脚本应直接拒绝，本报告不授权延长。
- 新目录与旧授权namespace不同；账户身份、admission、forward marker均在新目录。startup lock贯穿初始化至cleanup/report finally；RUN_KEY在POST前持久化，已消耗禁止重跑；guard marker O_EXCL/O_NOFOLLOW、600、owner/nlink/regular、私有canonical700目录，逐轮append+fsync后才真实转发。存在marker的替代进程不能重新开始。
- fresh dossier经effective version1.1.0复核，bundle固定1.1.0，read role仅本次独立fixture会话。fetch批准必须同search request成功输出的唯一真实W-ID且匹配固定论文；files.write必须完全等于预设新文件path/content；finding card严格字段/枚举、合法UUID/page1、非空≤25词quote，并在批准前查询同account/dossier/run/asset/page的paper_page_read原文核验。page read为第四项真实性核验，三项写/获取审批均精确argsHash并只once；后端原有第二次引用校验保留。
- 单guard至多6个不同串行HTTP模型体，单体≤65536字节/max_tokens1024/thinking disabled、未知选项拒绝。按现有固定峰值费率及4096输入协议余量，6轮保守式为0.95551488元，低于1元；这是该协议余量和已核价表前提下的上界，未以本次真实发票核验替代。未知或非2xx/200内error/不完整JSON-SSE终态/凭据反射永久fence，不重试真实模型。
- run提交POST未知仅用保存estimate/account/dossier只读查询唯一run，不再次POST；approval sent/unknown不可重发。失败finally关闭guard、核cancel终态（未确认固定报indeterminate）、fresh同scope只读resolver清临时gateway，逐项清理并保存固定阶段失败；不会把cleanup不确定当成功。

## 亲跑证据

login:false，先unset DEEPSEEK_API_KEY，指定Node22 PATH：
`./node_modules/.bin/vitest run services/control/test/batch8-smoke-binding.test.ts services/control/test/batch8-smoke-security-review.test.ts services/control/test/batch7-smoke-policy.test.ts services/control/test/mcp-smoke-guard.test.ts services/control/test/p113-mcp-smoke-security-review.test.ts`

5文件29/29通过，492ms；含绑定2、独立截止3及现有policy/marker/并发/反射合成用例。无真实PG/容器/模型/浏览器覆盖声明。上述本次绑定增量必要问题已修，当前范围未见未修安全阻断；独立测试冻结。后续默认关闭的本地真实模式/网关尚不在本报告覆盖范围，需另外送审。


## 审批顺序增量只读复核

仅读新增smokeReadReceipt与smoke-mcp的write/card分支，以及batch8-smoke-native对应断言；未重跑旧测试、未执行原生或真实冒烟。

smokeReadReceipt要求精确fetch/pages requestId+capability各唯一native completed，fetch必须full_text且assetId为UUID；pages.input.args必须精确{assetId:该fetch资产,pages:[1]}，输出仅1页且page1非空。write批准前另以同account/dossier/run/asset/page查询DB回执，要求page_text与native输出逐字相等，不能只靠模型声明“读过”。card批准前要求先前精确fileApproval意图已发出，且唯一files.write native completed的args仍完全等于预设fileArgs；每条引用paperId固定为前述fetch资产、page1，并继续核DB原文。上述顺序没有新增自动批准或更宽scope路径，未知/缺回执/错误资产/重复receipt均失败停下。

native fixture源码明确断言loopback usage cost_cny=NULL和UNSUPPORTED_BILLING_ROUTE、guard恰6轮；其原生链路成功不代表现金费用已结算或hold已释放。该fixture由主agent执行，本agent只读核其断言，不记为亲跑。此增量未发现必要安全问题；费用/授权截止与失败不重试结论保持原报告范围。
