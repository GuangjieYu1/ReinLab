# P1-10 DeepSeek 实际用量定价

## ToSpec

- 新增纯函数 `priceDeepSeekUsage(part: unknown, context: DeepSeekPricingContext)`，返回 `{costCny: string|null, metadata: JsonRecord}`。输入为原生 `step-finish` part，要求原生 usage provider/model/route/time 与全部 token 计数；不接受 assistant 汇总或多调用混合数组。
- 只接受实际 provider `deepseek`；请求路由固定 `deepseek/deepseek-v4-flash`；仅接受原生 usage.route=byok 的直接 API 计费；managed/chatgpt/subscription/local/custom 为 UNSUPPORTED_BILLING_ROUTE。实际 API 模型白名单仅官方明确的 `deepseek-v4-flash`、`deepseek-flash`。不从 response.model、assistant 或输出文本猜补缺失字段。
- context 明确提供 `currency: CNY|USD`、`window: peak|offpeak`、`usdCnyRate: '7.2'`、`requestedModel` 和受支持的 `pricingVersion`；函数不读取环境、当前时间或推算节假日窗口。缺窗口/不支持价目版本或币种为 unknown。
- 2026-10-20 核对官方中文/英文价目。CNY offpeak 每百万 cache hit/input miss/output 为 0.02/1/4；USD 为 0.003/0.15/0.6；peak 均两倍。原币 CNY 不乘汇率，metadata 明确 conversionApplied=false；USD 才精确乘 7.2。
- 原生 input 已扣 cache read/write；计费输入 miss 为 input+cache.write，hit 为 cache.read。output 已包含 reasoning，不再加 reasoning；reasoning 只保留为子集。单次所有分量精确相加后向上到 microCNY，使用 BigInt，不逐分量先舍入。
- 最终向上取整后不得超过账本 numeric(12,6) 单笔上限 999999.999999；超限 costCny=null、原因为 USAGE_RANGE_INVALID，保留精确计算 metadata。任何缺少/负数/非整数/非有限/超过安全整数的计数、reasoning>output、全 0 归一化用量、缺失来源、实际路由不符均返回 costCny=null。未知不能当免费。缺少独立 cache-write 价，cache.write 归入未命中输入这一规则在 metadata 中明确记录。
- metadata 只提取定价所需字段，记录来源版本、part/session/message、provider 时间、请求/实际路由、全部计数及原生语义、币种原单价/版本/出处、原币精确金额、固定汇率与换算/取整规则。不复制原始 payload、密钥或任意 metadata。
- 不改 estimate、budget、ledger 或观察器；纯函数不代表 DeepSeek 后台账单已核对，也不包含 Search/Fetch 按次费用。

## ToTDD

1. 先写类型与安全 unpriced stub，再运行正向金额契约，保留有效 red（预期金额而实际 null，不能用缺模块/导入失败冒充）。
2. 覆盖 CNY/peak/USD、缓存与 reasoning、不逐分量舍入、整数精确性、实际模型白名单及错误来源/计数/context 的 unknown。
3. 实现后定向测试、控制面类型检查与 lint；保存本轮报告到 `evidence/P1-10/pricing`。不触发真实模型或改旧估算。

## 官方来源

- CNY：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
- USD：https://api-docs.deepseek.com/quick_start/pricing/

中文和英文页均明确旧 API 名 deepseek-v4-flash 由 Flash 当前模型服务并按 Flash 计费。本实现仅冻结已核对价格版本，不据模型版本名称自行扩大白名单。

## 实施结果

- 支持价目版本导出为 `DEEPSEEK_PRICING_VERSION = deepseek-official-2026-10-20`。
- 安全 unpriced stub 的四项正向金额契约先红（0/4）；实现后初轮 48/48；交叉检查增加路由和账本上限约束，先红 48/55，修复后 55/55。control tsc、lint 通过。
- metadata 的 `nativeCost` 为原币精确分数，`conversionApplied` 只在 USD 成功计算时为 true。聚合 token 总量用字符串避免 Number 溢出。
- 价格窗口由调用者验证并冻结，检索日期不冒充历史生效时间；函数不计算节假日。未触发模型，也不声明后台账单核对完成。
- 证据：`evidence/P1-10/pricing/README.md`、`red.json`、`green.json`、`source-snapshot.json`；交主任务复核后再接线。

### 敏感 metadata 修复

- 全部返回路径统一复用 ledger scrub 清洗 metadata；标签限长且拒绝凭据形状，不能只靠合法字符校验。
- source identity 标签非法或凭据形状时必须 unknown；不接受“只改成redacted但仍priced”。
- 独立8项红灯原报告保留，作者与独立用例合跑72/72，待独立复验；不改预算。
