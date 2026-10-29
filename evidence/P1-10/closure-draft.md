# P1-10 收口草稿（非完成声明）

只读汇总；未运行新测试、native、容器或真实模型，未改生产。核对工作树 `codex/p1-10-translation-complete`，当前HEAD `0ebf5e7100bd7f3a075e209ea77e32c11e71e6e7`，大量后续实现仍未提交。不同阶段报告不能相加冒充同一最终提交的全量。此草稿须由root在最终复验后更新；尤其独立native当前红灯尚未关闭。

## 需要先明确的未完成项

1. **独立native闭环未通过。** 作者 `pipeline-native-option-green.json` 为1/1、provider1/usage1 unknown；独立 `observation-independent/pipeline-native-regression.json`、`pipeline-native-final.json`、`pipeline-native-diagnostic-report.json` 连续失败，ended_at等待30秒未完成。诊断 `observation-independent/native-diagnostic/independent-pipeline-diagnostic.json` 为provider1、DB accepted/running cursor6/usage0。不可用作者早先成功覆盖独立红。作者成功capture首个请求确为研究role/user标记，不是title/internal请求；失败方仅存model，暂不能比较完整body。docker_driver独占诊断中，本汇总不重跑native。
2. sink晚到priced step P2已有作者/独立 `late-step-final-green.json` 68/68，但 `observation-independent/sink-review.md` 与 `pipeline-source-review.md` 文字仍写待修；须审查者追加明确关闭及最终HTTP/原生结论，不能仅凭原始绿JSON宣布全部评审通过。
3. 最新P1-10生产路径在真实完整Supabase+账户容器上的验证尚无本轮证据；P1-08的真实基础设施9/9不替代新Harness/remote store/factory/API/observer全链。
4. 真实DeepSeek一次≤¥1冒烟、真实后台账单核对、最终Node22/24各全量、最终T-REG、当前候选CI与PR待完成。本文不读model credential、不请求模型，不自行扩大执行授权。

## D-3 / D-4 / 观察1～2逐项

| 项 | 本地状态 | 源码/测试与证据 |
| --- | --- | --- |
| D-3 生产默认关闭delegation | 已实现，独立限定评审通过；当前最终全量另待 | 首实现commit `7cc117f`；`docs/tasks/D-3.md`；`role-runtime.ts`；`delegation-default.test.ts`、`delegation-independent.test.ts`、`role-runtime.test.ts`；`evidence/D-3/review.md`、`red-test-report.json`、`test-report.json`。缺steps的setup失败另存，不冒充有效红。NODE_ENV=test开关与task deny双状态均留证。 |
| D-4 默认临时证据 | 已实现，独立限定评审通过；最终全量后仍应核归档SHA | `docs/tasks/D-4.md`；`test/fixtures/test-evidence.ts`、`test-evidence.test.ts`及race父子writer；`D-4/review.md`、`red.json`、`helper-green.json`、`default-regression.json`76/76、`explicit-regression.json`72/72、`archived-files-sha256.json`。当时303历史跟踪归档一致，只有显式OUT归档。 |
| 观察1 三类重启幂等 | 服务级真实PG+原生fixture三场景已通过；最终pipeline独立红另查 | `docs/tasks/P1-10-complete.md`、`P1-10-runtime-contract.md`；`binding-store.ts`、`run-bridge.ts`、`role-runtime.ts`；`run-bridge.test.ts`三个scenario（controller_restart/in_flight_replay/kernel_restart）；`run-bridge-green.json`3/3、`runtime-recovery-green.json`、`run-bridge-review.md`及独立4项。每个provider恰好1、同receipt、异内容409；未知提交只查snapshot。 |
| 观察2 安全模块纯排版 | 固定commit独立通过 | commit `179243692ed47097f0bed022e560f74acfd09274`，父`24b44c1`；仅role-project.ts/plugin/index.js；`format/review.md`、`ast-equivalence.json`、`verify-ast.mjs`、`independent-tests.json`102/102。AST/注释相等与灵敏度校验，不把后续功能变化混称纯排版。 |

