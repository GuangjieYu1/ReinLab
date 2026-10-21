# 费用来源预留与canonical实际模型 ToSpec

依据主仓库CODEX_BRIEF_BATCH3_ADDENDUM.md§2：本批只在费用接口预留gateway_callback，不部署LiteLLM，不接回调handler，不签发临时key。HARNESS本批仍仅T-HAR1/2/5/10；没有额外网关业务实施授权。

新增共享UsageAccountingSource(enum direct_provider_usage|gateway_callback)及GatewayUsageCallback v1严格纯数据schema：event/account/dossier/run/request身份、provider/model、reportedAt、显式nullable计数、原币种currency与精确decimal amount|null。字段无默认0；缺数据不能捏造免费。禁止额外apiKey/authorization/verified/approved字段。schema只验证格式，不表示回调认证/验签或金额可信；未来接线须独立验证网关身份与绑定/去重，本批没有handler、数据库落账或网关部署。

现有direct pricing metadata.source使用UsageAccountingSource.parse('direct_provider_usage')，确保来源契约真正接入当前输出，而不是孤立枚举。原ObservationStore与结算路径不改，不把gateway标签当已接入。

官方中文pricing页公开说明deepseek-flash的模型版本为DeepSeek-V4.1-Flash-1017，旧deepseek-v4-flash仍调用该版本并按Flash价。仅向actual model精确白名单追加该canonical名称；requested仍必须deepseek/deepseek-v4-flash，provider仍deepseek、route仍byok，价表/FX/窗口/provenance门槛均不改。大小写近似与其他版本保持unknown，无通配归一化。

ToTDD：typed导出总拒schema/已有actual whitelist上有效行为红→窄实现→纯函数/契约回归。无native、key读取、真实模型或资源操作。公开来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/ （2026-10-21只读核对）。

实现结果：有效红7通过/4失败→170/170组合绿（新契约6+canonical5、旧契约87、定价62+独立10）。contracts/control tsc通过；全仓lint暂被root并行smoke-local.ts的process静态检查阻断，已反馈，未修改范围外文件。evidence/P1-10/usage-source/README.md与canonical-source.json记录官方依据和精确scope。独立评审已交role_independent_test，不自批。
