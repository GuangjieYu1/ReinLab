# P1-10 首个PR：角色边界前置验收

依据用户批准与design/reviews/BATCH1_REVIEW.md。D-1先完成最终Node22/24基线+22连续五轮、独立测试/评审/CI后，才开始本项。本PR仅T-ROLE-1～5及最小生成器/SDK适配/工具白名单补闸；不实现其余事件映射、审批回填、记忆服务、账本费用、运行API或前端接线。

ToSpec：角色位于/data/roles/<dossierId>/<roleId>，非git project；当前档案外部路径allowlist；research最终权限先*deny，再按tool_grants放行；task始终deny，控制面以后负责调度。read进一步按canonical文件路径收紧，抵御已有filesystem grant绕过external_directory的情况。编辑工具合并为edit权限，按write_targets收紧，同时用最小插件before-hook逐工具核对，阻止未获授权的编辑别名。生成文件为控制面管理普通文件，不覆盖不匹配文件或symlink，每次会话/提交之前校验摘要；防止自动instruction读取绕过工具权限。

ToTDD：真实npm2.0.150运行时+仅测试fixture provider截获HTTP模型请求（无真实模型/费用），验证角色system不同、正向档案读取及跨档案/另一role/符号链接拒绝、默认工具强制调用无副作用、task不能委派、runtime requestID重放及409。额外拒绝parts.subtask/agent等桥接输入；不通过旧session.prompt/noReply替代runtime收据。元数据与配置加载测试不能替代实际模型请求。文件/配置恶意路径、git祖先、symlink、篡改、防覆盖需单元负例。

测试先红后实现；实现完成后另派GPT6.1 Sol / medium子agent并行独立测试与评审。全部通过仅表示本PR前置边界通过，P1-10整体与云验收仍未完成，停下交审查方确认。
