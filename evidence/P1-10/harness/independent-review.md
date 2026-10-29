# Harness loader / schema 独立审查

结论：本 loader/schema 范围通过，未见 P1/P2。独立复跑 bench-manifest14项及共享契约87项，101/101 通过；记录 independent-regression.json，原作者red未改。没有修改实现或原测试。

只读核对 packages/contracts/src/bench.ts、harness/manifest.ts、research.bench.yaml、tools/registry.json、原十角色迁移与prompt。schema严格拒额外字段，entrypoint、model slot、gate产物阶段均核对声明身份；patch禁止prompt/gates/steps及新增角色/slot，权限收紧/放宽的授权由resolver负责。registry声明planned不等于工具实现，当前没有虚构cards/mcp/engines。

路径：benchId限定单段标识，manifest固定位置；prompt/schema限定当前bench前缀与文件格式，模板亦限制当前bundle。拒绝绝对路径、反斜线、冒号、控制字符、点段、空中间段。目录逐级lstat，文件O_NOFOLLOW/O_NONBLOCK、普通单link与大小限制，读取后核对inode/dev、canonical realpath和目录，拒符号链接/硬链接/逃逸。root只允许可信服务端注入，不是用户输入路径。

YAML使用core/strict/uniqueKeys、拒所有warning/error，额外拒alias/anchor/显式tag/原型字段、多文档以及file/env引用；解析树有节点/深度上限，UTF8 fatal decode。错误消息固定，field path标识位置而不回显配置值。

安全底线独立于研究角色表：明确通配符或task只可deny；danger不得allow；所有工具/MCP/委托引用必须注册；写目标只允许档案内相对路径。role project生成器仍强制插入默认deny/task deny且拒项目目录写入，不能把本loader的角色工具record当作原生权限配置直接使用。

摘要覆盖原manifest字节、实际读取的每个prompt/schema/template内容SHA，以及规范化registry摘要；返回完整对象递归冻结。实际十角色逻辑ID、prompt原字节、风险/工具权限、write_targets、steps、模型档和旧记忆范围迁移一致。

界限：本结论不声称T-HAR2授权合并、T-HAR5真实版本持久化已验收，也不替代T-HAR10原生角色隔离。部署root应为可信只读代码；配置升级和用户覆盖只走后续DB受信流程。
