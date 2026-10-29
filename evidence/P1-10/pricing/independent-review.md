# 定价修复独立复核

结论：通过；原独立发现的 8 项凭据形状 metadata 泄漏已关闭，未见剩余 P1/P2。

独立复跑 `deepseek-pricing.test.ts` 与 `independent-deepseek-pricing.test.ts`：72/72 通过，记录 `independent-green.json`。原 `independent-red.json` 保留，未修改生产实现。

源码复核：全部返回经统一 result→ledger.scrub，包含 unknown 与溢出路径；label 在字符/长度检查后拒绝凭据前缀及 scrub 会改变的内容。source id/session/message 同样经过安全 label 验证，非法身份返回 UNSUPPORTED_PART、费用 null。未知 provider/model/route、请求模型和价格版本也不再原样外返凭据。

独立边界覆盖 CNY/USD 原币种不同单价、固定汇率一次向上取整、其他路由 unknown，以及安全整数 token 的费用溢出 null。没有修改费用来源范围或放宽未知 provenance。

复验命令：`pnpm exec vitest run services/control/test/deepseek-pricing.test.ts services/control/test/independent-deepseek-pricing.test.ts --reporter=json --outputFile=evidence/P1-10/pricing/independent-green.json`，Node 22.23.3。
