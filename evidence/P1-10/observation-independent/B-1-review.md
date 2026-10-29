# B-1 临时凭据 / 单次预算边界增量独立审查

结论：B-1限定增量通过，未见剩余P1/P2。只读审源码与作者原生fixture证据，独立精准HTTP/fake transport40/40，b1-independent-green.json；control tsc通过。没有全量重跑、执行CLI、读取真实key或发真实模型请求。

已先读用户主仓库design/reviews/BATCH3_INTERIM_REVIEW.md：真实smoke必须等待新计划用户确认，本报告不替代该确认或实际账单核对；不扩审B-2 tunable或其他功能。

产品路由保持deepseek/deepseek-v4-flash（报价/run authority/pricing来源未替换）；临时SDK配置只在该产品模型键下将API id指向官方等价deepseek-flash。单次guard仅接受这两个Flash名字，固定官方endpoint/同一marker/n=1/output≤1024/文本范围全部保留；别名不会生成另一付费名额。新增双向别名测试：第一名已forward后第二等价名409，transport始终1次。

配置后先核真实provider.list存在legacy alias、connected deepseek、非deprecated/alpha、APIid=deepseek-flash、context1048576/output1024/reasoningfalse；provider.list主动redact URL，因此另仅内部读raw JSON核baseURL精确等于已授权guard origin/v1，不向调用者返回raw配置。任一postcheck失败走既有cleanup（raw恢复+临时auth移除），不重试配置，不输出token。新增4项负fixture分别篡改alias/output/reasoning/endpoint，均拒OS_UNAVAILABLE并恢复原raw/移除auth。reader管理能力仍不外露，新账户/无旧连接前提保持。

作者原生证据只读核对：/tmp/reinlab-b1-native-alias-final/native-catalog.json来自实际2.0.150、空connected初始配置、随机fake token、本地fixture；完成1回合、providerCalls1、sentModels=['deepseek-flash']，恢复后connected空。证据明确realModelRequests0/realKeyReads0。旧deprecated alias目录前后差异解释B-1原因，不能把它当真实DeepSeek调用。作者/tmp 35/35结果与新独立40项范围不同，不混加计数。

本次仅新安全fixture测试：tooling/independent-smoke-guard.test.ts追加2个等价名共享marker用例；新增services/control/test/independent-smoke-b1.test.ts四个postcheck拒绝/cleanup用例。未修改生产实现或作者原红灯。
