# P1-09 SPIKE-1/2

研究已产出源码依据、实际HTTP实验和明确候选；验收方Claude确认仍待，未开始P1-10。

- SPIKE-1：runtime固定research，不接受agent。原规格default_agent回退不适用于该路由；mention是委托提示。旧session.prompt可选择agent但不替代runtime收据。候选为角色独立project覆写research定义，配置加载已实测，真实执行/隔离仍待后续及确认（Q032）。
- SPIKE-2：采用角色过滤的AGENTS.md，明确文件类型优先/全局/额外instructions；system与resolve上界不同，关闭项目配置不等于关闭全部目录说明。结论来自源码，不宣称noReply实验证明了system注入。

ToSpec→假设红灯：hypothesis-red.json记录真实runtime agent400，--require-runtime-agent退出1；文档/源码摘要测试的初始缺失红灯red-test-report.json保留。修订后真实npm二进制9/9探针，无模型调用；Vitest源码证据与SDK守卫6项；完整上游11文件SHA核对0变化。独立测试/评审报告另列。没有为了假设成立修改上游。

复现：
```sh
node tooling/spikes/openscience-probe.mjs --require-runtime-agent # 预期exit1，失败假设
node tooling/spikes/openscience-probe.mjs
node tooling/spikes/verify-upstream.mjs /Users/guangjieyu/Documents/DeepSeekPlugin/OpenScience
pnpm exec vitest run tooling/spikes/spikes.test.ts
```

源码仅用于阅读/查接口；source-excerpts.json是Apache-2.0研究摘录，不导入或执行，CI校验其完整性及已安装SDK。完整源哈希复核单独显式运行，不跳过却声称已验。noReply消息只有user，不能当模型生成、记忆注入、工具权限或跨档案安全验收。前端与内核均未改。

独立最终：真实探针9/9（失败假设模式按预期exit1），证据与实际三包版本守卫6/6，完整源码11/0，4摘录内容/行号/摘要一致，独立评审通过；全仓636/636通过。类型、边界及mock构建结果见本轮复核。
