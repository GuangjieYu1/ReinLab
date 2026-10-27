# 第三批补充说明：工作台 harness 与 OpenMAIC SDK（2026-10-20）

用户已确认整体架构，详见主仓库 `design/ARCHITECTURE_BENCHES.md` 第 10、11 节。本补充**不改变第三批的任务顺序和停止点**，只约束 P1-10 其余部分的写法。

## 1. 研究台按清单实现（工作台 harness）

每个工作台用一份声明式清单（`benches/<bench>.bench.yaml`）描述以下内容：角色、提示词、模型位置、工具权限、`write_targets`、记忆读写范围、门禁、引擎、委托、卡片工具、默认预算。控制面里的 harness 读取清单，统一完成这些事：
- 生成角色 project；
- 发放权限；
- 运行门禁；
- 映射事件。

本批要求：
1. **清单来源：** 研究台的角色、工具白名单、`write_targets`、门禁步骤一律从 `benches/research.bench.yaml` 读取。代码里**不得**再写死 research 专用的角色或工具表。
2. **清单只描述配置，不写逻辑。** 业务逻辑仍放在工具和适配器里。清单要有 schema（zod），并且有校验测试。
3. **复用已有约束：** T-ROLE 已经验证的那套默认拒绝、`task: deny`、`write_targets` 只能写档案目录，由 harness 统一施加，单个清单不能放宽。要补一个测试证明这一点：清单里写 `"*": allow` 或 `task: allow` 时，harness 会拒绝加载。

完整规格见主仓库 `design/HARNESS.md`。本批只需要完成其中的 T-HAR-1、2、5、10（第 10 节第 1 步），其余留给研究台第一期后段。

## 2. 模型网关（LiteLLM）

- 已定加 LiteLLM 作为模型网关：真实 API key 只放在网关里，每次运行发一个带预算上限的临时 key。
- 本批**只要求在费用记账的接口上预留**「费用来自网关回调」这一来源，**不要求**部署网关。
- 网关的部署与接入放进 DEFERRED 之后的批次。

## 3. OpenMAIC 用 SDK，不用整站

- 解释动画的接入方（P2-07）以后改为调用我们自己的课堂引擎服务，**不再直连 OpenMAIC 站点的 `scene-content` 接口**。课堂引擎用 `@openmaic/generation` 实现，模型调用通过它的 `AICallFn` 接到网关。
- 本批不实现。只在 `docs/questions.md` 里把 SPIKE-3 的结论标为「接入方式将变更」，避免后续按旧方式继续推进。

## 4. T-REG 场景数

主仓库 `e2e/legacy/` 新增了第 18 个场景 `live`（自动化台的看板面），审查方实测通过。带进分支时一并带上。