以上是逐项已具备的关闭依据，不等于整个P1-10已关闭。旧 `evidence/P1-10/README.md` 与 `ci.json` 仍是首角色PR/df7a3bc的历史索引，714/714与旧CI不能冒充本轮全量。

## Harness批次边界

| 验收 | 当前证据/状态 |
| --- | --- |
| T-HAR-1 清单与安全floor | contracts `bench.ts`+harness/manifest.ts，真实research YAML、十prompt、tools/registry.json；`bench-manifest.test.ts`，`harness/manifest-contract-green.json`、`independent-regression.json`101/101，`independent-review.md`通过。拒wildcard/task/danger allow、越界路径、file/env模板、YAML别名/tag/重复/prototype及非普通引用。 |
| T-HAR-2 收紧/放宽审批 | resolver/store+007迁移，HTTP薄适配；`harness-resolver.test.ts`、`harness-store.test.ts`、两组independent及runtime-api.test.ts；`independent-resolver-review.md`预算cap P2已关闭，`independent-store-review.md`持久override cap P2已关闭；`independent-store-cap-decision-green.json`41/41（store9+decisions32）。HTTP callback/route三项P2见`independent-api-review.md`已追加关闭；最终runtime HTTP另由docker_driver复核。 |
| T-HAR-5 同版本不可改 | `publishBench`、bench_version/effective不可变触发器与RLS；store/manifest测试；`harness/independent-store-review.md`、`independent-store-cap-decision-green.json`、`store-client-transaction-green.json`。原始prompt字节/ref hash/registry纳摘要，改变内容须新version；不宣称跨云版本迁移完成。 |
| T-HAR-10 Harness生成角色 | materialize.ts，actualresearch10角色全部生成合法RoleProject plan；专用native bench从actualresearch复制，仅两角色加read allow用于越界读基线；`harness-materialize.test.ts`7、`harness-native.test.ts`4；作者`harness-factory-unit-green.json`14/14，独立`harness/independent-native.json`4/4及`independent-materialize-review.md`通过。覆盖五类核心边界，不把fixture或planned工具称live业务。最终pipeline独立问题仍单列。 |

`docs/tasks/P1-10-harness-contract.md`、`P1-10-materialize.md`记录限制：read五阶段为声明，swarm/auto精确阶段未完成；cards/MCP/delegation为空/不可执行，P1-11/完整P1-15/T-HAR后段不在本批完成声明。assigned-citations无验证器时记忆为空。

## 当前模块/测试/评审/文档索引

以下源码基准路径为 `services/control/src/bridge/openscience/`，测试基准为 `services/control/test/`，证据除注明外均在 `evidence/P1-10/`。

