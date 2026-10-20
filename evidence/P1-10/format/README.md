# 安全模块纯排版 ToSpec / ToTDD

依据：design/reviews/CODEX_BRIEF_BATCH3.md「可读性」明确要求 role-project.ts 与插件正常换行缩进、不改逻辑、单独提交；design/CODEX_SPEC_RESEARCH.md 保留角色 tool grants、危险动作拒绝、插件边界及上游版本锁定。

范围仅 services/control/src/bridge/openscience/role-project.ts 与 plugins/reinlab-os-plugin/index.js。使用临时固定版 Prettier 3.6.2，不修改package/lock、前端或上游。纯排版commit只含这两个文件；本证据由后续功能commit收录。

先记录基准revision与两文件原字节SHA256，格式化后记录新SHA256，并用TypeScript编译器解析TS/JS AST验证结构与语义标量等价（忽略源码位置、trivia与纯括号包装），另对注释内容做规范化比较，不能仅依赖git diff -w。解析错误或AST不等价均不提交。之后运行既有role-project与插件相关契约回归，不新增风险复现。

基准revision：24b44c11cc335938598adc44983ed4c04635d57f。

## 结果

独立纯排版commit：`179243692ed47097f0bed022e560f74acfd09274`，git show确认仅两文件。此目录未包含在该commit，供后续功能commit收证据。

`ast-equivalence.json`保存每文件前后字节SHA256和规范AST SHA256，两文件AST及注释均相同，0解析错误。TypeScript ContextFlags是解析上下文（如Prettier补括号造成AwaitContext标志差异），不作为语义；Const/Let、可选链等语义flag仍保留，真实AwaitExpression节点也保留。校验器四项仅内存敏感性检查（字面量、运算符、const→let、type-only import）都能识别差异；没有执行变更后的源码或新增风险复现。

既有role-project14项、插件直接hook特殊文件契约1项、共享契约87项，共102/102通过，机器报告tests.json。插件node --check和两文件git diff --check通过。未运行仍被D4修改的native evidence suite，避免覆盖其他agent证据。

复验：

```sh
export PATH=/Users/guangjieyu/.local/share/reinlab/toolchains/node-v22.23.3-darwin-arm64/bin:/Users/guangjieyu/.nvm/versions/node/v24.14.1/bin:$PATH
node evidence/P1-10/format/verify-ast.mjs
pnpm exec vitest run services/control/test/role-project.test.ts services/control/test/role-special-file.test.ts tooling/contracts.test.ts --reporter=default --reporter=json --outputFile=evidence/P1-10/format/tests.json
```

verify-ast.mjs比较固定的前后commit blob，不受后续功能修改影响。已请求另一agent独立复核，等待独立报告。
