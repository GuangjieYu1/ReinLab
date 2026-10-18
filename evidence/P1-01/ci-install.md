# 远端 CI 安装修复

首次远端 PR 检查在安装阶段失败：`ERR_PNPM_IGNORED_BUILDS`，未审批 esbuild@0.25.12 与 sharp@0.32.6 的安装脚本，测试未执行。此前本地用了 ignore-scripts 安装，因此没暴露这一点。

修复：按 pnpm 11 官方 allowBuilds 配置，按精确版本明确批准这两项既有依赖的构建；保留 strictDepBuilds 默认约束，不全局放行、不跳过 CI 安装。

资料：https://pnpm.io/settings/build#allowbuilds；另外核对本机锁定 pnpm@11.5.2 的 createAllowBuildFunction，确认支持 name@version 匹配。

复验：全新 node_modules 下 `pnpm install --frozen-lockfile`、lint、测试、mock build；远端 CI 结果随后记录。

## 独立复验

2026-10-19，在 `/Users/guangjieyu/.codex/worktrees/research-ci-fix/ReinLab`，Node v22.23.3、pnpm 11.5.2、关闭登录 shell，独立执行以下命令：

```sh
export PATH=/Users/guangjieyu/.npm/_npx/52027bd8fc0022aa/node_modules/.bin:$PATH
pnpm lint
pnpm test
VITE_BACKEND=mock pnpm build
```

结果：3 项命令检查全部通过、0 失败；Vitest 21 个文件、207 项测试全部通过；mock 构建成功，仅保留既有包体积提示。只读确认 `allowBuilds` 仅包含 `esbuild@0.25.12: true` 和 `sharp@0.32.6: true`，没有宽泛放行。

独立测试未重复删除 node_modules 或执行全新安装；全新 frozen install 成功记录来自开发者的独立步骤。本次测试仅确认其安装结果上的 lint/test/build 可运行，不将本地结果替代远端 GitHub CI 结论。未修改配置或业务代码。

## 全仓扫描修复最终独立复验

开发者补充根目录递归扫描后，独立重跑 lint 成功，Vitest 21 个文件、209 项测试全部通过。另在系统临时目录分别生成 `tooling/escape.ts` 和根 `escape.ts`，内容均为 `import x from '@synsci/sdk'`；通过真实 Node 子进程运行修复后的 CLI，两个样本均返回退出码 1 和对应 `禁止依赖 @synsci/sdk` 错误。临时目录已清理，无业务或配置改动。

本轮 4 项检查（lint、全套测试、两个 CLI 恶意样本）全部通过、0 失败。构建沿用上轮独立成功结果；本轮仅更改边界扫描器和其测试，前端/依赖未变，按任务要求未重复构建。

## 独立评审结论

结论：**通过最小修复评审。** 本次配置差异仅增加 `allowBuilds` 的 `esbuild@0.25.12: true` 与 `sharp@0.32.6: true`，两项均与既有 pnpm lock 的精确版本和 integrity 对应；未改依赖 / lock、CI 命令、前端或测试。

独立读取本机锁定 pnpm 11.5.2 的实际实现（`dist/pnpm.mjs`）：`createAllowBuildFunction` 按 `name@version` 精确匹配；未在 allowBuilds 中列出的包返回未审批状态。默认配置 `strict-dep-builds: true` 维持开启。未使用 dangerouslyAllowAllBuilds 或 ignore-scripts 关闭保护。配置因此只批准既有构建所需的两个脚本，不会随未来版本自动放行。

此处只确认配置语义和修复范围；全新安装 / Linux 原生 sharp 构建及远端 GitHub CI 的实际结果以相应运行记录为准，尚不能由只读评审替代。后续升级这两个依赖时应同步重新核查脚本并更新版本批准。本评审只追加本文件，没有改配置或提交 Git。

## 全仓扫描补充复审

结论：**通过。** `checkWorkspace` 由四个固定源目录改为从仓库根递归扫描，根 package.json 随遍历统一检查，既有 SDK / 依赖判定逻辑未改变；仍排除 node_modules、dist、.git、evidence。原来藏在 tooling 或仓库根的直接 SDK 导入因此进入与 CI 相同的检查入口。

两个新用例在真实临时目录写入 `tooling/escape.ts` / `escape.ts` 后调用 checkWorkspace，均被拒绝，并在 finally 清理。独立运行边界测试 **47 / 47 通过**，全仓 `pnpm lint` 通过。未发现此次范围扩展引入的阻断问题；本结论仅审查静态架构扫描覆盖，不扩展为运行时安全验收。仅追加本报告，未改实现或配置。
