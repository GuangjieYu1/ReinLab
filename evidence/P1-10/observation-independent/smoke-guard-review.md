# 单次真实冒烟守卫/管理能力独立审查

Guard及RoleRuntime管理方法限定范围通过，未见P1/P2；CLI故障证据/清理尚有两项源码问题待root收口，见下。没有执行smoke-local CLI、读取真实key或向真实模型请求。

独立复跑原guard19+Runtime管理12+纯plan12=43/43；另新增独立fake-only3项，组合46/46（smoke-guard-independent-green.json）。验证不同guard实例共享同marker并发只1次transport、transport调用前marker已持久存在且0600、未知cap/坏UTF8不消耗slot。既有测试包括SSE透明/取消、deadline、node chunked、超长body、未知结果不重发、重启marker、production拒transport注入。

源码核对：只固定POST路径与固定https官方endpoint，无redirect/retry；先timingSafe认证，再完整有界UTF8/JSON文本+已声明字段校验，重编码消歧。model固定旧兼容Flash、n≤1、max_tokens1..1024、thinking disabled/effort none，拒多模态/搜索servertool；标准function工具仅描述。父目录canonical/owner-private，marker wx写入并fsync文件/目录在transport前，已有marker不删除，未知结果不重发。status无headers/key/body，priceBound明确为保守估计而非官方硬证明。只支持明确loopback/private IPv4，容器连通由无认证preflight先验证，不宣称已验证真实网络。

RoleRuntime管理入口不在reader，origin仅精确host.docker.internal私网根路径端口（测试另loopback），token43随机字符串拒真实sk-前缀。先project/plugin及connected/config apiKey拒覆盖既有连接，仅新专用账户可用。真实key只在guard内；OS auth只写临时token，global config不含key、固定模型/输出1024/reasoningoff/titleoff。原raw仅闭包保存，失败清理可重试未完成raw恢复/auth删除，不重新配置。管理方法不接受模型/key扩展，未松角色/文件隔离或prompt发送权限。

CLI只读核对：默认生产factory/pipeline/Harness/JWKS/models.dev，无test factory注入；真实Auth专用身份及RUN_KEY在模型HTTP前保存，marker已有则不执行，失败未知不生成新run intent；DB仅应用角色并assertSafeRole，SQL均该账户/run限定，无管理员连接。价格窗口明示CNY/7.2且当前有效≥2min、最长24h，预算1元/steps1/空memoryRefs；报告wx不覆盖，只有guard1次、completed、有效usage与settled才可成功。纯plan12通过不代表真实网络/账单验收。

CLI待收口（源码审，不执行禁止的CLI来复现）：

1. detail(binding/usage/events/holds)读取在guardcount/ended/completed断言后；unknown导致paused_budget或未结束会提前catch，缺约定的原始unknown用量/hold/ledger证据。建议对已知run在失败路径亦只读采集，再将成功断言与completed判定分开，不触发任何重发。
2. finally后半pipeline.shutdown/server close/guard.close/pool.end任一步抛错可跳过剩余清理及报告写入。建议各项best effort清理，保存稳定cleanup错误码，并保证最终报告尝试；不能因清理故障放开marker或重发模型。

root已收到，待修复增量复核；本报告不授权真实模型调用，实际一次执行由root单独受控。

## CLI增量独立收口

两处问题已关闭，guard/script限定范围通过，无剩余P1/P2。独立纯/本地fixture组合49/49：guard19+Runtime管理12+plan12+独立guard3+cleanup3，smoke-cleanup-final-green.json。未执行smoke-local CLI、加载真实key、运行真实模型。

captureEvidence依据已知account/run，或已保存estimate查找确认run，在受RLS应用账户事务内采集binding/usage/events/hold；finally始终先尝试采集，try已成功采集则不重复，即使未结束/failed/unknown/HTTP确认未知也不再因前置断言省略证据。只读采集不会产生新模型/SDK变更。

cleanupSmoke依序尝试evidence、temporary_config、observer、http、guard、database，独立捕获错误，仅稳定组件名外返，不让一项异常跳过后项；报告记录cleanupFailures并将completed=false/退出非0，最后仍尝试以wx写报告、不覆盖原证据。成功仍须completed终态、唯一guard调用、可信非null用量与settled，failed/cancelled或unknown均不冒充成功。

本次源/测试冻结已通知root及Node24全量执行代理，后续真实一次模型执行只由root按原授权进行，本报告不是已实际调用/账单对账证据。
