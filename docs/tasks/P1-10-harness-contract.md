# 第三批 Harness 研究合同与 ToSpec

依据：主仓库（`/Users/guangjieyu/Documents/DeepSeekPlugin/ReinLab`）`design/reviews/CODEX_BRIEF_BATCH3_ADDENDUM.md`、`design/HARNESS.md`、`design/ARCHITECTURE_BENCHES.md`第10/11节。补充说明优先于旧角色表开发方案。本批仅T-HAR1/2/5/10，不提前实现完整网关、P111工具、升级收件箱、泛工作台UI或其他工作台。

## 已查事实与迁移边界

主仓库及开发分支原本没有 `benches/` 或 `prompts/` 实际文件。可迁出事实源是已审查的 `infra/supabase/migrations/202610190002_roles.sql` 十角色及 `services/control/roles/*.md`：research-read、research-auto、swarm-lead/planner/scout/reader/analyst/critic/verifier/synth。迁出保持逻辑ID、提示词原字节、每工具权限/风险、write_targets、steps和模型档；旧提示词及已应用迁移保留兼容，不能重写旧migration。

原角色只定义记忆read_scope，没有独立memory.write声明。本批保留layers/current dossier/own messages/explicit或assigned-citations refs，write默认空，不猜写权限。未来P111再明确受工具审批约束的记忆写入。旧run没有own thread绑定时不能自动读其他同role历史L1。

门禁模块是通用状态机，但 `initializeGates` 当前没有生产调用，也没有研究台阶段配置可迁出。初始清单read五阶段从HARNESS明确示例声明为ingest/layers/qa/check/close，metadata标明这是新声明；swarm/auto精确阶段尚未定，不猜plan/run/report。entrypoints仍声明read/swarm/auto三个入口角色；只有read有初始阶段配置，不宣称T-HAR6已完成。

## 最小接口

- `packages/contracts/src/bench.ts`：共享zod `BenchManifest`、`ToolRegistry`、`BenchPatch`及类型；`benchPatchFor(manifest)`进一步拒绝新增role/model slot。strict patch不接受prompt/gates/steps等字段。新增工具属于潜在放宽请求，语法层不把它变成有效授权；registry校验、动态子集/放宽判定和预算上限由root有效配置模块处理。
- `services/control/src/harness/manifest.ts`：`loadToolRegistry(root?)`读取固定tools/registry.json；`loadBenchBundle({root?,benchId,registry})`只读固定benches/<id>.bench.yaml与固定bundle refs，返回 `{manifest,digest,prompts,referencedHashes,registryHash}`。root仅能由受信服务端/test注入，不接受用户路径。
- 清单必含 `entrypoints:{read,swarm,auto}`，各指向已声明角色，替换代码中的mode→研究角色三元表。模型通过model_slot→trusted tier/位置再解析，不从run.input接收模型、prompt、grants或路径。
- 工具risk来自通用受信 `tools/registry.json`，不在harness代码复制研究台名单。旧业务工具目前只声明契约，availability=planned，不生成假实现或宣称可调用；原生能力作为通用注册项。初始cards/mcp/engines为空、delegations两端为空，未来P111补真实契约及注册。本批不创建假schema文件。
- loader最后安全底线独立于清单和覆盖：*只能deny、task只能deny、registry风险danger不能allow（当前已批准Q002生成层更严deny不放宽）；write_targets纯相对档案内；任意file/env引用拒绝；prompt/schema refs只允许固定prompts/<bench>/、schemas/<bench>/，普通单link文件，拒symlink/hardlink/escape。
- YAML严格解析：禁止custom tag、alias/anchor、duplicate key与prototype key；拒多文档。错误提供有界field path，不回显敏感值。hash覆盖引用文件内容，不能只对YAML算hash而漏掉prompt变化。

root负责：真实DB版本/有效配置快照/只追加同版本hash约束，harness_proposal批准凭据及ledger `harness.loosen`；不将现approval表非空run_id强塞为档案配置审批。批准证明绑定账户/档案/基线digest/patch摘要及用户决定，客户端`approved:true`不是授权。

## 需替换/保留的后端清单

