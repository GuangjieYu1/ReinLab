# Production factory 独立审查

结论：当前模块通过，未见P1/P2。独立复跑 production-factory7项、materialize7项、decisions30项共44/44，原始记录 harness/independent-factory-materialize-decisions.json。未修改实现、原测试或真实资源。

factory只读账户RLS记录、driver machine/volume和endpoint；状态必须ready、OS2.0.150、唯一账户机器和具名卷、启动状态、region/镜像/plan config、卷挂载身份全部一致。Docker额外Env基线由严格driver normalization先检查，factory再核计划Env和前缀；Fly原config严格比较。endpoint只允许loopback随机端口或精确Fly machine内部地址。外部异常统一中文固定code，不回显Engine/token。

默认Vault仅reinlab_machine_key(null)读取，不初始化或写密钥；缺失/坏base64/非32字节均VAULT_UNAVAILABLE。解密DEK在finally清零，账户AAD与token结构由既有decryptBundle约束。无provision/start/repair/resource mutator。角色准备固定/data与file:///opt/reinlab/plugin/index.js，运行凭据仅认证请求内部使用。

测试为随机PG账户和fake受控driver/HTTP transport；结论不替代实际Docker账户网络或真实模型验收。
