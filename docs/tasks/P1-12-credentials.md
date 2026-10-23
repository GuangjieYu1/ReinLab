# P1-12 前置：凭据文件化（ToSpec / ToTDD）

依据：主仓库 BATCH4_REVIEW 第3/5节与用户第五批顺序。用户已删shell自动导出并轮换key；此事实不是T-MCP-10授权，任何真实模型请求仍禁用。

1. runtime.env维持项目外0700/0600配置，主入口、部署/运维/验证只内存读；环境仅允许公开参数和文件路径。先红测试读器/拒绝路径，再实现；真实HTTP子进程在最小无秘密ENV启动，周期审计所选合成秘密没有出现在任何ENV值子串中。固定错误不泄露配置值。
2. 账户鉴权文件按账户交付，不存镜像层、角色project、档案或备份，不进入Env/argv/labels。秘密文件权限、symlink/hardlink/特殊文件、来源绑定、更新/恢复/重启都必须验证。旧ENV机器不能静默继续充当文件化机器。
3. 固定2.0.150直接CLI不支持token-file。自有部署适配必须保护内核网络listener自身（不只外层代理），第一请求即强制Bearer；保留原Host/Origin、插件SDK internalFetch、SSE/once/取消/优雅停机，绝不将网络请求转发到内部可信fetch。私有文件失效时关闭，禁止ENV回退。
4. 正式kernel打包须有固定源码tag/hash、Bun版本、Apache LICENSE/NOTICE和可重建入口；源码直接运行health=local不能伪造成2.0.150。独立安全SPIKE已验证接口，正式产物/原生fixture与镜像尚待本阶段实现验证。原始上游checkout只读。
5. 本阶段完整通过与独立安全评审后才发布research@1.1.0，随后做审批/收件箱API与前端live接线；已有mock18场景、RLS和幂等必须保留。凭据扫描报告统一送审前整理，红绿文件名与真实内容一致。

测试与红绿报告目前位于 /tmp/reinlab-p112-*；最终统一归档 evidence/P1-12/。源计划每个完整小步提交，本地GPG无法交互时仍仅单次关闭签名，不改全局配置。

2026-10-23阶段结果：正式部署产物和镜像已构建；原生账户6/6、Linux容器8/8（含重启与所有进程ENV扫描）、Node22全量1395/1395；后补writer独立安全与最终metadata调整另有定向复测。独立安全发现并关闭routes/static旁路与同镜像迁移unknown误判。具体证据见evidence/P1-12/credentials/。此为凭据前置阶段，不能当作research@1.1.0、P1-12 API/live或本地旧账户迁移已完成。未执行T-MCP-10。
