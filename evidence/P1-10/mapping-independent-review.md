# Runtime mapping交叉独立评审

结论：**两个P2外返边界问题修复后通过本模块审查。** 独立Node22复跑作者50项+本人新增2项，52/52。原始red与修复后green分别为mapping-independent-red.json / mapping-independent-green.json。

## 独立有效发现及关闭

1. 初版只对payload做bounded，顶层usage.tier仍原样复制；100000字符的普通fixture tier使完整结果JSON达到109018字节。独立“all mapped fields remain bounded”有效失败。
2. 初版payload中的credential-shaped model被scrub，但顶层usage.modelId保留同一原文；独立fixture `Bearer fixture-private-mapping-value`出现在完整结果中。独立凭据外返断言有效失败。

作者修复后：metadataLabel先显式长度上限，再格式与scrub一致性验证；usage provider/model/tier不安全时置null并将usage标unknown，保留固定原因。usage与approval身份字段也做安全校验。最终对**整个返回对象**统一bounded+scrub，覆盖payload之外的投影；数值观察仍保持数值。本人只读确认修复，并独立复跑原2失败项已绿；没有改生产mapping、原测试或原red。

## 其余边界核对

- schemas覆盖ToSpec记录的26种可达RuntimeEvent，partSchemas覆盖13种Part；未知type/part、坏envelope/必要结构均返回有界error/unmapped_event，而非静默丢弃。
- 工具risk只取toolGrants自有属性；prototype/无grant不构成授权。映射记录工具观察，不执行工具、prompt或决定。
- 用量只从step-finish产生独立usage；缺失/坏计数、cost或provenance保留unknown，不补0免费；assistant累计消息不再产生第二份usage。mapper不计算CNY、不声称原生cost等于账单。
- 审批映射asked仅historical_pending，不从历史asked伪造当前可决定pending；replied/cancelled/rejected只是观察状态。恢复runtime.failed recovered=true明确interrupted。
- Card只在controlled server显式注入trustedP111Tools、工具已完成、非deny/danger grant、严格Card且tool-kind一致时映射；默认没有该信任集合。output/input文本不解析为卡片，file/patch/snapshot不虚构已完成artifact。
- bounded限制节点/深度/数组/字符串及完整JSON长度并处理循环；shared scrub用于所有外返值，输入不被修改。safe metadata长度短路避免先对无界长标签运行文本scrub。
- 该模块纯函数无SDK/网络/文件/模型/决定/计价副作用；后续observer的事务/cursor、fresh pending授权和冻结价格仍分别验收，不以本报告代替。

## 复验

```sh
export PATH=/Users/guangjieyu/.local/share/reinlab/toolchains/node-v22.23.3-darwin-arm64/bin:/Users/guangjieyu/.nvm/versions/node/v24.14.1/bin:$PATH
pnpm exec vitest run services/control/test/mapping.test.ts services/control/test/independent-mapping.test.ts --reporter=default --reporter=json --outputFile=evidence/P1-10/mapping-independent-green.json
```

作者原49项首轮全部通过而本人2项失败，证明新增边界不只是重复既有样例。修复后作者额外加入投影外字段回归，合计52通过。所有新增输入均为普通纯函数fixture，无真实key或资源，不产生新风险执行。

归档说明：作者早期证据位于evidence/P110/mapping，本次独立证据使用规范evidence/P1-10/；父任务最终收口应统一链接/目录，避免将路径拼写差异当作独立两轮验收。
