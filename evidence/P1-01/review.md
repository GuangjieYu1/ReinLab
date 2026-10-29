# P1-01 独立评审

最新结论（第五轮追加修复后）：**通过。本评审提出的阻断项全部关闭；45 个边界测试与 lint 通过，历史负例全部拒绝。**

以下“阻断问题 1 / 2”为首轮原始记录，保留用于审计；本轮状态与新样本见文末。

评审范围：`docs/tasks/P1-01.md`、`design/CODEX_SPEC_RESEARCH.md` §1、§2、§11–14、`tooling/boundaries.ts` 与测试、工作区 manifests/lock、两份 CI workflow。仅执行只读检查与内存样例，没有改实现或提交 Git。

环境：Node v22.23.3、pnpm 11.5.2，shell `login:false`，PATH 首项为 `/Users/guangjieyu/.npm/_npx/52027bd8fc0022aa/node_modules/.bin`。

## 阻断问题 1：只按模块字面名称分类，路径和 npm alias 可绕过 SDK / 前端边界

位置：`tooling/boundaries.ts:6–13`、`:32–35`。

`denied()` 仅对字面 `@synsci/sdk` 检查 SDK，未按解析后的包身份分类。`checkManifest()` 只读取依赖键，忽略 `npm:` 别名对应的真实依赖。以下调用均实际返回 `[]`：

```ts
checkSource('services/control/src/api/a.ts',
  'import x from "../../../../node_modules/@synsci/sdk/index.js"');
checkSource('services/control/src/api/a.ts',
  'import x from "/tmp/node_modules/@synsci/sdk/index.js"');
checkManifest('services/worker/package.json', {
  dependencies: { sdkAlias: 'npm:@synsci/sdk@2.0.150' }
});
checkSource('services/worker/src/a.ts', 'import x from "sdkAlias"');
checkSource('src/a.ts', 'import x from "/services/control/src/main.ts"');
```

这允许 worker / 非翻译层通过 npm alias 实际导入 SDK；前端也可通过 Vite 根绝对路径导入服务端源文件。路径例子的文件是否存在取决于安装结构，检查器在模块存在时仍完全不会验证其归属。配置别名（tsconfig paths / Vite resolve.alias）同样没有被纳入解析。

建议：按源文件所属工作区、规范化 / realpath 后的文件归属和依赖真实包名统一判定；解析 manifests 的 npm alias 与项目采用的别名配置。对于无法静态验证的绝对路径、别名或计算导入应明确拒绝。增加上述负例以及翻译层正常 SDK / 前端 contracts 的正例，确保 CLI 与 CI 使用同一解析器。

## 阻断问题 2：变形 require 和 loader 别名绕过“拒绝计算表达式”要求

位置：`tooling/boundaries.ts:25`。

只识别 callee 为直接 `require` 标识符或 `import` keyword 的调用。以下均实际返回 `[]`，即使参数明确是 SDK：

```ts
checkSource('services/control/src/api/a.ts', 'const x=(require)("@synsci/sdk")');
checkSource('services/control/src/api/a.ts', 'const x=module.require("@synsci/sdk")');
checkSource('services/control/src/api/a.ts', 'const r=require; r("@synsci/sdk")');
```

因此把已有 `require(name)` 改为 `(require)(name)` 就能绕过“禁止无法静态验证的模块导入”。在 CJS 文件中这些形式可实际执行；检查器也扫描 `.cjs` / `.cts`，不能依赖根项目是 ESM 消除风险。`createRequire` 产生的别名同样需要覆盖。

建议：至少剥离括号 / TS 类型包装、识别 `module.require` 与 `createRequire`，追踪或禁止 loader 被保存 / 传递 / 通过属性访问。对不能证明安全的 loader 使用采用拒绝策略；增加括号、属性、别名和计算参数组合测试。

## 已通过的核对

- `pnpm lint` 在指定 Node 22 环境成功；当前仓库中的现有直接导入无误报。
- 根前端保持原位，四个 workspace 成员 manifests 与 lock importer 齐全。
- 根直接 dependencies / 原有 devDependencies 的声明和锁定版本与当前 `package-lock.json` 一致；仅新增 `tsx`，没有发现前端直接包升级。
- `frontend-baseline.json` 中 250 个文件逐一重新计算 SHA-256，差异数为 0。
- research CI 使用 Node 22、frozen lockfile、同一 `pnpm lint`、Vitest JSON 报告和 mock build。Node 22 下 pnpm / tsx 可运行，未发现明确的 Node 22 兼容阻断。远端 GitHub Actions 未在本评审中运行。
- iOS workflow 已切换 pnpm，但 push paths 仍只有旧 `package-lock.json`，未包含 `pnpm-lock.yaml` / `pnpm-workspace.yaml`；建议补齐以免仅更新锁文件时漏掉 iOS 验证。这不是本任务的主要阻断项。

