# DeepSeek 实际 step 用量定价

结果：Node **v22.23.3** 定向测试 **55/55 通过**；control `tsc --noEmit`、`pnpm lint`、`git diff --check` 通过。先红报告 `red.json` 为 **0/4**：已定义可调用接口的安全 unpriced stub 返回 null，四项正向金额契约失败；不是缺模块或导入失败。交叉检查后 `review-red.json` 为 48 通过 / 7 失败，涵盖非 BYOK 路由与不可入账金额；修复后的最终报告为 `green.json`（55/55）。

实现与规格：

- `services/control/src/bridge/openscience/deepseek-pricing.ts`
- `services/control/test/deepseek-pricing.test.ts`
- `docs/tasks/P1-10-pricing.md`

## 接口

```ts
export const DEEPSEEK_PRICING_VERSION = 'deepseek-official-2026-10-20';
export type DeepSeekPricingContext = {
  currency: 'CNY' | 'USD';
  window: 'peak' | 'offpeak';
  usdCnyRate: '7.2';
  requestedModel: string;
  pricingVersion: string;
};
export type DeepSeekUsagePrice = {
  costCny: string | null;
  metadata: Record<string, JsonValue>;
};
export function priceDeepSeekUsage(part: unknown, context: DeepSeekPricingContext): DeepSeekUsagePrice;
```

输入完整原生 step-finish part：type/id/sessionID/messageID、usage.provider/model/route/time、tokens.input/output/reasoning/cache.read/cache.write。只按该 part 计价；不接受 assistant 汇总、数组或 response.model 补全。实际 provider 必须为 deepseek、usage.route 必须为 byok，实际模型白名单为 deepseek-v4-flash / deepseek-flash，请求路由必须为 deepseek/deepseek-v4-flash。

## 定价口径与证据

官方中文与英文价格分别核对，数值及链接保存在 `source-snapshot.json`：

- CNY offpeak cache hit / input miss / output：每百万 0.02 / 1 / 4；peak 两倍。
- USD offpeak：每百万 0.003 / 0.15 / 0.6；peak 两倍。
- CNY 原生计价不乘 FX，conversionApplied=false；USD 才精确乘固定 7.2。

来源为 [官方 CNY 价目](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)、[官方 USD 价目](https://api-docs.deepseek.com/quick_start/pricing/)、[官方缓存说明](https://api-docs.deepseek.com/zh-cn/guides/kv_cache/)。核对日期是该快照的检索日期，不冒充价目的历史生效时间。

全部金额运算为 BigInt；先汇总原币各分量，USD 再换汇，最后只向上取整一次到 microCNY。原生 input 已剔除 cache，故 cache.write 显式并入 input miss，cache.read 单独按命中价；cache.write 没有另编一个官方价或额外费率。output 已含 reasoning，reasoning 仅作为子集保存。这里的 cache.write 映射是明确的归类规则，不声称官方另有 cache-write 价。

只读核对原生 access-route.ts 与 processor.ts 的 finish-step：local 端点、OAuth 与 managed 网关先分类，直接 API 凭据才是 byok；custom 是另一解析器取不到模型时的 fallback。因此 managed/chatgpt/subscription/local/custom 均不按 DeepSeek API 现金定价，返回 UNSUPPORTED_BILLING_ROUTE。来源文件摘要与行号同见 source-snapshot.json。

每百万 input/output/cacheRead 各 100 万个 token 时，CNY offpeak 为 5.020000、USD 折 CNY 为 5.421600。单 token 的 USD 各分量合计折 CNY 为 0.000006，验证不逐分量舍入、不先将原币舍入。超安全聚合计数使用字符串保存，计算仍精确；但 cost 超过账本单笔 999999.999999 时返回 unknown / USAGE_RANGE_INVALID，避免无法入账。边界测试证明向上取整后恰好上限可接受，超出一个 microCNY 即拒绝。

metadata 包括计数来源/固定原生版本、part/session/message、provider 时间、请求与实际路由、计数与原生语义、价格币种/原单价/出处/版本、原币精确分数、汇率和是否换算，以及单次向上取整规则。不复制原始 payload 或原生 cost。未知用量、非法计数、全 0、来源/窗口/币种/版本不确定均 costCny=null，保留固定原因；没有将缺信息当免费。

函数不读系统时间、时区、节假日或环境，不推断价格窗口。调用方须提供可验证的当次窗口及价格版本并冻结入账，本函数只记录显式来源，不能替代该上游验证或 DeepSeek 后台账单核对。没有发真实模型请求，也未计 Search/Fetch 按次费用。

## 验证命令

```sh
export PATH=/Users/guangjieyu/.local/share/reinlab/toolchains/node-v22.23.3-darwin-arm64/bin:/Users/guangjieyu/.nvm/versions/node/v24.14.1/bin:/usr/local/bin:/usr/bin:/bin
pnpm exec vitest run services/control/test/deepseek-pricing.test.ts --reporter=json --outputFile=evidence/P1-10/pricing/green.json
pnpm exec tsc -p services/control/tsconfig.json --noEmit
pnpm lint
```

本次未修改既有 estimate、budget、ledger 或前端；尚待主任务交叉评审后接线。

## 独立评审 P2 修复

独立评审新增的 `independent-red.json` 保留原始 8 项敏感 metadata 失败。修复采用同一 ledger scrub 清洗每条返回路径的整份 metadata，并在输入标签层拒绝凭据形状和超长字符串；source part/session/message 身份同样受验证，非法身份必须 unknown，不能仅脱敏后继续 priced。

新增明确 cost=null 的源身份回归、短/嵌入凭据前缀和长标签边界。作者合跑自己的 62 项与独立 10 项，`credential-green.json` **72/72**。这是作者合跑记录，不替代独立复验结论；独立评审者随后单独复核。