| 模块 | 源码与主要测试 | 评审/证据 | ToSpec文档 |
| --- | --- | --- | --- |
| 角色规划/版本/远端存储 | role-project.ts、project-authority.ts、remote-role.ts、infra/fly/account-entrypoint.mjs；role-plan/role-project/remote-role/account-role-store/role-special-file/role-system-race/independent-role.test.ts | role-plan-green、role-store-green、remote-role-green；remote-role-review.md、review.md（历史R1～R4） | P1-10-roles.md、P1-10-complete.md |
| SDK runtime读/恢复/决定边界 | role-runtime.ts；runtime-recovery/runtime-observation/role-runtime.test.ts | runtime-review.md、runtime-invalid-answer-review.md、runtime-invalid-answer-red/green；independent-runtime/ | P1-10-runtime-contract.md |
| 持久绑定/提交 | binding-store.ts、run-bridge.ts；binding-store/independent-binding-store/run-bridge/independent-run-bridge.test.ts | binding-independent/README.md、run-bridge-review.md、run-bridge-independent-red/green、run-bridge-green3/3 | P1-10-complete.md |
| 26event/13part映射 | mapping.ts；mapping.test.ts、independent-mapping.test.ts | mapping-independent-review.md、mapping-independent-red/green52/52；早期evidence/P110/mapping/ | P1-10-mapping.md |
| 只读observer | observer.ts；observer.test.ts27 | observer/README.md、observation-independent/review.md、observer-regression/final-green-report | P1-10-observer.md |
| observation事务/checkpoint | observation-store.ts；observation-store/independent-observation.test.ts | observation-independent/review.md（历史reply P2已关闭）、observation-store-red/green | P1-10-complete.md |
| sink/snapshot/late terminal | observation-store.ts.sink/failed/synchronize；observation-sink.test.ts | observation-sink/、observation-independent/sink-review.md、late-step-red/final-green68/68；最终文字待追加 | P1-10-observation-sink.md |
| scheduler | observation-scheduler.ts；observation-scheduler.test.ts8 | observer/scheduler-independent-review.md与green8/8、observation-scheduler/ | P1-10-observation-scheduler.md |
| 内部观测结算 | budget/index.ts.settleObservedRun；observed-settlement.test.ts31、旧budget34 | observed-settlement/independent-review.md、independent-regression65/65，setup红单列 | P1-10-observed-settlement.md |
| DeepSeek原生币种实价 | deepseek-pricing.ts；deepseek-pricing/independent-deepseek-pricing.test.ts | pricing/independent-review.md、independent-green72/72、source-snapshot.json；真实账单待验 | P1-10-pricing.md |
| 固定窗口配置 | pricing-environment.ts；pricing-environment.test.ts；run-bridge.ts.PricingWindowSnapshot | pricing/environment-red/green2/2、main-bootstrap-green57/57 | P1-10-pipeline.md、P1-10-pricing.md |
| 生产factory | production-factory.ts；production-factory.test.ts7 | production-factory-review.md、readonly-vault-red/green7/7；真实账户容器新链路待验 | P1-10-production-factory.md |
| Harness schema/loader/assets | packages/contracts/src/bench.ts、harness/manifest.ts、benches/research.bench.yaml、prompts/research/十文件、tools/registry.json；bench-manifest.test.ts | harness/manifest-README.md、independent-review.md101/101 | P1-10-harness-contract.md |
| Harness merge/store/API预算绑定 | harness/resolver.ts/store.ts、api/budget.ts、007/008/011；harness-resolver/store/api及独立test | harness/independent-resolver/store/api-review.md各历史P2及关闭；API quote模型固定 | P1-10-harness-contract.md |
| materialize/运行定义 | harness/materialize.ts、run-definition.ts；harness-materialize/run-definition/harness-native.test.ts | independent-materialize-review.md、run-definition-review.md（route P2已关闭）、run-definition-route-green12/12 | P1-10-materialize.md、P1-10-definition.md |
| 决定/取消 | decisions.ts、010迁移；decisions.test.ts32 | decisions/independent-review.md含validate前置关闭，validate-green、harness/independent-store-cap-decision-green | P1-10-decisions.md |
| pipeline/HTTP | pipeline.ts、api/runtime.ts、api/app.ts；pipeline.test.ts7、runtime-api.test.ts13、pipeline-native.test.ts | pipeline-README.md、runtime-http-README.md、runtime-http-related-green89/89；observation-independent/runtime-api-pricing-regression15/15；独立native三连红未关闭 | P1-10-pipeline.md、P1-10-http.md |
| main/localboot composition | main.ts、tooling/local/control.ts；api/local-independent/pricing-environment.test.ts | main-bootstrap-green57/57及独立main-bootstrap-regression；不等同真实本轮infra闭环 | root负责最终接线说明 |
| 测试证据目的地 | test/fixtures/test-evidence.ts；test-evidence.test.ts与各writer | D-4/README.md/review.md/verification.json | D-4.md |

003 os_binding、004 binding_identity、005 runtime_observation、006 observation_integrity、007 harness、008 run_harness、010 decision_delivery、011 run_model_route均已有本地fixture迁移/约束测试；不因编号缺009猜测应补迁移。真实Supabase新migration的兼容/权限/重启验收仍需最终本轮结果。