本评审不替代另一位独立测试 agent 的完整测试 / 构建报告，也不将尚未定位的既有无头回归脚本视为已通过。


## 第二轮独立复审

结论：**不通过，原问题修复有效，但两个残留绕过仍阻断 P1-01 完成。**

### 已验证的修复

在相同 Node 22 环境逐项实测：首轮相对 / 绝对 SDK 路径、npm SDK alias、`(require)(...)`、`module.require(...)`、`const r=require`、前端根绝对服务路径均从返回 `[]` 变为返回错误。新增 tsconfig 解析后的身份校验与源码符号链接拒绝逻辑已检查；边界测试 **31 / 31 通过**，`pnpm lint` 通过。

`@types/topojson-specification` 新增的直接固定版本为 `1.0.5`，与原 npm lock 对应包一致。再次计算前端基线全部 250 个文件 SHA-256，差异为 0。iOS workflow 的 pnpm lock / workspace 触发路径已补齐。

### 残留阻断 A（P1）：计算属性的 module.require 未受约束

位置：`tooling/boundaries.ts` 的 `visit()`，当前仅识别标识符 `require` 与字符串字面属性名 `require`。

实际调用及结果：

```ts
checkSource('services/control/src/api/a.cjs',
  'module["requ" + "ire"]("@synsci/sdk")'); // []
```

该语法在 CJS 可真实执行。只读运行 `module["requ"+"ire"]("node:path").basename("/a/b")` 得到 `b`，验证该计算属性确实可调用 Node 模块加载器。使用计算包名的 `module["requ"+"ire"](name)` 同样绕过本任务“拒绝计算表达式”的要求。

建议：至少禁止 `module` 的计算属性加载入口，或静态归一化计算属性、追踪加载器别名，并对无法验证的模块加载调用拒绝。补充计算属性与计算参数的组合负例。

### 残留阻断 B（P1）：编码 file URL 隐藏 SDK 包身份

位置：`tooling/boundaries.ts` 的 `sdk()` / `denied()` 与 TypeScript 模块解析回退。

实际调用及结果：

```ts
checkSource('services/control/src/api/a.cjs',
  'import("file:///tmp/node_modules/%40synsci/sdk/index.js")'); // []
```

Node 的 `fileURLToPath()` 对该 URL 返回 `/tmp/node_modules/@synsci/sdk/index.js`；当 SDK 文件存在时动态 import 可加载。正则未先解码 URL，而 TypeScript 不解析该 file URL 时返回 `undefined`，检查器就直接放行。前端已有通用 `file:` 拒绝，但非翻译层控制面 / worker 没有同等保护。

建议：对所有受控源文件拒绝未经验证的 `file:` 导入，或用 Node URL 规则解码、规范化后按真实文件 / 包身份验证；解析失败不能默认为安全。增加编码 `%40` 与普通 file URL 的非翻译层负例。

本轮只更新本文件，没有改实现、安装依赖或提交 Git。完整测试与 mock build 仍以独立测试报告为准。


## 第三轮独立复审

结论：**不通过，仍有一项 P1 阻断（module 加载器缺少统一约束）。**

已实测第二轮的直接 `module["requ"+"ire"](...)` 与编码 `file:` URL 均被拒绝。边界测试 **36 / 36 通过**，`pnpm lint` 通过。

但第三轮新增的规则只匹配特定 AST 形状，未形成针对全局模块加载器的统一约束。以下三项均在 `checkSource('services/control/src/api/a.cjs', source)` 实测返回 `[]`：

```js
(module)["requ" + "ire"]("@synsci/sdk");
let m; m = module; m["requ" + "ire"]("@synsci/sdk");
module.constructor._load("@synsci/sdk", module);
```

第一个只在第二轮样本的 `module` 外加括号；第二个把初始化改为赋值，绕过 `VariableDeclaration` 特判；第三个是 Node 的另一个实际加载入口。只读 Node 实测 `(module)["requ"+"ire"]("node:path").basename("/a/b")` 返回 `b`，`module.constructor._load("node:path",module).basename("/a/c")` 返回 `c`，证明不是无效语法。

