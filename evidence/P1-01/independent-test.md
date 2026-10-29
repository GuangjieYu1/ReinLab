# P1-01 独立测试

测试者仅阅读实现，修改本报告及 `independent-test-report.json`；未修改业务代码、配置或提交 Git，未读取凭据。

最终结论：评审追加修复后的第六轮冻结快照通过。37 项独立检查全部通过，0 失败；其中边界攻击与允许样本 29/29 通过。历史结果保留在下文及 JSON 的 `history` 中。

## 环境和范围

- 工作目录：`/Users/guangjieyu/.codex/worktrees/research-foundation/ReinLab`
- Node v22.23.3，pnpm 11.5.2；命令运行时关闭登录 shell，并设置下述 PATH。
- 依据：`docs/tasks/P1-01.md`、`docs/questions.md`、`design/CODEX_SPEC_RESEARCH.md` §1、§12、§14。
- 检查器攻击样本通过直接调用导出的 `checkSource` / `checkManifest` 运行；另在系统临时目录建立最小工作区调用 `checkWorkspace`，随后清理，无工作区业务文件改动。

## 首轮发现与修复复测

首轮 `pnpm lint` 通过，Vitest 21 个文件、183 项测试通过，其中原前端 `src` 下 20 个文件、162 项通过。250 个前端源码和静态文件的 SHA-256 全部等于 `frontend-baseline.json`。

首轮 mock 构建失败：`HistoryLesson.tsx(4,51)` 的 `topojson-specification` 类型导入无法解析。旧 npm 锁将 `@types/topojson-specification@1.0.5` 提升到根，而前端未声明直接依赖。开发者补充相同版本的显式依赖后，独立重跑构建成功，前端基线无需修改。

首轮检查器漏报 6 类样本：相对 node_modules SDK 路径、`module.require`、`require` 别名、前端绝对服务端路径，以及前端和 control 清单中的 npm SDK 别名。开发者修复后，最初 14 个攻击/允许样本全部满足预期；再次运行 lint 通过，Vitest 193/193 通过，mock 构建通过。

第二轮增加以下 3 个恶意样本，均应拒绝，却返回空错误数组。完整输入与结果保存在 JSON 报告：

```ts
// file: services/control/src/api/a.cts
module['requ' + 'ire']('@synsci/sdk')
module[`requ${'ire'}`]('@synsci/sdk')
process.getBuiltinModule('module').createRequire(import.meta.url)('@synsci/sdk')
```

前两项直接违反“拒绝计算表达式绕过”；第三项使用 Node 22 的内建模块入口避开 `node:module` 静态导入检测。因此当前测试结论仍为失败，不能仅用现有 Vitest 全绿判定边界满足要求。

## pnpm 迁移核对

旧 `package-lock.json` 的 383 个不同 `package@version` 组合全部存在于新 pnpm 锁；新锁共 386 个，仅新增 `tsx@4.20.6`、`get-tsconfig@4.14.3`、`resolve-pkg-maps@1.0.0`。21 个原直接依赖的实际版本全部一致。类型依赖显式声明复用了原锁已有的 1.0.5，没有升级前端实际依赖版本。

## 复现

```sh
export PATH=/Users/guangjieyu/.npm/_npx/52027bd8fc0022aa/node_modules/.bin:$PATH
pnpm lint
pnpm test
pnpm exec vitest run src
VITE_BACKEND=mock npm run build
node --import tsx --input-type=module <<'NODE'
import {checkSource} from './tooling/boundaries.ts';
console.log(checkSource('services/control/src/api/a.cts', "module['requ' + 'ire']('@synsci/sdk')"));
NODE
```

第二轮独立检查 23 项：20 通过、3 失败；边界样本 17 项：14 通过、3 失败。原前端无头回归脚本入口未定位；本报告没有以 Vitest 代替它宣称通过。

## 第三轮复测

开发者修复第二轮的 3 项绕过后，原 17 个边界样本全部通过。独立重跑 lint 通过、198/198 项测试通过、原前端 162/162 项测试通过、mock 构建通过、250 个基线哈希一致。继续对计算入口做最小变形，发现以下两项仍返回空错误数组：

```ts
// file: services/control/src/api/a.cts
(module)['requ' + 'ire']('@synsci/sdk')
let loader; loader = module; loader['requ' + 'ire']('@synsci/sdk')
```

第一项只增加括号；第二项通过赋值而非变量声明建立别名。当前结果为 25 项独立检查：23 通过、2 失败；边界 19 项：17 通过、2 失败。结论仍为失败，已将具体事实通知开发者。

JSON 中的 `snapshot.sha256` 绑定对应实现和锁文件快照。后续修复必须重新执行失败样本并更新最终结论，同时保留上述失败历史。

## 第四轮复测

开发者改为词法绑定识别后，原 19 个边界样本通过。独立重跑 lint、203/203 项全套测试、162/162 项原前端测试、mock 构建均通过，250 个基线哈希一致。新增以下 TypeScript 类型擦除样本仍返回空错误数组：

```ts
declare const module: any;
(module)['requ' + 'ire']('@synsci/sdk')
```

`declare` 不创建运行时变量，因此该引用仍使用 CommonJS 全局加载器；检查器却将纯声明视为安全绑定。第四轮结论：26 项独立检查中 25 通过、1 失败；边界 20 项中 19 通过、1 失败。已通知开发者修复，并保留历史。

## 第五轮最终复测

修复冻结后，独立重跑 `pnpm lint`、`pnpm test`、`pnpm exec vitest run src`、`VITE_BACKEND=mock npm run build` 全部成功。全套 21 个文件、206 项测试通过；原前端 20 个文件、162 项测试通过。250 个基线文件再次核对无差异；旧锁的 383 个包版本组合再次核对全部保留。

先前 20 个边界样本全部复测通过；额外覆盖 process 别名、file: SDK、编码路径、type-only module、合法局部 module、合法 module 字段、正常 process.env 与 globalThis 定时器，新增 8 项全部符合预期。独立临时工作区还验证了 tsconfig 服务端路径别名和源码符号链接均被 `checkWorkspace` 拒绝，测试后临时目录已删除。

最终计数：36 项独立检查，36 通过、0 失败；其中边界样本 28 项全部通过。此结论针对所列依赖边界和静态攻击样本；未将检查器作为任意不可信 JavaScript 的执行沙盒验收。既有前端无头回归脚本入口仍未定位，仍保留 Q-005 限制。实现和锁文件的最终哈希见 JSON `snapshot`。

## 第六轮评审修复确认

评审另发现 `globalThis.global` 来源别名，开发者改用全局属性正向白名单并增加回归测试。独立再次执行 lint 和全套 Vitest，结果为 lint 通过、21 个文件 207/207 项测试通过。将以下新样本加入独立报告，并重跑此前所有攻击和允许样本，最终 29/29 符合预期：

```ts
const g=globalThis.global;
const p=g['pro'+'cess'];
p['getBuiltin'+'Module']('module').createRequire(import.meta.url)('@synsci/sdk')
```

第六轮最终合计 37 项独立检查全部通过、0 失败；JSON 已更新最终实现与测试文件哈希。前端构建、原前端 162 项测试、基线与锁版本核对沿用第五轮结果；本轮仅改边界检查器及其回归测试。
