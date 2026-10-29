# Harness RunDefinition loader ToSpec

`createHarnessRunDefinitionLoader(db,{modelRoutes?}) -> (accountId,runId) => Promise<RunDefinition>`。仅返回 `{role,message}`，不能添加BindingStore strict不接受的metadata。所有查询在db.withAccount内，只读run→run_harness→bench_effective.snapshot→bench_version.registry；按account/dossier/run与bench/version/effective_digest精确join。核对snapshot摘要、bench/version与bundle摘要后verifyEffective、materialize，不读role_def作为权限事实源，不读取当前dossier tuning替代不可变run snapshot。

模型仅来自用户确认报价时永久绑定的run_harness.model_route；仅向materializer传当前角色tier→已存route，执行时不从环境或构造配置重新选择。历史null或非法route返回MODEL_ROUTE_UNBOUND409；无fixture/live默认路由。modelRoutes构造参数仅保留兼容，不参与执行路由。input中的model/prompt/grants/root不作为权限字段读取。message使用非空trim question，否则canonical(input)，最多1000000字符；limits.maxSteps仅1..role.steps收紧。

root已确认记忆规则：L1新run无ownthread，一律不读；L2仅当前dossier且thread_id null；L3/L4仅当前account全局、dossier/thread均null，并与effective role.memory.read取交集。revoked和存在任何supersedes后继的旧条目排除，不读取thread summary。refs=explicit未传memoryRefs时自动选上述允许条目，传UUID[]（包括[]）仅做ID交集收窄；不接受path。assigned-citations本批无验证引用解析器，memory固定空，待P1-15。记忆value/evidence为规范JSON，采用有界条目/总字节并在超限时失败关闭，不静默截断导致伪造完整上下文。

ToTDD仅fixture PostgreSQL与本地纯函数，不模型/外网/真实账户资源；先有效行为红，再实现，后独立复核。验证租户隔离、snapshot稳定、无旧role_def回退、server model route、所有memory scope边界及refs收窄、revoked/superseded、message与steps边界、坏快照/超大JSON拒绝。

## 实现/验证结果

已实现 `services/control/src/bridge/openscience/run-definition.ts`，当前路由固定来自migration011新增run_harness.model_route，无缺省模型或执行时env重选。SQL仅读select，不查role_def、当前dossier_override/bench_tuning或thread。根008已提供不可变run_harness绑定，loader不自行创建/修复绑定。

有效stub红灯8失败/0通过；最终10/10通过（fixture PG）。每批记忆最多128项，value规范JSON最多65536 UTF-8字节、evidence32768、整体131072，超限MEMORY_TOO_LARGE413并要求引用收窄；不截断。输入规范JSON及message上限1000000字符；非法refs/steps为INVALID_INPUT400，未绑定snapshot为HARNESS_SNAPSHOT_MISSING409，坏snapshot HARNESS_CORRUPT503，跨账户/不存在404。模型缺失/非法route为MODEL_ROUTE_UNBOUND409。control tsc/lint通过。独立复核待另一agent，作者不自批；未接main/API，不宣称完整P1-15 memory服务。


## P2确认报价route固定修复

独立审查指出首版执行时选择环境/构造路由，会让已确认报价的run在部署配置变化后换模型。保留原10/10报告为历史，不能视为覆盖此性质。root负责011与确认API将quote.model钉入不可变run_harness；loader仅SELECT读取并校验route，当前角色slot→tier仍由不可变effective决定，该tier的唯一route取已存值。未修改011/API。

新增有效route-red-final：7通过/5失败；修复后route-green：12/12。覆盖确认后server/env/config变化不改变两个不同run各自模型，input.model也不能覆盖；历史null不走fallback；数据库CHECK禁止非法插入，因此非法读行用test-only受控read adapter模拟验证loader仍拒绝。记忆scope未改变，control tsc/lint通过，待独立复核。
