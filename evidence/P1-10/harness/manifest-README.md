# Harness manifest/schema 实现证据

范围：`packages/contracts/src/bench.ts`及index export、`services/control/src/harness/manifest.ts`、`benches/research.bench.yaml`、`prompts/research/`十文件、`tools/registry.json`、`test/bench-manifest.test.ts`。不修改root DB/API/budget/main/app/binding实现、package或lock，也不重写旧migration/旧prompt。

## ToSpec / ToTDD

依据与范围见 `docs/tasks/P1-10-harness-contract.md`。先写测试及最小总拒绝loader/任意schema占位，`manifest-red.json`12项9过/3失败：正向加载/引用hash、动态patch约束、真实十角色迁移确实失败，不是缺import/setup失败。实现后首轮 `manifest-green-attempt-1.json`11过/1失败为最初测试将“新增工具”一律拒绝，与T-HAR2放宽审批语义不符；校正为语法允许、root resolver必须registry校验并pending审批。所有历史报告保留。

当前 `manifest-contract-green.json`14 loader/schema回归+87共享契约，共101/101。strict tsc和boundary lint通过，正常排版后再次检查。无网络、模型、Docker、账户资源或secret读取；测试只读实际种子/提示词，临时fixture目录统一cleanup。

## 本批提供的保证

- T-HAR1覆盖wildcard/task/danger allow、write_targets越界及file/env引用拒绝，并有错误field path；其他路径形式、未知工具、缺entrypoint、schema extra、prompt模板也拒绝。
- YAML1.2严格解析，禁止重复key、显式tag、anchor/alias、prototype key、多文档；有结构/文件大小限制。
- 提示词/卡片schema/模板只从当前bench固定bundle目录读取；沿途普通目录、最终普通单link文件、NOFOLLOW/NONBLOCK、前后inode/realpath检查。无外部ref请求/逻辑执行。
- prompt真实字节、schema字节及registry内容都会改变bundle hash；不可只保留YAML hash。版本是否已发布及同版本冲突由root T-HAR5存储层判断。
- 真实迁移一致性测试对照旧SQL种子逐项验证十角色工具权限/registry风险、steps、write_targets、model tier、记忆scope，prompt原字节一致。旧数据无独立memory write scope，write=[]明确保守处理。
- 初始cards/MCP/engines/委托为空，未实现的业务工具availability=planned，不生成假工具/假schema。read五阶段来自批准的HARNESS示例；swarm/auto阶段未定，T-HAR6留后段。
- BenchPatch严格拒prompt/gates/steps和新增role/slot；工具新增只通过语法层，不能凭patch立即生效，root负责受信registry、放宽批准和ledger。effective配置必须再过assertBenchSafety。

## 固定接口

共享导出：BenchManifest、BenchRole、BenchBudget、ToolRegistry、BenchPatch、benchPatchFor、BenchPermission。

loader导出：loadToolRegistry(root?)；loadBenchBundle({root?,benchId,registry})；assertBenchSafety(manifest,registry)；BenchManifestError；LoadedBenchBundle={manifest,digest,prompts,referencedHashes,registryHash}。root是受信服务端/test入口参数，不接受用户run.input路径。实际默认根由模块import.meta.url计算。

T-HAR2真实proposal/版本/有效快照/ledger由root实现；T-HAR10由后续锁定native fixture用harness生成project重跑。本模块作者不自批独立安全评审结论。