| 文件 | 改法/责任 |
| --- | --- |
| `services/control/src/api/budget.ts:22–25` | role_def model_tier读取及read→research-read/auto→research-auto/swarm→swarm-lead硬编码改查有效清单entrypoints+model slot；估算与提交同一有效配置摘要 |
| `services/control/src/budget/pricing.ts:28,44` | 当前strong隐式默认、read5/swarm30默认预算由harness参数传入；auto默认null保留需用户指定，不猜额度 |
| `services/control/src/api/app.ts:43–47` | 后续建档案接清单layout/已定义gate stages；不把完整T-HAR4升级生命周期冒充本批完成 |
| `services/control/src/gates/index.ts`、`api/gates.ts` | 保留通用actor/状态/修订/证据校验，阶段顺序从清单供给；无须将通用边表搬入研究专用代码。工具钩子门禁属于T-HAR6后段 |
| `services/control/src/bridge/openscience/binding-store.ts`、`run-bridge.ts` | 接受来自harness的版本化RoleProjectRequest及有效配置摘要，维持不可变绑定/发送意图；不另查旧role_def作为权限事实源。DB的role_def FK兼容投影不等于双事实源 |
| `services/control/src/bridge/openscience/role-project.ts`、plugin/index.js | 保留T-ROLE默认deny/task deny/路径/哈希/系统hook安全底线，harness复用planRoleProject/prepare及远端store，不复制弱化版生成器 |
| `services/control/src/bridge/openscience/mapping.ts` | 26事件/13Part协议映射为跨台通用协议；trustedP111Tools以后从有效清单和真实注册能力取交集。现固定5卡类型是既有通用Card协议，不能扩大为假P111执行声明 |
| `202610190002_roles.sql`、`services/control/roles/*.md` | 保留已应用迁移及旧文件；新增清单成为运行配置事实源，未来兼容role_def投影由新迁移/受信发布流程维护 |
| 原拟 `production-factory.ts/run-definition.ts` | 已暂停，未新增实现；后续runtimeFactory仍可复用账户身份/卷/Vault校验，但definition来源须改为harness，不按旧表继续开发 |

## 本轮ToTDD责任

本子任务先写loader/schema/refhash测试取得行为红灯，再实现共享schema、loader、真实十角色迁移；不改DB/API/budget/main/app/root binding，不改package/lock（root负责精确yaml依赖）。原生T-HAR10后续将既有T-ROLE1～5的project输入改由harness产生，仍用锁定native+loopback provider，不用纯schema测试代替真实模型HTTP截获。

T-HAR2/5由root完成真实持久化/审批/ledger测试。T-HAR3/4/6/7/8/9后段；不因为部分测试后段就允许跨越预算、权限或路径硬底线。LiteLLM本批只预留gateway_callback费用来源，不部署/不伪造临时key；OpenMAIC保留SDK集成方向，本批不实现。TREG第18个live场景由父任务另行迁入，本子任务不修改。

## 本子任务已完成的实现结果

- 新增共享schema与严格loader；`assertBenchSafety`供有效配置合并后再次调用。静态field `require`是清单数据词汇，以命名常量访问，避免被既有CommonJS loader规则误报；没有改lint规则。
- `research.bench.yaml`保留真实十角色配置和逐字节prompt迁移；`tools/registry.json`包含18项已审查业务工具契约（planned）及10项通用原生元数据（native）。原迁移及旧prompt未改。
- hash包括原manifest字节、所有实际引用文件字节摘要及规范化registry摘要；返回baseline和hash映射冻结。T-HAR5同版本拒变更仍由root真实版本表实现，本loader只准确提供摘要。
- 有效占位行为红灯12项9过/3失败后实现；最终14项loader/schema/路径/迁移一致性回归加87项共享契约为101/101，strict tsc、boundary lint、限定diff check通过。证据 `evidence/P1-10/harness/`。未启动原生模型或真实账户资源。

## Root持久合并/版本子任务 ToSpec/ToTDD

- 全局bench_version由迁移/受信发布CLI追加，应用角色只读；同bench/version的清单、prompt引用或registry变更都拒绝，不能在HTTP路径发布。
- 租户effective快照按摘要去重，档案覆盖引用当前摘要。每次run绑定时复制摘要，不运行中覆盖角色目录。完整升级收件箱T4仍后段。
- planBenchPatch是纯提议，candidate不是批准能力。只有HarnessStore在同账户事务核对父档案和base digest后应用；mixed patch有任何放宽整体不生效，生成pending proposal/审批卡。
- 用户决定必须来自控制面认证写接口，proposal行锁+当前摘要CAS+受信registry复算candidate；approve写harness.loosen账本与不可变收据，异内容/旧摘要冲突409。拒绝保留旧有效配置。
- ToTDD：真实PG验证tighten直接生效、loosen前后摘要不变/批准后变且唯一ledger、越租户隐藏、陈旧proposal不覆盖新配置、禁止修改全局版本、prompt内容不升版拒绝。