建议统一处理全局 loader 的值使用：按词法作用域区分前端局部 `module` 绑定与 Node 全局 `module`，禁止全局 module 被取值、包装后计算访问、赋值传递或用于其他加载入口；或者明确收紧允许的源文件 / loader 形式。继续增加零散 AST 形状黑名单容易留下相邻变体。至少补充上述三种负例和前端局部 `module` 的正例。编码 file URL 的阻断已关闭。

本轮仅更新评审报告，未改实现或提交 Git。


## 第四轮独立复审

结论：**不通过，剩余一项 P1 阻断：process 别名可恢复模块加载器。**

第三轮三个样本（括号包装、赋值别名、constructor._load）现均返回错误；前端局部 `module` 变量与字段正例通过。边界测试 **41 / 41 通过**，`pnpm lint` 通过。全局 module 的词法绑定检查确实修复了对应问题。

但相同策略未覆盖另一加载器来源 `process`。以下在 `checkSource('services/control/src/api/a.ts', source)` 实测返回 `[]`：

```js
const p = process;
p["getBuiltin" + "Module"]("module")
  .createRequire(import.meta.url)("@synsci/sdk");
```

这能在指定 Node 22 的 ESM 模式实际执行：将最后 SDK 参数替换为 `node:path`，再调用 `.basename("/a/b")`，输出 `b`。并非仅限 CJS 或需要 eval 的理论样例。

建议把“全局 loader 来源”的规则统一覆盖未绑定的 `process`、`global`、`globalThis`：禁止全局对象作为值被赋值或传递，允许明确安全的直接属性访问（例如项目需要的 `process.env`）；对所有其余计算访问 / 包装访问拒绝。结合已有 module 词法分析，补充来源别名与计算属性组合的回归样本。继续只按 `getBuiltinModule` 标识符字面或 `process[...]` 直接形状匹配，无法覆盖该变体。

本轮只更新报告，未改实现或提交 Git。


## 第五轮独立复审

原 process 别名已被拒绝；边界测试 **44 / 44 通过**，lint 通过。

剩余 P1 是实现使用“危险属性黑名单”代替“安全属性白名单”，`globalThis.global` / `global.global` 在 Node 中仍返回全局对象，值可直接流出。以下 `checkSource()` 实测返回 `[]`：

```js
const g = globalThis.global;
const p = g["pro" + "cess"];
p["getBuiltin" + "Module"]("module")
 .createRequire(import.meta.url)("@synsci/sdk");
```

Node 22 ESM 模式将 SDK 替换为 `node:path` 并调用 `.basename("/a/b")` 实测返回 `b`。这属于本轮已声明处理的全局来源流出，静态检查仍可识别其来源，不需要运行时授权或污点沙盒才能处理。

建议改用按对象区分的真正安全属性白名单；当前四个扫描根内未找到必须保留的 process/global/globalThis 直接属性使用。对后续需要的 `process.env` 等可明确开放。不要把除列举危险属性之外的所有全局属性默认安全。


## 第五轮追加修复后的最终复审

结论：**通过，当前无未关闭的评审阻断项。** 本报告保留此前所有失败记录，便于复核红绿变化。

最终实现把全局来源属性从默认放行黑名单改成按对象的正向白名单；`module` / `global` 不允许直接属性流出，`globalThis` 与 `process` 只允许列出的标准属性。实测第五轮 `globalThis.global` 样本已拒绝。

在指定 Node v22.23.3 环境完成以下复验：

- 边界测试 **45 / 45 通过**；`pnpm lint` 通过。
- 单独重放历史 12 个源代码负例（相对 / 绝对 SDK 路径、括号 require、module.require、require 别名、计算 module 属性、编码 file URL、module 包装 / 赋值 / constructor、process 别名、globalThis.global），**意外放行数为 0**。
- SDK npm alias manifest 被拒绝。
- bridge 直接 SDK、前端 contracts、前端局部 module 变量三个正例均无错误。
- 已审查根 workspace / Node 22 CI / manifests / lock；前端哈希与直接依赖版本的核对结论维持上文通过。

通过结论覆盖 P1-01 的静态架构依赖约束与已声明扫描范围，不把 lint 当成 JavaScript 任意元编程或运行时授权沙盒。运行时权限与容器隔离由后续相应任务验证。本次未运行远端 CI；完整 mock build 与全部原测试由另一独立测试报告提供。

本轮仅更新本报告，未改实现、安装依赖或提交 Git。