并行出现的 `runtime-smoke-gateway.test.ts`、`tooling/local/one-shot-smoke-guard.ts` 属root后续冒烟准备，本草稿不将未读最终报告的施工文件当已交付。gateway_callback接口与canonical model后续如有增量，须补本表及最终全量。

## 外部/整仓验收缺口与CI准备

- 本地基础已有 `evidence/P1-08-local/integration-final/local-integration.json` 与 `integration-repeat/local-integration.json`，真实Supabase/Auth/Vault/Storage/账户容器均9/9，modelRequests0；这是前阶段基础能力，不是新P1-10生产factory全链。应在当前候选镜像/root/data账户具名卷上复核受管project生成、exact plugin、Harness snapshot固定、真实Auth API→observer ledger、容器/控制面重启恢复，不扩大工具或展示密钥。
- 真实模型：现有native均test-only loopback，不能声称价格与DeepSeek后台账单吻合。待一次≤¥1真实冒烟、明确请求模型与实际模型、原币种/窗口/FX7.2、逐step用量、账本与后台账单证据；不满足真实性则unknown，不推算免费。Fly/Supabase东京云端属于已defer补验，需送审列明。
- Node22与Node24：已有多个定向绿与旧首PR714/714，但尚未找到当前工作树最终全量两份报告。需候选内容冻结后两版本各一次，附版本、命令、commit/source hash、passed/failed/skipped、默认证据归档SHA不变；不可把checkpoint95或HTTP89当全仓。
- T-REG：旧17/17见 `evidence/T-REG/report.json`；用户更新前端基线后 `baseline-refresh/review.md/report.json` 已18/18，源/目标字节一致见final-verification。早期live缺看板0/1报告保留，不覆盖。最终送审仍须本轮候选T-REG报告及基线无改证明。
- CI：`.github/workflows/research.yml` 现有check/account-image/local-stack，Node22，无Node24 matrix。静态存在不等于运行通过。`evidence/P1-10/ci.json`只证旧df7a3bc/run39277895313及D1旧run成功；本地证据未找到遗留run39279672175终态。root需只读查全部相关CI最终状态、headSHA、artifact及摘要（包括旧遗留run），不能用旧报告代替新commit。
- PR：当前HEAD是checkpoint且后续dirty；尚无本轮最终commit/PR/CI归档。需源码、迁移、文档、红绿/独立报告齐后提交，创建并附PR，等待本轮CI最终结论。本文不执行提交/远端操作。

## 目录/索引整理建议（仅建议，不移动）

`evidence/P110/mapping/` 是早期拼写，`evidence/P1-10/mapping-independent-*` 是后续独立复核，不能当两组独立实现。建议root在最终证据整理提交中选择一种：

1. 保留旧目录为历史，规范README加明确旧路径链接与同一轮映射说明；这是最小且无破坏的方案。
2. 若必须迁到P1-10/mapping，另做纯证据整理提交，先记录每文件SHA256，迁移后校验字节不变，更新所有docs/README/测试引用，旧位置留迁移说明；不重生成/覆盖红灯，不把目录整理与生产逻辑混为同一变更。

本任务只写closure-draft.md，没有移动、删除或改写这些归档。最终README宜增本轮章节或新索引，保留首角色PR的明确历史scope，避免旧714/714与新定向报告混读。

## 草稿后续窄增量记录

root另授权gateway_callback来源预留与官方canonical实际模型：新增contracts/usage.ts、index export、tooling/usage-contract.test.ts；deepseek-pricing.ts仅direct source enum实际使用与精确DeepSeek-V4.1-Flash-1017白名单，requested legacy route不变。公开官方来源与范围见usage-source/canonical-source.json及README.md、docs/tasks/P1-10-usage-source.md。有效红7过4败→170/170纯测试，contracts/control tsc通过；全仓lint当时有范围外smoke-local.ts施工阻断，待root最终复验。无网关handler/部署/native/model调用；独立复核交role_independent_test。此增量不关闭前述独立native失败与最终交付缺口。
