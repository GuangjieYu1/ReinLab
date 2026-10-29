# P1-10 首 PR 独立评审

评审范围：`services/control/src/bridge/openscience/role-project.ts`、`role-runtime.ts`、`plugins/reinlab-os-plugin/index.js` 及角色 fixture/tests。评审者独立阅读实现与上游源码，仅执行本地测试及固定安装的 npm 2.0.150 二进制；未执行上游源码、未请求真实模型/外网、未读取 `.env`、未修改生产代码。

## 初次审查：暂不通过

### R1 / P1：生成配置内的引用模板绕过 read/角色目录权限

初次审查版本 `role-project.ts:7,44` 接受任意 role.prompt 并原样写入 research prompt。上游 `backend/cli/src/config/config.ts:1688–1710` 对配置字符串执行 `{env:...}` 替换及 `{file:...}` 本机文件读取，后者不经过工具权限/SessionFilesystem。即便 config 文件的普通文件、单链接与 SHA 校验全通过，跨档案文件内容仍可被配置展开直接放入角色 system。

复现：显式 Node 24 运行 `node node_modules/vitest/vitest.mjs run services/control/test/role-project.test.ts`，2026-10-19 18:43，本轮 14 例中 12 通过、两个引用模板拒绝测试失败（prepare resolved）。父任务保存 `reference-injection-red.json`。建议对最终生成的配置全文拒绝引用模板，而不只防单个 prompt 字段，覆盖 `{file:` 和 `{env:`；memory 作为普通 AGENTS 内容本身不经该配置替换。

### R2 / P1：运行中的 AGENTS 篡改在下个模型回合先于工具校验泄漏

初次审查版本 bridge 只在 SDK 调用前 assert；plugin 的 verify 只运行在初始化和 `tool.execute.before`。上游 `backend/cli/src/session/prompt.ts:1802` 每回合重新加载 InstructionPrompt.system，而 `session/instruction.ts:76–107,231–248` 对 AGENTS 执行 realpath 后直接读取。因此首个模型请求之后替换 own AGENTS，下一回合可自动读取其他角色 AGENTS；before-tool hook 即便拒绝工具，仍不能阻止后续 system 泄漏。

独立原生复现已完成：`services/control/test/fixtures/review-toctou.ts` 使用固定 npm 2.0.150 和本地 OpenAI-compatible fixture。首个研究 HTTP 被 provider 接收后，测试同步将 alpha/AGENTS.md 替换为 beta/AGENTS.md symlink，再返回合法 read 调用。捕获 3 个 HTTP（含一次 title 请求），第二个研究回合 system 含 `REVIEW_CROSS_ROLE_TOCTOU_SECRET`。证据 `review-toctou-red-system.json`（全部内容均测试生成，路径仅临时测试路径）。初次结果 `changed:true, requests:3, leaked:true`。

建议增加 `experimental.chat.system.transform` 验证，在 instruction 已组装后、provider HTTP 前终止不匹配的运行；并保留上述原生回合间篡改回归。该措施应同时核验全部受管文件和禁止的配置入口。任何分离的 lstat/hash/后续读取仍不是对恶意本机同 UID 并发进程的原子隔离，部署须明确角色目录由控制面独占，且模型工具永不获 role 根写权限。

### R3 / P2：SDK 请求没有截止时间，会永久挂起

初次审查 `role-runtime.ts:9,13–17` 所有 SDK 请求无 signal/期限。SDK `tooling/sdk/js/src/v2/client.ts:12–17` 默认 fetch 设置 `req.timeout=false`。若内核连接后不回复，createSession/prompt/snapshot 将永久等待，result() 的 OS_UNAVAILABLE 映射无法执行。建议统一设置有限、可测的 AbortSignal deadline，映射稳定错误；prompt 超时不得自动用新 requestID 重提，以免重复执行。以本地 stall HTTP server 验证请求次数不增加。

## 已确认的正确边界

