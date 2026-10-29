# RunDefinition 独立审查

现有源码+原10项独立复跑10/10通过，harness/independent-run-definition.json；实际route钉运行问题在API评审发现，等待011增量后再最终收口。

定义仅按run→run_harness→bench_effective→bench_version只读精确join，核账户/档案/bench/version/digest/registry及有效快照，不回退role_def或当前dossier调优。模型/prompt/grants/root不读run.input作为权限字段，steps只能减少；fallback message规范JSON有界。

按root已确认规则，L1新run无own thread一律排除；L2仅当前dossier/threadnull，L3/L4仅账户全局dossier/thread均null，与角色允许layer交集；refs未传自动选允许范围，UUID[]只能收窄，[]不注入；foreign/revoked/superseded/thread summary排除；assigned citations缺验证器时空而非相信UUID。item和总字节超限拒绝，不静默截断证据。

当前定义在首次BindingStore.prepare时冻结提示词/记忆/模型，已存在binding的RunBridge.submit直接复用保存binding，不重新读取变化的memory；没有资源mutator或模型调用。真实PG随机fixture无真实账户操作。

## 运行模型固定增量复核

当前最终12/12通过，harness/independent-run-definition-route-green.json；原route红由作者保留。实际模型只从run_harness.model_route读并使用RoleProjectRequest.model schema校验，null或非法MODEL_ROUTE_UNBOUND409，无环境或options回退。将该路由映射到有效快照当前角色tier唯一位置传materializer；环境变化、构造参数覆盖及input模型均不能改已有运行模型。011与008不可变约束一起使已确认route持久化。当前限定loader审查通过，前述route P2关闭。
