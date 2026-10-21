# Harness materialize / production runtime factory / T-HAR10 状态

本文件记录实现与测试状态，不代替独立审查。未接 main/app/生产 HTTP；run_harness snapshot loader 和 memory scope 过滤尚未实现。调用 materialize 的服务端必须提供已按角色过滤的 memory 与受信模型 routes。

## 实现

- `production-factory.ts`：ready/锁定版本/账户机器与卷唯一归属/部署plan/endpoint核验；默认 environmentDriver，只读Vault，RemoteRoleStore固定/data与正式插件，返回RoleRuntime。仅读DB与list资源，不ensure/start/update/create，无fixture fallback。默认Vault仅 `reinlab_machine_key($1)`参数`[null]`，缺失/坏key VAULT_UNAVAILABLE503，DEK在finally清零。旧provisioner创建路径未改。
- `harness/materialize.ts`：验证有效快照及registryHash；有效prompt+本角色note，model_slot→tier→受信route，server memory原样注入；steps只tighten，strip *deny，task/danger deny，tool risk来自registry。MCP/delegation非空失败关闭。业务planned工具仅契约声明，不声称已实现。
- `harness-materialize.test.ts`：从实际research清单加载十个角色，全部经materialize→RoleProjectRequest parse→planRoleProject；没有role_def权限回退。
- `harness-native.test.ts`：克隆真实research清单并复制实际十份prompt，唯一清单差异为research-read/research-auto添加native read allow；steps=8通过materializer的受信tighten选项设置。loader→effective→materialize→真实npm OpenScience2.0.150 project，loopback OpenAI-compatible HTTP fixture，不是真实模型验证。

## 可复核结果

- `production-factory-red.json`：初始缺实现有效行为红，5失败/1通过。
- `production-factory-green-attempt-1.json`：初次5/6；tamper fixture用了结构非法envelope，未取key就被Row拒，随后改为有效结构/非法GCM tag验证finally清零。
- `production-factory-readonly-vault-red.json`：新增只读默认Vault回归有效红，原SupabaseKeyVault传random candidate不符`[null]`。
- `production-factory-readonly-vault-green.json`：7/7。
- `harness-materialize-red.json`：缺模块setup失败，不能充当行为红；单独保留。
- `harness-materialize-behavior-red.json`：有typed导出但NOT_IMPLEMENTED，4失败/2通过，有效行为红。
- `harness-factory-unit-green.json`：factory7 + helper7 = 14/14。
- `harness-native-setup-failure.json`：macOS临时路径/var非canonical，loader正确拒；测试改为realpath。
- `harness-native-assertion-failure.json`：2通过/2断言失败；system JSON转义造成全文contains误判；另原生write schema展示行为不等同工具执行授权。
- `harness-native-green.json`：4/4。实际HTTP system包含对应真实prompt及memory，隔离两角色；正向read；外部/他档案/他role AGENTS/symlink read拒绝且不泄漏sentinel；模型强制write/未知工具/task拒绝，无文件/子session副作用；requestID重放同receipt且provider delta0，异内容409。
- `harness-native/harness-native-evidence.json`：脱敏临时根的实际provider body，含fixture差异及观测；无headers/token。仅fixture system/memory和测试sentinel。
- control `tsc -p services/control/tsconfig.json` 与边界lint通过。

注意：实际角色有write_targets，原生文件权限可导致write schema仍展示给模型。工具白名单plugin仍拒绝未授权write；本证据只对unknown/task声称未展示，对write只声称强制执行被拒且零副作用。未把展示与执行混称。
