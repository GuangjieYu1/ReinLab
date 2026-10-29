# P1-01 · 工作区、依赖边界、CI

当前阶段：本地开发、独立测试与评审通过；远端 CI 结果另记。全套 207/207；独立检查 37/37；边界单元 45/45；mock 构建通过。

- 原目录保持原有分支、索引与未提交文件。工作目录为独立 worktree。
- 交付前 162 项现有测试通过，mock 构建成功。`frontend-baseline.json` 记录 250 个前端 / 静态文件哈希。
- 基线备份留在本机私有目录，不包含凭据。P1-01 分支纳入现有前端运行所需文件，便于验收复现。
- 新增 pnpm 工作区（前端不移动）、Node 22、AST 依赖检查；CI 使用相同检查。
- 红灯见 `red-test-report.json`（检查器尚未实现）；绿灯见 `test-report.json`。

复现（Node 22）：
```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm test --reporter=json --outputFile=evidence/P1-01/test-report.json
VITE_BACKEND=mock npm run build
```

限制：既有无头回归脚本入口尚未定位，不能以 Vitest 代替它宣称通过；本任务不接入 live 数据、不运行模型。独立评审通过前不开始 P1-02。

原 npm 锁保留为迁移对照，安装与 CI 以 pnpm-lock.yaml 为准；`npm run build` 仍可使用。原直接依赖和 383 个旧包版本组合均保留，新增显式类型依赖用于修复严格依赖隔离暴露的问题。