- research 最终 `* deny`，task 强制 deny，danger 强制 deny；write 等原生编辑工具统一以 edit 权限生成路径规则，再由插件按具体工具白名单与 writeTargets 检查。
- read 的 canonical 绝对路径 allowlist 与插件检查提供第二道限制，不能只依赖 external_directory；已有 SessionFilesystem grant 在上游可能绕过 external_directory ask。
- 只发 session scope grants，来自私有 issued 计划；没有给角色开宽泛 project/installation grant，也未自动回答 pending permission。
- bridge 的 strict message-only 输入拒绝 agent/subtask/parts，阻断上游显式 subtask bypassAgentCheck 路径。
- 原生 7/7 的证据实际捕获模型 HTTP，包含正向读写、强制未知工具无副作用、task无子会话、requestID replay无额外 provider 请求及冲突409；这一层次优于只看配置加载。
- 生成器拒绝 role 项目 git 祖先、管理文件 symlink/硬链接/摘要篡改与已有不匹配文件；不覆盖冲突文件。

## 测试证明的边界

7/7 只证明已枚举的场景，不能覆盖 R1/R2。T-ROLE5 当前证明同一 RoleRuntime 实例中、一次 completed 请求的原生持久收据重放；尚未证明 bridge 重启后恢复绑定（sessions 是内存 Set）、进行中并发重放或内核重启后重放。其余翻译层/生产恢复不属本首 PR 范围，不能据此宣称 P1-10 整体完成。

默认 shell Node 20 导致直接 pnpm 启动失败（pnpm 11 需要更高版本且 node:sqlite 缺失），故评审测试使用 `/Users/guangjieyu/.nvm/versions/node/v24.14.1/bin/node` 显式运行。该环境启动失败不计为实现测试失败。

## 修复复审

2026-10-19 18:48：引用模板修复后，独立重跑 role-project 单元测试 14/14 通过，R1 已关闭。检查最终 config 全文（而非仅 prompt）能同时覆盖配置中其他字符串路径入口。

R3 已实现统一 call(options.signal) 包装、100–30000ms 可控期限、默认10秒及稳定 OS_UNAVAILABLE503，未见重发逻辑；等待独立 stall 原生接口测试确认。

R2 第一次修复新增 system.transform verify 后，独立 TOCTOU 原生脚本仍 exit1：首个研究 HTTP ownMemory=true、第二个研究 HTTP crossRoleSentinel=true。增加透明 test-only plugin wrapper 记录全部 hook 调用后，hookLog 为空。源码查明原因：上游 `backend/cli/src/plugin/index.ts:109–121` 在 sandbox 启用时直接跳过 project-controlled plugin。当前角色 JSON 声明的插件属于 project 来源，故 before-tool 和新增 system hook 都未实际加载。单看插件源码修复不能关闭 R2。

### R4 / P1：原生 fixture 未注册可信全局插件，插件补闸测试无效

角色配置中的 plugin 被上游视为 project plugin；上游拒绝将此类代码放进 sandbox 外的 host 进程执行。正确的受控部署路线应将共享插件注册在账户内核的可信全局/inline config，而不是关闭 sandbox。`config/config.ts:1856–1857` 依据全局基线区分插件来源。进一步核对确认，现有 `infra/fly/account-entrypoint.mjs:18–20` 已向受控 os-config 写入全局 plugin 并设置 OPENSCIENCE_CONFIG_DIR；此项是 fixture 与现有部署不一致，不是现有账户入口缺失注册。fixture 必须复制这一条件，并以透明 hook 记录或能够区分原生默认行为的负例证明插件实际执行。

尤其 T-ROLE3 的未授权 edit 测试必须在**同一 session 先 read 文件，再请求 edit**，否则上游 FileTime 的先读约束会使未加载插件的错误版本也拒绝 edit。硬链接和模型回合间 instruction 篡改能提供独立的插件执行证明。

当前复审结论仍暂不通过，等待可信全局插件部署与原生回归；不应关闭 sandbox 来使测试通过。

## 最终复审：通过本首 PR 的角色边界范围

2026-10-19 18:51，修复后最终校验完成。以上初审/中间复审历史保留，当前结论以本节为准。评审者未修改生产实现。

