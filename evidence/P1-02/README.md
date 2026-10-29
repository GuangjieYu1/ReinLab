# P1-02 · 共享契约

范围：实现合同 §5/§9 的 Zod schema、共享类型及底座 API 入参；没有服务端或 OpenScience SDK 依赖。使用严格对象校验、有限非负数值、明确版本。令牌不可授予 danger，精读工具不能自填 verified，批准作用域只有 once/session。

ToSpec：`docs/tasks/P1-02.md`；先测未实现模块的红灯见 `red-test-report.json`。补全选择及负结果规则差异见 Q-009/010。

复现（Node22）：
```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm test tooling/contracts.test.ts --reporter=json --outputFile=evidence/P1-02/test-report.json
pnpm exec tsc --noEmit --strict --skipLibCheck --module esnext --moduleResolution bundler --target es2022 packages/contracts/src/index.ts
pnpm exec vitest run tooling/contracts.test.ts --coverage --coverage.include=packages/contracts/src/index.ts --coverage.reporter=json-summary --coverage.reportsDirectory=evidence/P1-02/coverage --coverage.thresholds.lines=85
```

限制：schema 验证结构，角色授权、引用真实性、检索过程真实性与令牌有效期由后续控制面校验。测试与独立审查结果另存本目录，未经通过不推进下一任务。

结果：87项schema测试通过；独立106项检查通过；严格类型检查、mock回归通过。V8覆盖率：行42/42、语句44/44、函数3/3、分支4/4，均100%。`CitationInput`与服务端`Citation`结果分开，四个写入口拒绝客户端自签verifiedBy。
