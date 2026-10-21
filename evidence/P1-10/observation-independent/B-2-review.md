# B-2 tunable 白名单独立安全复核

结论：本次增量未发现剩余 P1/P2，可收口 B-2。仅复核 tunable 边界，未执行完整测试、真实 smoke、模型调用或读取真实凭据；未修改生产代码。

## 范围与源码核对

- `planBenchPatch` 先通过 strict schema 和既有 role/slot 身份校验，再逐叶验证 tunable，随后才克隆、计算差异及生成 candidate。未列字段即使值相同、为空数组或空子对象也不能被无声丢弃。混合 patch 中任一未列叶字段使整个计划失败。
- 中间 `*` 精确匹配一个路径分段；末尾 `*` 明确授予已知 schema 子树，因此 `budget.*` 能覆盖 `budget.by_mode.read`，不绕过严格 schema 或工具危险权限 floor。未知、空或多重后缀无授权效果。
- `tighten_only` 延续本批已明确的既有审批合同：放宽仍产生 `requiresApproval`，不会自行生效；危险 task 权限仍由安全 floor 拒绝。它不是绕过 HarnessStore 审批的能力凭据。
- research 原清单保持 `model_slots.*`、`budget.*`、`roles.*.tools.*:tighten_only` 三项，本次 git diff 无清单变更。旧通用 write_targets / dossier_note 测试改用显式声明这些字段的独立封存 fixture，未放宽真实 research。
- HTTP patch 在 mutate 同一 DB 事务内调用 proposeClient，plan 成功之前不写 candidate/proposal/apply/event。复跑现有真实 PG HTTP 断言，拒绝后 proposal、override、event、http_request 计数均不增加，effective digest 不变。
- 顶层空 patch `{}` 保留现有内部有效配置预算复核用途；没有叶字段也不获得额外权限。本次拒绝空对象断言针对实际提交的字段/子树。

## 精准测试

新增独立 11 项：空 roles / role / tools 与未列空数组；未知、多重、空后缀与无效路径；中间 wildcard 邻字段隔离；同值未列数组与合法预算混合时整包拒绝且 base 字节不变；放宽需审批及危险工具 floor。

Node 22.23.3 命令：

```sh
PATH=/Users/guangjieyu/.local/share/reinlab/toolchains/node-v22.23.3-darwin-arm64/bin:/Users/guangjieyu/.nvm/versions/node/v24.14.1/bin:$PATH pnpm exec vitest run services/control/test/independent-harness-tunable.test.ts services/control/test/harness-tunable.test.ts services/control/test/harness-api.test.ts --reporter=json --outputFile=/tmp/reinlab-b2-independent-green.json
```

独立执行 3 文件 **21/21 通过**（新增11 + 作者8 + HTTP2），原始 JSON 复制为 `b2-independent-green.json`。作者修复前红灯 `/tmp/reinlab-b2-effective-red.json` 未覆盖；本次独立验证没有人为制造或复用旧失败。

## 被审查字节 SHA-256

- `services/control/src/harness/resolver.ts`: `d86af043fe3a9456ba5997cebc0fa6731920dcfc1c9a38522ec8551ea08df321`
- `services/control/test/harness-tunable.test.ts`: `bd584fca9fb3dafa177554ed869e63991a03194ff1cd41f1a3ac414f71c779c8`
- `services/control/test/independent-harness-tunable.test.ts`: `e47462cbbf49d40cdc1d65601350ee2cba4044bb13f637e5454d1c21a95858b9`
- `services/control/test/harness-api.test.ts`: `6993b82fb3d6c4aaf89d76edc7fb552d43392f400cf2b0b20d1667681804ad44`
- `services/control/test/fixtures/bench-tunable.ts`: `2378e2312c5827a1ef6dc7355735fefa4d28748013f1e07d40332d49b2422103`
- `benches/research.bench.yaml`: `92167eeb12e978d5779b30cb8164146b347a474a950d076b06ece7e90479e944`
