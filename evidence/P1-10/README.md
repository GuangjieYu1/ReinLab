> **最新：第二次授权的真实冒烟与专用key核账均成功。** 真实转发1，回复“链路已通”，run completed、usage已知、hold settled；费用¥0.002766，后台与账本误差0%。见[第二次真实证据](real-smoke-second-authorization/README.md)。第一次unknown费用与两次marker均保留。待Claude关闭审查，未进入P1-11；工具自动读取敏感弹窗事件已如实记录Q-067，不宣称全程无凭据暴露。最新CI终态见PR #16。

> **最新：B-6/B-7/B-8已修复并提交，第二次真实冒烟尚未执行。** Node22/24各1347/1347、独立安全35/35；[第二次计划](thinking-fix/SECOND_SMOKE_PLAN.md)等待用户重新明确授权。第一次失败和unknown费用仍保留，P1-10未关闭，未进入P1-11。最新证据索引：[thinking-fix](thinking-fix/README.md)。下文第一次失败状态为历史记录。

> **2026-10-22 最新状态：P1-10保持未关闭。** 已获用户确认并执行唯一一次真实转发，但DeepSeek返回400，usage未知、预算unpriced，未重试。临时配置清理完成。见[真实失败与账本证据](real-smoke-execution/README.md)。此前“未执行/等待确认/TODO”的文字是过程快照，由本状态及下方最新记录取代。未进入P1-11。

# P1-10 第三批送审草稿

**P1-10保持未关闭，当前等待用户确认 [唯一真实冒烟计划](interim/SMOKE_PLAN.md)。** B-1与B-2已修复并分别提交；真实请求与后台账单核对完成后才正式送Claude，不进入P1-11。

首个角色PR的完整原始README已按字节保存在 [README-role-first-pr.md](README-role-first-pr.md)；旧714/714与旧ci.json只属于该历史范围，不作为本轮最终结果。操作与复验见 [HANDOFF.md](HANDOFF.md)。红灯、修复及历史失败均保留。

## ed91225 时点的本地结果（历史基线）

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Node22.23.3 / pnpm11.5.2全仓 | **1256/1256，0失败、0跳过** | [final-node22-current.json](final-node22-current.json)、[metadata](final-node22-check.json) |
| Node24.14.1兼容全仓 | **1256/1256，0失败、0跳过**；项目目标仍Node22 | [final-node24.json](final-node24.json)、[metadata](final-node24-check.json) |
| 类型/lint/mock构建 | 已有通过记录；最终提交后CI再核 | [final-independent-static.json](final-independent-static.json)、[限定独立复核](closure-independent/review.md) |
| 本地完整Supabase/真实账户容器 | **9/9**，本轮两镜像升级applied2，具名卷/凭据信封保留，重启保留 | [local-infrastructure-final/local-integration.json](local-infrastructure-final/local-integration.json) |
| T-REG新版用户前端基线 | **18/18**，原17+新增live；源/目标逐字节一致 | [baseline-refresh review](../T-REG/baseline-refresh/review.md)、[report](../T-REG/baseline-refresh/report.json)、[final hashes](../T-REG/baseline-refresh/final-verification.json) |
| HTTP/Harness/pipeline定向 | HTTP13 + pipeline7 + decisions32 + budget34 + store3，**89/89** | [runtime-http-README.md](runtime-http-README.md)、[report](runtime-http-related-green.json) |
| 最终原生fixture闭环 | 作者pipeline option1/1；独立observer修复后native **1/1**，provider1、usage1/unknown、hold unpriced | [作者最终报告](pipeline-native-option-green.json)、[独立时序/原生复核](observer/independent-race-review.md)、[独立native](observer/independent-native-green.json) |
| 单次真实冒烟护栏 | 独立纯测试 **49/49**；**真实尚未执行** | [guard review](observation-independent/smoke-guard-review.md)、[report](observation-independent/smoke-cleanup-final-green.json) |
| gateway来源契约/canonical | 新来源契约与精确canonical独立通过；不部署网关 | [usage-source/README.md](usage-source/README.md)、[review](usage-source/review.md) |

所有全仓/native fixture测试均无真实模型调用。fixture估算价格不作为实际模型账单；unknown没有按0免费入账。Node22旧1250结果保留为历史，以current1256与metadata为准。

