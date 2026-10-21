# gateway_callback来源预留 / canonical模型增量

依据：主仓库最新CODEX_BRIEF_BATCH3_ADDENDUM.md§2明确本批只预留网关回调费用来源，不部署网关；HARNESS本批T-HAR1/2/5/10边界不变。设计见docs/tasks/P1-10-usage-source.md。

实现范围仅packages/contracts/src/usage.ts及index export、tooling/usage-contract.test.ts；deepseek-pricing.ts增加实际source enum使用与精确canonical白名单，另deepseek-canonical.test.ts。没有handler、DB/HTTP回调接线、网关部署或实际价格入账新路径。

- red.json：typed总拒schema + 原actual白名单，有效7 passed/4 failed；失败为两个source不能parse、合法/unknown callback不能parse、官方canonical actual模型仍unknown。
- green.json：**170/170**，共享旧契约87 + 新usage契约6 + canonical5 + 旧定价62 + 独立定价10。
- contracts/control tsc通过。全仓边界lint当时被root并行smoke-local.ts施工中的process静态loader检查阻断，已反馈root；本报告不将其冒称绿色，也不修改范围外脚本。

sourceenum已经由direct pricing metadata.source调用parse使用，当前输出仍direct_provider_usage；没有任意输入切换来源入口。GatewayUsageCallback仅规范数据，所有计数/金额明确nullable且无默认0，金额保留原币种精确decimal字符串；strict禁止额外凭据/verified/approved字段。schema成功不等于认证、验签或可落账，未来受信handler要另做绑定/验签/去重；本批尚无handler。

canonical-source.json记录只读官方页面事实及定位。官方公开页说明Flash版本为DeepSeek-V4.1-Flash-1017，legacy deepseek-v4-flash仍由该版本提供服务。仅追加该精确actualModel；requested仍必须deepseek/deepseek-v4-flash，provider仍deepseek、route仍byok，原价表/FX/窗口/计数真实性门槛未改，近似大小写/后续版本/Pro保持unknown。未声称真实模型返回已观测或账单已核对。

无native/模型/key/真实资源操作；只读官方文档一次，测试纯本机。独立复核按root指定交role_independent_test，作者不自批。
