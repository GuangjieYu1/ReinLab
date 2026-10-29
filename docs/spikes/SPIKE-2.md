# SPIKE-2：项目说明文件（2.0.150）

## 结论

采用**AGENTS.md**作为角色过滤后的记忆快照文件名，不采用MEMORY.md或AGENT.md。源码的项目文件候选顺序是AGENTS.md → CLAUDE.md → CONTEXT.md（deprecated）。它先按文件名选择：对每个候选向上查找至项目worktree；一旦某个文件名找到任何匹配，就加入该类型所有找到的路径并停止尝试其他文件名。不能简化成“最近的文件总是覆盖父目录”。

然后加入首个存在的全局来源：config/AGENTS.md，兼容home/.claude/CLAUDE.md（可用标志禁用），显式OPENSCIENCE_CONFIG_DIR/AGENTS.md（可能与首项同路径，由Set去重）。最后加入config.instructions的本地模式或URL；URL需网络策略，不能误称所有来源只来自项目文件。

## 依据

只读backend/cli/src/session/instruction.ts（FILES、globalFiles、systemPaths、system、resolve），util/filesystem.ts（findUp），project/project.ts（fromDirectory的Git和非Git根选择），flag/flag.ts及test/session/instruction.test.ts。未执行或修改上游源码。源码commit/哈希及相关文件清洁状态见source-manifest.json。

非Git目录自身作为worktree，向上查找在此停止；Git项目以发现的worktree作为上界。工具读取更深路径时，resolve还会在项目内查找对应目录说明，并避免同一消息重复注入。单源读取≤256KiB；systemPaths/system的来源集合最多64项且该次system结果≤1MiB。resolve逐目录动态补充不受上述64项限制，它有该次调用独立的1MiB预算，不能把这些上界当作整个会话/全部注入的累计保证。非普通文件、超限或读时改变的文件会跳过。OPENSCIENCE_DISABLE_PROJECT_CONFIG只禁止systemPaths的启动项目默认搜寻；resolve没有这个标志检查，读取项目内文件仍可能补充目录说明。不能把该标志当作所有记忆注入的关闭开关，显式instructions也有另外规则。

## 验证

逐段核对原始源码并记录SHA256；本地摘要复核命令校验完整原始源码；仓库契约测试固定已审阅摘录的文件优先顺序、system作用域上界与限制。摘录是研究证据，不作为生产实现。未来源码变化必须重跑完整复核并重新研究。真实npm二进制实验验证两个独立角色project读取各自配置，见runtime-probe.json。SPIKE-1旧消息noReply实验不会运行InstructionPrompt.system后的模型循环，因此**不能**把它作为完整提示词注入实测；说明文件选择的结论来自源码检查，未宣称观察到模型最终system prompt。

复跑：`node tooling/spikes/verify-upstream.mjs <只读源码目录>`，然后`pnpm exec vitest run tooling/spikes/spikes.test.ts`；再运行`node tooling/spikes/openscience-probe.mjs`核对真实二进制行为。测试只使用自己创建的临时目录和示例文本，不读取用户全局说明或.env。

## 采用方案

翻译层开始前，按role_def.read_scope筛选记忆，在该角色实际project内原子写AGENTS.md，并保存快照摘要/来源账本。配合SPIKE-1候选`.roles/<roleId>/`配置选择；不把未过滤的其他角色记忆放到祖先AGENTS.md或全局文件。全局说明只放共同安全规则，不能承载不同角色/档案的私有记忆。

明确控制project根及Git上界，审核config.instructions，不允许跨档案/未授权全局路径或任意远程来源；不能只凭目录名推断隔离。读取权限、工具路径和实际注入内容的越权实测留给后续契约/安全测试，不提前宣称完成。

## 边界

源码检查足以确认文件名与优先级，但不是一次真实模型注入验收。未调用模型、未实现记忆翻译层、未修改前端或内核。P1-10仍等待用户确认，替代角色project策略也需Claude确认。
