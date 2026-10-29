# 独立复核

结论：本次窄增量未见P1/P2。Node v22.23.3，契约6、canonical模型5、既有定价62、独立定价10，共83/83通过，详见independent-green.json。只运行本地纯函数测试；真实模型调用0、真实凭据读取0。

核对packages/contracts/src/usage.ts与index导出：严格数据envelope、嵌套严格对象、显式nullable计数/金额、不默认0、非负safe整数和精确十进制字符串。source仅数据来源标签，不作为认证、验签或费用可信性的证明；本次没有callback handler、落账、部署或网关调用。超过当前账本精度的原币金额可在纯数据契约中保留，未来入账接线仍须单独校验绑定/范围/去重，不能直接当EventInput。

定价仍要求实际provider deepseek、byok、请求deepseek/deepseek-v4-flash；仅增加精确实际模型DeepSeek-V4.1-Flash-1017，不扩展任意大小写/日期近似值、不从response猜模型。[官方价格页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)于2026-10-21核对：模型版本行和旧模型名转发说明支持此关系及Flash原生CNY价。source保持direct_provider_usage。

复验：设置Node22 PATH后执行`pnpm exec vitest run tooling/usage-contract.test.ts services/control/test/deepseek-canonical.test.ts services/control/test/deepseek-pricing.test.ts services/control/test/independent-deepseek-pricing.test.ts`。本次报告从同一次156/156定向组合运行筛选这四文件，未运行native。
