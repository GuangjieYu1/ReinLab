# P1-09 独立复核

真实 npm @synsci/openscience 与 SDK 均为 2.0.150。独立顺序亲跑两个原生 probe：失败假设模式退出 1（预期），普通模式退出 0，均完成 9 项断言；5 项 Vitest 全过（573ms）。使用 Node v22.23.3、显式 OPENSCIENCE_SOURCE 与 Node22 PATH；4096 无并行 probe。

源码根：/Users/guangjieyu/Documents/DeepSeekPlugin/OpenScience；commit：539bff49900b302e3e96df8c50e1668fbd02228e。原 manifest 的 11 项 SHA256 全匹配，追加读取 config/config.ts；这些相关源码 git status 为空。精确摘要与复核文件哈希见 independent-test.json。未执行或修改上游源码及上游测试，未读用户 .env/凭据。

API/SDK 一致：runtime 顶层 agent 被严格拒绝，公开路由显式 research；session.create 无绑定字段；旧 session.prompt agent/noReply 生效；mention 保存委托提示而不更换主 agent；default_agent 仅用于未显式指定 agent 的选择路径。两临时非Git项目各自 /agent 配置能加载不同 research prompt。

说明文件采用文件名优先：AGENTS.md → CLAUDE.md → CONTEXT.md；首个有匹配的文件名收集到 worktree 的全部匹配。全局来源仅取首个存在项，再处理 instructions 本地模式与 URL。非Git目录自身是上界；Git上界及其发现条件由源码复核，未执行上游。

需精确表述的范围：

- 64 来源限制针对初始 system/systemPaths，resolve() 深层说明无 SOURCE_COUNT 限制；单来源大小与累计大小仍另有限制。
- 五项测试为证据/文本/摘要守卫，不能视作执行了说明文件选择、全局首存在或注入。测试名称的范围宽于断言。
- 测试默认源码绝对路径影响 CI 可移植性，父 agent 已知并处理。

noReply 在 loop 前返回；本次有效请求仅保存用户消息，无 assistant 消息；runtime 请求均在验证时拒绝。零模型调用是请求控制流及源码支撑的结论，未额外采集 provider 网络追踪。未验证实际生成、最终 system prompt、角色权限、工具文件隔离或同账户档案隔离。正文已明确主要边界，候选 research 别名仍待用户/Claude确认，未进入 P1-10。

结论：原生 API/配置实验与五项测试通过；源码/SDK结论有据。以上范围澄清已通知父 agent。

## 修订后独立复核

父 agent 已收窄 system/resolve 预算文字，并把测试改为仓库内摘录守卫、外部源码显式复核。独立再次执行无需 OPENSCIENCE_SOURCE 的 5 项测试，全过；verify-upstream.mjs 对原 checkout 的 11 个完整 SHA256 和摘录包含关系复核通过（changed=0）。额外逐项核对全部4个摘录的实际原文件、startLine和摘录摘要，均匹配。当前文档、测试、验证脚本、摘录的最新哈希已更新 JSON。无需重跑未变动的原生 probe。

原范围/可移植性发现已解决。仍保留明确限制：这是源码/SDK与noReply保存行为验证，不是最终提示注入、模型生成或安全隔离验收；P1-10仍未进入。当前无阻塞发现。

## 最终六项验证

最终测试名已明确文本守卫边界；SPIKE-2已澄清禁用项目配置标志只作用于systemPaths启动默认搜寻，resolve仍可能补充说明。亲跑最终6项Vitest全过（711ms），其中三包实际安装版本断言均为2.0.150。JSON已刷新最终正文/测试哈希及插件版本。原生probe和上游源码均未变，无需重复运行。最终无阻塞发现；模型生成、最终注入、安全隔离仍未验证，P1-10仍未进入。