| 项目 | 关闭依据 |
| --- | --- |
| R1 配置引用注入 | 最终生成 config 全文拒绝 `{file:` / `{env:`；独立显式 Node24 重跑 role-project.test.ts，14/14 通过。 |
| R2 回合间 AGENTS 泄漏 | 独立原生 TOCTOU wrapper 最终 exit0，首回合已正常发送且篡改实际发生；仅2个 provider HTTP（研究与title），crossRoleSentinel 均 false。hookLog 记录 tool.before 拒绝，以及其后 `rejected:experimental.chat.system.transform`；第二研究请求未发出。见 review-toctou.json。 |
| R3 SDK 无期限 | 统一 call 使用可控 AbortSignal.timeout、稳定 OS_UNAVAILABLE503且无自动重提；审阅独立执行证据 independent-test.json：stall 请求有界、仅提交一次、requestID 保持不变。 |
| R4 fixture 插件未加载 | fixture 改为专属受控全局配置文件，与现有 account-entrypoint 一致，sandbox/mode保留。role项目配置移除项目plugin，manifest/issued绑定 requiredPluginUrl，bridge create/prompt查询全局配置，缺失精确URL即SCOPE_DENIED。TOCTOU透明wrapper实际hook日志与独立missing-plugin拒绝测试共同证明该边界。 |

另确认硬链接补闸：插件对read和write/edit目标的现存普通文件校验 nlink=1。审阅 independent-test.json，跨档案hardlink读取失败且测试sentinel未到模型，hardlink写/edit失败且外部文件不变。编辑别名负例已增强为同一session先read再强制未授予edit，排除原生先读约束造成假阳性。管理文件及文件目标检查加入 O_NONBLOCK 并拒绝 FIFO/设备等对象，避免校验自身阻塞；路径scope检查先于普通目标打开。

最终TOCTOU脚本保留在 `services/control/test/fixtures/review-toctou.ts`，可用显式Node24通过tsx执行。脚本在泄漏、未实际执行篡改/正向研究回合、或未观察到system hook拒绝时均exit1；修复后exit0。旧红灯原始系统捕获保留为 `review-toctou-red-system.json`，没有被绿色摘要覆盖。

通过范围仅限本首PR的角色项目生成、最小SDK封装与T-ROLE-1～5前置边界；不代表P1-10整体、云验收、桥接重启恢复或真实模型验证完成。控制面必须独占角色配置根，固定部署的全局插件属于可信账户运行时。分离的stat/hash检查不提供针对恶意同UID本机进程任意精确并发换路径的原子隔离，此部署边界仍须保留。

## 收口文档与新增回归复核

再次只读对照 `docs/spikes/SPIKE-1-decision.md`、`docs/tasks/P1-10-roles.md`、`docs/questions.md` 的 Q-036～042 与最终生成器、SDK封装、插件及证据：默认拒绝、research覆写、可信全局插件、message-only输入、session-only文件授权、相对edit路径以及不继续其余翻译层功能的停止点均一致。样例 `../../../dossiers/<dossierId>/swarm/own-deliveries/*` 从 `/data/roles/<dossierId>/swarm-critic` 解析至正确档案目标；样例ask权限与实际grant/不自动应答pending策略相符。

发现一处非阻断说明措辞：SPIKE目录树最初称账户启动脚本注册插件“与provider”，而现有 account-entrypoint 直接写入的仅plugin及可选model；真实provider路由部署不应因此被视为本PR已交付。已反馈父任务修正文案，属于范围说明校准，不改变角色边界通过结论。

评审者以显式 Node24 单独重跑 `role-system-race.test.ts` 和 `role-special-file.test.ts`：2文件/2测试通过，耗时16.28秒。前者通过Vitest执行真实固定npm内核的TOCTOU脚本，要求已发生正常研究回合和实际篡改、无sentinel泄漏并观察到system hook拒绝；后者创建真实FIFO，直接验证插件数据路径与生成器管理文件校验有界失败，不能将此项单独称为真实模型验证。首PR角色边界复审通过结论维持，无新增阻断发现。

最后增量核对：插件在读取 `policy.tools[tool]` 前新增 `Object.hasOwn(policy.tools, tool)`，仅拒绝继承属性，未增加任何授权路径；task、danger及原有deny检查保持原状。独立重跑增强后的 `role-special-file.test.ts`，1/1通过，包含constructor/toString/valueOf三种未授权原型名拒绝断言与原FIFO检查。SPIKE目录树provider归属文案也已修正。维持前述首PR角色边界通过结论，不扩展验收范围。
