# P1-02 独立测试

最终结论：评审修复引用自签入口后通过。106 项检查全部通过、0 失败，其中独立正例和攻击/负例 97 项全部符合预期。实现自带的 schema 测试 87/87 通过，原前端测试 162/162 通过。

## 范围与环境

依据 `docs/tasks/P1-02.md`、`docs/questions.md` Q-009/010、实现规格 §5/§6/§9。只读实现；仅新增本报告和 `independent-test-report.json`，未修改业务代码、配置、测试实现或提交 Git，未读取凭据。

工作目录为 `/Users/guangjieyu/.codex/worktrees/research-foundation/ReinLab`，Node v22.23.3，pnpm 11.5.2，关闭登录 shell。实现、包清单、锁文件和开发者测试的快照哈希见 JSON。

## 执行结果

| 检查 | 结果 |
|---|---|
| `pnpm lint` | 通过 |
| schema 测试 | 1 文件，87 项通过 |
| contracts 严格 TypeScript 校验 | 通过 |
| 新增 contracts/tsconfig.json 的 CI 相同命令 | `pnpm exec tsc -p packages/contracts/tsconfig.json` 通过 |
| 原前端测试 | 20 文件，162 项通过 |
| mock 构建 | 通过；保留既有大包体积提示 |
| frontend-baseline SHA-256 | 250 文件全部一致 |
| contracts 运行时依赖 | 仅 zod 3.25.76，生产源码无 Vitest 导入 |
| 主进程覆盖率报告独立核读 | 行 42/42、语句 44/44、函数 3/3、分支 4/4，四维均 100% |

覆盖率由主进程执行，独立测试者读取 `evidence/P1-02/coverage/coverage-summary.json` 确认四维数值和行覆盖 ≥85%；没有将他人执行的覆盖率描述为独立重跑。

## 独立样本

17 个工具各使用完整有效输入验证通过，再在有效输入上注入未知 `approved` 字段，全部拒绝，避免以缺失必填字段冒充未知字段测试。

权限方面，RunToken 的 danger/admin/READ/write_all 授权均拒绝；风险标签及审批请求卡可解析 danger，符合“结构标签与执行授权分开”。审批仅接受 once/session，拒绝 always/project/account/global/大小写变体/空/null。令牌 grant、readScope 与顶层权限扩展字段拒绝，非法账户 UUID、非法记忆层拒绝。

精读输入顶层和条目 `verified:true`、引用内未知 `verified:true`、交付 `signedOffBy` 均拒绝。claim 缺引用拒绝，interpretation 无引用接受。初轮对规格明列的 `Citation.verifiedBy` 仅注明服务端需核实；随后独立评审发现写入入口也使用该输出结构，可接受自签来源。开发者新增严格 `CitationInput` 后，独立补测 finding_record、read_layer_write、swarm_deliver、swarm_refute 四个入口的 `verifiedBy:'self'` 全部拒绝，CitationInput 本身也拒绝；输出 Citation 按规格保留来源字段。这 6 项附加样本的完整输入和错误路径见 JSON，结果全部符合预期。

负结果区别验证：finding_record 即使 negative=true 也必须至少一引用，检索记录产物引用可通过；swarm.deliver negative=true 可无论文引用，但非空 summary 必填；negative=false 或未提供 negative 时无引用拒绝，空白 summary 拒绝。未使用关键词或字数冒充检索过程真实性判断。

JSON 深层字段中的 Infinity、-Infinity、NaN、undefined、函数、BigInt、Symbol、Date、Map 全部拒绝，正常嵌套 JSON 有限值通过。记忆升级无依据、未知目标、伪造 approved 状态拒绝；promotion approve 夹带 items 和 edit 缺 items 拒绝。追加预算的零、负数、非有限值拒绝；运行缺估算、未确认或注入 accountId 拒绝。

各样本的标识、期望、实际结果与 Zod 错误路径见 JSON `cases`。当前独立样本没有失败项。评审修复后重新执行 lint、87 项 schema 测试和严格 TypeScript 校验，均通过；前端 162 项测试、mock 构建和 250 个基线核对沿用本次任务初轮结果，此后仅修改 contracts 引用写入结构及其测试。

## 复现

```sh
export PATH=/Users/guangjieyu/.npm/_npx/52027bd8fc0022aa/node_modules/.bin:$PATH
pnpm lint
pnpm exec vitest run tooling/contracts.test.ts
pnpm exec tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution Bundler --skipLibCheck packages/contracts/src/index.ts
pnpm exec vitest run src
VITE_BACKEND=mock pnpm build
```

独立攻击通过 `node --import tsx --input-type=module` 导入 contracts 并逐一调用 `safeParse`，不修改生产包或添加 Vitest 依赖。

## 限制

按 Q-009，本轮只验结构，不将合法令牌视为已授权；角色/租户/档案范围、签发真实性、期限生效、引用真实性与检索过程真实性由后续服务端校验。Q-005 原有无头浏览器回归脚本未定位，本报告没有以 Vitest 代替其宣称通过。
