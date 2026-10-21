# T-HAR10 materialize ToSpec

`materializeHarnessRole(effective, registry, {dossierId,roleId,modelRoutes,memory,maxSteps?}) -> RoleProjectRequest` 是纯服务端转换，不读取旧role_def，不读取模型/记忆文件，不执行业务工具。先验证有效快照和registry绑定摘要，再从角色model_slot→tier选择受信modelRoutes。memory是服务端按角色scope过滤后的快照字符串，过滤由后续run-definition负责。

提示词采用有效prompt及本角色dossierNotes，禁止file/env插值；删除通配deny哨兵，显式task deny，danger收紧deny，工具风险取受信registry。planned工具仅保留契约权限，不声称已实现。当前不支持实际MCP/delegation，非空声明失败关闭。maxSteps只能1..role.steps，根/插件固定由后续factory提供，不能从input传入。

ToTDD先记录缺实现红灯；单元从真实research清单加载有效快照，十角色均生成可验证project plan；覆盖路由/记忆/notes、摘要漂移、越权steps、危险工具/default deny、模板、未知角色/缺路由。原生fixture单独克隆真实bench，仅添加native read allow作为测试差异，必须经loader+materialize，不把手工request称harness生成。

实现状态：helper已实现。真实10角色全部plan有效；factory+helper14/14，T-HAR10原生4/4，control tsc与边界lint通过。原生fixture仅本机确定性provider，未验证真实模型质量/计费。原生带write_targets时可能展示write schema，plugin whitelist仍拒绝forced未授权write，详见evidence/P1-10/harness/implementation-README.md。独立复核由docker_driver进行，尚不能自批。
