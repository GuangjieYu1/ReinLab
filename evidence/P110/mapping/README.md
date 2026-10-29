# Runtime mapping ToTDD 证据

完成范围：`mapping.ts`、`test/mapping.test.ts` 与 `docs/tasks/P1-10-mapping.md`。纯函数，无SDK/网络/文件/决定/prompt/计价操作；共享RoleRuntime和其他agent实现未修改。

## 红绿

- `setup-missing-module.json` 是最初模块缺失的setup失败，单独保留，不当行为红灯。
- `red.json`：先定义获准接口和总是返回unmapped的最小占位实现，49个行为测试47失败/2通过。26种event/13种Part及风险/用量/审批/卡片正向行为实际失败，不是缺import。
- `green-attempt-1.json`：实现后49/49通过。
- `green.json`：正常排版及补充diff坏结构、缺失usage、跨合法Card-kind检查后，本模块49/49 + 既有runtime-observation4/4，共53/53通过。后者包括父任务修复INVALID_ANSWER400的回归。
- Node22.23.3 strict tsc（mapping及测试）、依赖boundary lint、限定文件diff --check均exit0。只格式化本模块及其测试，使用本机已缓存Prettier3.6.2，未下载或改package/lock。

## 接口

导出 `mapRuntimeEvent`、`MappingContext`、`MappedRuntimeEvent`、`MappedApproval`、`RuntimeUsage`、`RuntimeTokens`、`P111CardTool`，供父任务observer/计价模块接入。

用量只来自step-finish，status为observed/unknown；缺失或坏计数/费用/model usage保存null与unknownReasons，不变为0；assistant更新不生usage，推理不额外累加output。upstreamCost仅上游原始计算口径，不是CNY或可信账单。价格和汇率不在本模块计算。

工具risk只读toolGrants自有属性。无grant/prototype名产生error/unmapped_event。pending映射只有历史状态，没有决定权。已知事件保留有界脱敏payload；字符串截断带TRUNCATED标记，节点/数组/深度/总长超限或循环结构以有界error诊断代替，不能使翻译无限递归。

P111尚未开始。只有trusted server显式注入五卡工具集合、tool完成、非deny/danger grant及metadata.data严格Card（且tool-kind对应）才产card；默认集合为空。output字符串和input不解析成卡片，file/patch/snapshot Part只记录观察信息、不伪造artifact完成。

## 复验

```sh
/Users/guangjieyu/.local/share/reinlab/toolchains/node-v22.23.3-darwin-arm64/bin/node node_modules/vitest/vitest.mjs run services/control/test/mapping.test.ts services/control/test/runtime-observation.test.ts
/Users/guangjieyu/.local/share/reinlab/toolchains/node-v22.23.3-darwin-arm64/bin/node node_modules/typescript/bin/tsc --noEmit --moduleResolution bundler --module esnext --target es2022 --esModuleInterop --skipLibCheck --strict services/control/src/bridge/openscience/mapping.ts services/control/test/mapping.test.ts
```

本模块作者不代替父任务后续独立评审；persisted observer的事务/cursor、用户审批fresh snapshot及真实usage恢复另行验收。没有运行真实模型、外网或账户资源，也没有读取secret。

## 独立外返字段发现与修复

独立评审发现原payload以外的usage.tier/modelId没有受同一bound/scrub保护，保留其原始 `evidence/P1-10/mapping-independent-red.json`。新增本模块usage unknown与approval身份回归后，`outer-fields-red.json` 为52项49通过/3失败；不覆盖原行为red。

修复：所有返回字段统一经过最终bounded+scrub，provider/model/tier采用最多200字的安全标签及scrub一致性校验；非法metadata置null、status=unknown并附unknownReasons。usage及approval外返身份也校验，不能在顶层绕过脱敏；原数值计数/费用保持numeric，不归0。标签在调用scrub前显式长度短路，避免对超长不合法字符串进入通用文本清洗。首次修复出现两项超时的报告 `outer-fields-green.json` 保留，修正后 `outer-fields-green-2.json` 52/52通过，strict tsc及boundary lint通过。最终独立批准由原评审者完成。