## D-3 / D-4 / 观察1～2关闭依据

- **D-3关闭：** 首实现commit7cc117f，生产默认delegation:false；仅NODE_ENV=test的显式参数可打开，两状态均强制task并证明task:deny无子会话。实际SDK输入与严格body回归见 [D-3独立评审](../D-3/review.md)；初始缺steps的setup失败另存，未冒充有效红。
- **D-4关闭：** 默认动态证据只写唯一临时目录，只有REINLAB_EVIDENCE_OUT明确归档；race父子读本次独立报告，不读旧绿JSON。独立核303历史归档不变，默认76/76、显式72/72见 [D-4/review.md](D-4/review.md)；最终全量未设置OUT（metadata evidenceOut:null）。
- **观察1关闭：** 真实PG+原生fixture验证控制面重启、在途重放、内核重启均拿原receipt，全部provider调用各1、异内容409。持久session/request/send intent，未知只snapshot不prompt。见 [run-bridge-green.json](run-bridge-green.json)、[独立评审](run-bridge-review.md)、[binding独立](binding-independent/README.md)。
- **观察2关闭：** 纯排版commit1792436仅role-project.ts/plugin，AST/注释等价、灵敏度校验、独立102/102见 [format/review.md](format/review.md)。后续安全新模块亦已正常排版，未为动态loader新增泛化lint豁免。

## 本批实现范围与独立索引

角色准备固定/data与正式全局插件，版本化AGENTS及三受管文件；runtime固定requestID/持久session；26event/13part映射；只读observer/scheduler与事务cursor/ledger/usage；显式用户决定/取消；实际原生币种定价与unknown结算；生产factory、不可变Harness RunDefinition及HTTP/main/localbootstrap接线。

- 角色/远端权限：[首轮评审](review.md)、[remote](remote-role-review.md)、[factory](production-factory-review.md)。
- mapping：[独立52项](mapping-independent-review.md)。早期作者归档保留`evidence/P110/mapping/`原拼写，属于同一模块历史，不当两轮独立验收；未移动或重生成。
- observer/事务/费用：[观察评审](observation-independent/review.md)、[sink评审](observation-independent/sink-review.md)、[结算评审](observed-settlement/independent-review.md)、[定价](pricing/independent-review.md)、[决定](decisions/independent-review.md)。晚到priced step及历史reply P2修复绿灯、原红均保留。
- 时序根因：旧snapshot可能落后于replay已提交cursor，或把新终态当缺历史结算。现replay后fresh snapshot；latest落后拒回退，等于cursor才synchronize，超前则subscribe补齐真实事件。三轮原生红保留，独立纯竞态30/30与修复后原生1/1见 [independent-race-review.md](observer/independent-race-review.md)，不再标为未关闭。
- pipeline/HTTP：[runtime-http-README.md](runtime-http-README.md)、[pipeline](pipeline-README.md)、[main/guard/observer限定独立](closure-independent/review.md)。本人作者范围没有自批，最终独立结论见对应review。

### Harness T-HAR-1 / 2 / 5 / 10

- **T-HAR-1：** bench schema/安全loader、严格YAML与普通引用/hash、wildcard/task/danger安全floor。真实research YAML迁出已审查十角色，工具risk通用registry，planned不伪装已执行。独立101/101见 [manifest review](harness/independent-review.md)。
- **T-HAR-2：** tighten直接生效，任何loosen先proposal，用户approve后CAS应用并写harness.loosen；cap、旧override、并发及HTTP幂等均回归。见 [resolver](harness/independent-resolver-review.md)、[store](harness/independent-store-review.md)、[API](harness/independent-api-review.md)。
- **T-HAR-5：** 同版本内容/prompt/registry摘要不可改；bench_version与effective只追加、租户约束，run_harness固定版本/有效摘要/确认model_route；运行不回读当前role_def授权。见 [store](harness/independent-store-review.md)、[RunDefinition](run-definition-review.md)。
- **T-HAR-10：** actualresearch10角色materialize生成合法project；克隆真实bench仅为两角色添加测试read allow，loader→effective→materialize→原生project，五类核心边界保持。独立原生4/4见 [materialize review](harness/independent-materialize-review.md)、[native](harness/independent-native.json)。

