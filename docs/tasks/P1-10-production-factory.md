# P1-10 生产账户 runtime factory ToSpec / ToTDD

接口：`createProductionRuntimeFactory(db,{driver?,vault?,app?,controlUrl?,transport?}):RuntimeFactory`。仅服务端受信配置可注入依赖，默认真实environmentDriver/只读Supabase Vault/RemoteRoleStore/RoleRuntime；没有fixture、本机路径或live fallback，不按旧role_def加载定义，不改main/app/RunBridge。

每次调用在db.withAccount中只读本账户account_machine（ready、OS_VERSION、machine/volume/image）及account_machine_secret.envelope，使用vault key解包；无论成功/失败，拿到的Buffer均finally fill(0)。不返回tokens DTO或日志，RoleRuntime是仅服务端使用的能力对象，不能序列化给HTTP客户端。

只读driver list，按persisted ID、rl-账户名、metadata账户标记交叉检查唯一机器，卷按persisted ID/rl_账户名唯一匹配；region、单/data挂载、attachment、image、安全config与driver plan一致。Fly user env须全等；Docker归一化adapter已验image基础Env，只核对plan全部env及额外保留前缀，不能假装normalized含guest。实际machine须started，不自动start/ensure/update/create。endpoint只许Docker http127.0.0.1显式端口或Fly精确machine.vm.app.internal:4096，无路径、query、credentials或重定向目标。

核验完创建RemoteRoleStore固定/data根及file:///opt/reinlab/plugin/index.js，以auth token准备角色；收据须经过既有account/path/hash/plugin验证后才返回RoleRuntime。role来自harness/已绑定定义，模型和记忆由受信服务注入；factory不自行做research模式/角色表选择。

测试先取得有效行为红灯，再实现。仅测试PG+fake driver/vault/HTTP transport；覆盖Fly/Docker正常、重复/foreign身份、卷/配置漂移、ready/version、endpoint拒绝、伪收据、错误脱敏、key清零和零资源mutator。无真实模型/外网/Docker/secret操作。

materializeRole后续设计（现已在独立materialize任务实现）：从有效清单的role/prompt和受信registry构造RoleProjectRequest；忽略*deny哨兵，task硬deny，保持Q002更严danger deny，工具只能取有效权限与registry风险；实际model route、经memory scope过滤的快照和dossierId由server注入。不能再读role_def作为权限源，也不能从用户input接受model/prompt/grants/root。

默认Vault仅执行 `select public.reinlab_machine_key($1) value`，参数固定 `[null]`，缺失、非法编码、长度错误或查询失败稳定VAULT_UNAVAILABLE503；不得借用既有provisioner的随机candidate创建路径。新增有效红灯指出旧默认实现传入random candidate，替换只读实现后7/7通过。初次6项green之前的tamper fixture曾用结构非法envelope导致尚未取key就失败；已改有效结构但非法GCM tag验证清零，保留初次结果作为setup历史。
