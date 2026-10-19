# P1-09 独立只读评审

评审对象：SPIKE-1 / SPIKE-2、P1-09 任务说明、openscience-probe.mjs 与 spikes.test.ts。未修改实现或 SPIKE 正文；未启动二进制（避免与独立 native probe 争用 4096）；未执行或修改上游源码，未读取 .env。

## 已核实

- 上游 checkout 为 `539bff49900b302e3e96df8c50e1668fbd02228e`；manifest 的 11 个文件 SHA256 全部匹配，相关路径 git status 清洁。上游 backend/cli/package.json、已安装 @synsci/sdk 和 @synsci/openscience 均为 2.0.150。
- 公开 runtime 路由固定 `const agent = "research"`，拒绝开发 agent header，Input strict 且不含 agent。default_agent 无法改变此路径选择。
- SDK 的 SessionCreateData / RuntimePromptData 无 agent；SessionPromptData 有 agent / noReply，RuntimePromptData 有 requestID。
- noReply 在模型循环前返回；mention 只构造 agent part 与 task 委托提示，不改已选中的主 agent。旧入口不能替代规格的 runtime 收据入口。
- research 项目覆写是与规格原 fallback 有差异的候选。文档清楚说明尚未证明实际生成、权限或文件执行隔离，并保留用户/Claude 确认门禁；没有实现 P1-10。
- InstructionPrompt 的 FILES 文件名优先顺序、按文件名全链搜寻后停止、全局首存在来源、显式 instructions 与 URL 来源，均与源码一致。

## 真实发现（供主 agent 修正正文后复核）

1. **P2 — SPIKE-2 需限定说明文件限制与禁用开关的作用域。** 当前“单源≤256KiB、总量≤1MiB、最多64来源”及“项目配置禁用时不搜项目默认文件”没有区分 `systemPaths/system` 与 `resolve`。源码 `instruction.ts` 的 SOURCE_COUNT 只约束 systemPaths/system；resolve 沿读取路径动态查找说明，没有64来源计数，其1MiB预算只限该次resolve，也不检查 OPENSCIENCE_DISABLE_PROJECT_CONFIG。不能据此推导整个会话/所有动态注入都受相同来源数、总预算或禁用保证约束。建议明确启动 system 与按需 resolve 的各自边界。
2. **P2 — 原 spikes.test.ts 直接依赖本机上游绝对目录，不能作为干净 CI 合同。** 主 agent 已计划改为已审阅源码精确片段与摘要的 portable manifest，并保留显式 OPENSCIENCE_SOURCE 完整源码复核。建议 portable 测试仍校验本机已安装 SDK/npm 包实际版本为2.0.150，同时保留真实二进制 ready/health 的版本检查；摘要测试仅证明归档证据一致，不等于运行了上游实现。

补充边界：Filesystem.findUp 通过 `current === stop` 停止，不进行 canonical containment 校验；源码 project 在 linked Git worktree 情况可能选用 common worktree。当前文档已要求后续明确 Git 上界、不得把目录当沙盒；P1-10 的安全验证仍需覆盖实际部署目录拓扑，不能只复述 stop 参数。

## 本次验证

- 独立 Node 只读脚本：11个 source hash 匹配；SDK 三类输入字段与2.0.150包版本均匹配。
- `PATH=/Users/guangjieyu/.nvm/versions/node/v24.14.1/bin:$PATH pnpm exec vitest run tooling/spikes/spikes.test.ts`：1文件、5测试通过（本机当前版本）。直接用默认 PATH 首次运行因 Node20/pnpm24运行时不兼容失败，未进入测试；切换已安装Node24后通过。
- 未独立复跑 native probe；运行时行为实测结果由独立 test agent 负责。此评审不将静态源码结论称作最终模型system prompt注入实测。

结论：核心 SPIKE-1 研究成立；SPIKE-2 主结论成立，但上述限制作用域应修正。CI可移植性修正后需重新跑静态测试。P1-09 的验收方确认与 P1-10 开工门禁仍未满足。

## 修正后复核

两项发现已关闭：SPIKE-2 已明确 system 与 resolve 的独立限制、禁用开关仅作用于 systemPaths；静态测试已改读仓库内已审阅摘录，不依赖本机上游路径，并明确文本守卫不能代替注入执行验收。新增实际安装 SDK/runtime/plugin 三包版本严格等于2.0.150的断言。完整源码哈希复核仍为显式命令，不以摘录摘要代替。

独立重跑结果：`node tooling/spikes/verify-upstream.mjs /Users/guangjieyu/Documents/DeepSeekPlugin/OpenScience` 为11项检查、0变化；上述 Node24 PATH 下 `pnpm exec vitest run tooling/spikes/spikes.test.ts` 最终为1文件、6测试全部通过。

最终评审通过，未遗留本轮阻断发现。通过范围是研究结论、已归档源码证据和静态合同；真实二进制实验由独立测试报告负责。此结论不证明最终模型提示词、权限执行或文件隔离，也不替代用户/Claude 对research覆写候选方案及P1-09的验收确认；P1-10仍不得据此视为已实施或获准开工。