## 执行前 TODO 快照（历史，当前状态见文首与末节）

1. **TODO 真实模型：** root将在代码安全扫描/提交后执行唯一一次≤¥1真实DeepSeek冒烟；目前护栏49绿不是实跑。补真实Auth/API→原生→事件→账本→费用报告、实际模型名与次数、临时配置清理结果。不得因未知/失败重发；marker或已保存RUN_KEY存在即禁止再次尝试。
2. **TODO 后台账单：** 只读DeepSeek账单与本次usage/原币种/价格窗口/FX核对。没有实际核对前providerInvoiceReconciled必须false；不能把wallet估算差值或fixture价当账单证明。
3. **TODO CI/PR：** 当前最终code commit/PR链接、所有CI run终态及artifact摘要尚未填；包括遗留run39279672175。旧 [ci.json](ci.json) 属首PRdf7a3bc/run39277895313历史，不作为当前head结果。
4. **TODO 最终证据补齐：** 真实步骤之后更新本README的状态与确切报告链接；若后续代码变化，说明最终1256报告覆盖的源码范围并做必要增量验证。待Claude确认后停止。

本批唯一执行确认点为上述冒烟计划；已有questions按既定scope保留。Fly/Supabase东京**云端补验**未完成；不宣称云SLA。P1-11工具业务/多文件受控编辑、P1-15完整检索与assigned-citations授权、P1-13无人访问全局主动恢复/Hatchet未实现。当前只恢复已认证账户已accepted运行的观察，不自动提交queued或重发未知模型。

`closure-draft.md` 是较早核对快照，保留当时发现过程；本入口与最新独立race复核已更新“独立原生红→修复后绿”状态，不以早期草稿旧状态覆盖新证据。

## 2026-10-22 中期审查收口

- B-1：42bbcd8，旧catalog别名过滤的原生红灯已修；产品路由不变，SDK显式API id映射同一Flash模型，并在prompt前检查实际可用配置。作者35/35、独立安全40/40，证据 [B-1](interim/B-1/README.md)。
- B-2：090d2fd，resolver强制tunable；未列字段400且事务无副作用。原研究台白名单未扩大；通用测试使用独立明示可调的测试清单。作者33/33、独立边界21/21，证据 [B-2](interim/B-2/README.md)。全量中两处旧run-definition fixture沿用未开放字段，已改为另行发布的测试版本，原隔离断言保留。
- B-3：目录骨架与授权写目标的区别已记录Q-063；本批不声称planned工具已物化目录。
- B-4：已查官方空闲/高峰规则与CNY价，Codex负责时间换算；[计划](interim/SMOKE_PLAN.md)等待用户确认。原前置失败提供方0请求不能算真实冒烟通过。
- B-5：实现小步分别提交；本轮统一整理红绿报告和历史证据，保留全部原始失败。

上表1256结果为ed91225已通过基线，不冒充中期修复后最终全量；修复后的结果在interim/归档并将在确认计划前更新。CI历史/本轮已核终态在[ci-terminal-index.json](ci-terminal-index.json)，最新head以PR描述为准。

中期修复后最终回归：**Node22与Node24各1284/1284，0失败、0跳过**，详见[interim/regression](interim/regression/README.md)。真实SDK请求也已在两版本上通过单次守卫到达本机fixture，均1/1；此链不读取真实key/不调用DeepSeek。未改变任何timeout、断言、RLS、沙盒或引用校验。

## 2026-10-22 用户确认后的唯一真实执行

真实冒烟 **0通过/1失败**，provider forward=1；HTTP400（reasoning_content），用量未知，不按免费结算，不再发第二次。报告、事件JSONL和对账状态见[real-smoke-execution](real-smoke-execution/README.md)。前置零转发基础设施失败也原样保留，不冒充已发送或成功。

B-1/B-2修复与两版本1284/1284、T-REG18/18既有结果保持；本轮只补文档/原始证据，无生产实现改动。最终提交的CI终态见PR #16描述；P1-10因真实冒烟及对账未通过仍不可关闭。

后台已等5分钟后只读导出核对，但只有小时聚合且存在其他调用，本次400又无usage，**未对平**；金额/误差率留空，见[billing-readonly.json](real-smoke-execution/billing-readonly.json)。
