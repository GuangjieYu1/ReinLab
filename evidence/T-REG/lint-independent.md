# T-REG lint loader 独立验证

结论：**通过**。Node **v22.23.3**；`tooling/legacy-loader.test.ts` **3/3**，`tooling/boundaries.test.ts` **47/47**，合计 **50/50**；`pnpm lint` 输出“依赖边界检查通过”，退出码 0。

仅在独立工作树 `/Users/guangjieyu/.codex/worktrees/t-reg-lint-fix/ReinLab`、分支 `codex/t-reg-legacy` 操作。未修改 `tooling/boundaries.ts` 生产规则、原始 runner 或 17 场景；未在主工作树写入这些文件，未运行 E2E。

新增边界：在临时 workspace 先放置精确路径 `e2e/legacy/run.mjs` 的原始 runner，确认检查通过；再将完全相同内容复制至 `tooling/copied-runner.mjs`，确认三个动态导入全部被拒绝，原路径仍通过。此用例经 `checkWorkspace()` 整体扫描，证明 SHA 相同并不足以获得豁免，路径也必须精确匹配。

原有 loader 用例同时验证：修改 runner 后仍拒绝 SDK 字面量导入；更改函数名导致 SHA 变化后重新拒绝变量导入；其他生产文件的动态导入仍被拒绝。47 项边界回归保持通过，包含 SDK import/export/require、别名、编码 URL、计算加载器及前端/契约目录约束。

独立核对 runner SHA256：

```text
2614dbd898d96c9fad6366a94a15d36ddac486c610eb7b5ad34763a570b134b9
```

与主仓库 `/Users/guangjieyu/Documents/DeepSeekPlugin/ReinLab/e2e/legacy/run.mjs` 原始基线逐字节相同。

执行命令：

```sh
cd /Users/guangjieyu/.codex/worktrees/t-reg-lint-fix/ReinLab
PATH=/Users/guangjieyu/.npm/_npx/52027bd8fc0022aa/node_modules/.bin:$PATH pnpm exec vitest run tooling/legacy-loader.test.ts tooling/boundaries.test.ts --reporter=json --outputFile=evidence/T-REG/lint-independent-report.json
PATH=/Users/guangjieyu/.npm/_npx/52027bd8fc0022aa/node_modules/.bin:$PATH pnpm lint
```

原始测试报告：`evidence/T-REG/lint-independent-report.json`。未发现此次豁免扩大至其他路径、已修改 runner 或 SDK 字面量导入的问题。
