# P1-02 独立评审

最新结论（修复后复审）：**通过。客户端引用自签阻断已关闭，87 个契约测试和 lint 通过。**

以下保留首轮失败记录，最终复审见文末。

评审范围：`docs/tasks/P1-02.md`、实现规格 §5 / §6 / §9 / §10.1–10.2、`docs/questions.md` Q-009 / Q-010、`packages/contracts/src/index.ts`、包 exports / 依赖 / lock 和 `tooling/contracts.test.ts`。当前冻结快照只读评审；仅写本报告，没有改实现或提交 Git。

环境：Node v22.23.3，pnpm 11.5.2，shell login:false，指定 Node 22 目录置于 PATH 首位。

## P1：工具入参复用服务端 Citation，允许嵌套引用自签

位置：`packages/contracts/src/index.ts:21`、`:71`、`:81`、`:84`、`:89`。

`Citation` 将 `verifiedBy` 定义为合法可选字段，`ReadLayerWrite`、`SwarmTools.deliver/refute` 和从 Card finding 派生的 `finding_record` 直接复用它。对象 strict 只拒绝未知字段，不能阻止该已声明的服务端验证字段。

以下样本经实际调用均 `success: true`，解析结果完整保留 `verifiedBy: 'attacker'`：

```ts
const citation = {
  source: '11111111-1111-4111-8111-111111111111',
  locator: 'p.1', verifiedBy: 'attacker'
};
ToolSchemas.finding_record.safeParse({
  claim: '结论', citations: [citation], negative: false
});
ToolSchemas.read_layer_write.safeParse({
  paperId: citation.source, layer: 'method',
  items: [{ text: '结论', kind: 'claim', citations: [citation] }]
});
ToolSchemas.swarm_deliver.safeParse({
  taskId: 't1', summary: '结论', citations: [citation]
});
ToolSchemas.swarm_refute.safeParse({
  claimId: 'c1', reason: '反驳', citations: [citation]
});
```

P1-02 明确要求服务端拥有批准 / 签核权，客户端不能自填 verified。规格中的 Citation 带 verifiedBy 是合法的结果数据形状；它不意味着工具调用者可以提供验证身份。后续服务端仍需核实引用，但共享工具入参此时已混入不可信的验证声明，容易在存储 / 卡片展示中被误当服务端签核。

建议：分离严格的 `CitationInput`（只含 source / locator / quote）与服务端 `Citation`。所有客户端 / 模型工具写入使用 CitationInput；响应 / 经服务端生成的研究产出可继续包含 verifiedBy。`finding_record` 不应仅从允许服务端字段的 Card finding 直接 omit kind，而应覆盖 citations 的输入 schema。四个写入入口分别增加嵌套 verifiedBy 的负例，保留服务端结果含 verifiedBy 的正例。

## 已通过的检查

- 契约测试 **83 / 83 通过**，`pnpm lint` 通过；上述攻击样本超出现有测试覆盖，现有测试仅检查精读 item 上的 `verified`。
- contracts 仅运行时依赖固定 Zod 3.25.76，入口导出指向本包 TS 源文件，无服务端、SDK 或测试框架依赖。测试放在 tooling 符合纯依赖边界。
- RunToken grants 的风险取值只有 read / write；Risk 保留 danger 作为描述标签符合约定。
- ApprovalDecision 只接受 once / session；project / always 不在 schema 内。
- 写入 schema 使用 strict，未开放 accountId、signedOffBy 等未知权限字段；RunToken 具备账户 / 档案 / 运行 / 会话 / 角色绑定、读范围、写目标与到期字段。
- finding_record 要求引用，swarm_deliver 允许 negative=true 的无引用负结果；摘要 trim 后非空，与 Q-010 的结构 / 语义验证分工一致。
- 费用允许 null 表示未知；JSON 拒绝非有限数值与函数。

角色与租户授权、引用真伪、证据 / artifactRef 归属、令牌时效、预算分配与估算确认的一致性，依 Q-009 留给后续服务端验证；本评审未把结构合法误认为已授权。完整 mock build / 原有回归结果由独立测试报告提供。


## 修复后独立复审

结论：**通过，未发现未关闭的评审阻断项。**

新增 `CitationInput = Citation.omit({ verifiedBy: true }).strict()`；finding_record、read_layer_write、swarm_deliver、swarm_refute 四个输入入口均改用 CitationInput。finding_record 单独覆盖输入 citations，响应 Card 保留服务端字段，分离正确。

在同一 Node 22 环境独立重放首轮四个攻击样本，全部拒绝；`Citation` 与 finding `Card` 的服务端结果携带 verifiedBy 仍通过。契约测试 **87 / 87 通过**，lint 通过。4 个嵌套自签负例已纳入回归。

包 exports / Zod 唯一纯依赖、无 danger grant、批准 scope 限制及 Q-009 / Q-010 分工与首轮已通过结论一致。完整 mock build / 原测试由独立测试报告提供。本轮仅更新本报告，没有改实现或提交 Git。
