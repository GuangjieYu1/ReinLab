# 第二批审查（D-1 修复 + P1-10 首个 PR：T-ROLE-1～5）

- 日期：2026-10-20
- 审查方：Claude
- 被审对象：Codex 工作树 `research-foundation`，分支 `codex/p1-10-role-boundaries`，提交 `eedd591`（PR #11、#12）
- 依据：[BATCH1_REVIEW.md](BATCH1_REVIEW.md) 中「进入 P1-10 前」的三项，以及 Q-032 的批准条件

## 结论

**通过。D-1、D-2 关闭，T-ROLE-1～5 通过，可以继续 P1-10 其余的翻译层功能。** 但下面的 D-3 必须在 P1-10 剩余部分的第一个提交里修掉，D-4 在 P1-10 结束前修掉。

## 审查方亲自复核的内容

| 项 | 方法 | 结果 |
|---|---|---|
| 全量测试 | Node 24.14.1 下默认并行跑 `pnpm test` **连续 3 次** | 3 次都是 **714 / 714**，0 失败 |
| Node 22 | 本机没有装 Node 22 | 没有复跑。采信 Codex 的 Node 22 证据（1 次全量 + 连续 5 次，每次 680/680） |
| 依赖边界 / 类型 | `pnpm lint`；contracts、control 两个 tsc | 通过 |
| 回合间篡改（TOCTOU） | 自己跑 `review-toctou.ts`（真实 npm 版 OpenScience 2.0.150 + 本地假 provider） | exit 0：篡改确实发生，第二个研究回合在发给模型之前被 `system.transform` 拦下，另一个角色的 sentinel 没有泄漏 |
| T-ROLE-1 样本 | 解析 `model-requests.json` | alpha 的 system 只含 alpha，beta 只含 beta；第二个请求是生成标题用的，两边都不含；给模型的工具只有 `read` |
| D-1 修复代码 | 读 `db/database.ts` 的 diff | 只在 BEGIN / 设账户上下文阶段、并且是明确的断连错误时重借**一次**；业务回调一旦开始、或在 COMMIT 阶段失败，一律直接抛出、不重放。符合要求 |
| 角色生成器 | 读 `role-project.ts` | 先 `"*": "deny"`；`task` 和 danger 一律 deny；`external_directory` 用路径规则；拒绝 `.git` 祖先；配置全文拒绝 `{file:` / `{env:`；管理文件必须是普通文件、只有一个硬链接、摘要一致。符合 Q-032 的条件 1–3 |
| 插件补闸 | 读 `plugins/reinlab-os-plugin/index.js` | 每次模型回合前和每次工具执行前都重新校验；按白名单检查工具名；读 / 写都核对真实路径和硬链接数；多文件补丁工具一律拒绝 |
| 实施说明 | 读 `docs/spikes/SPIKE-1-decision.md` | 有目录树、生成定义样例、与上游的差异和补闸。满足 Batch-1 的要求 2 |
| 新问题 Q-036～042 | 读 `docs/questions.md` | 7 条都由 Codex 自行处理、有证据，没有需要用户决定的 |

Codex 自己的独立评审（`evidence/P1-10/review.md`）先判「不通过」，发现了 4 个真问题：

- 配置引用会展开文件内容（R1）；
- 角色说明文件在回合之间可被换掉（R2）；
- SDK 请求没有超时（R3）；
- 测试里的插件根本没加载，前面的证明其实无效（R4）。

这 4 个都已修复，红灯证据也都保留了。这一点值得肯定，尤其 R4：如果没被发现，T-ROLE-3 就是假绿。

## 缺陷

| 编号 | 级别 | 位置 | 描述 | 要求 |
|---|---|---|---|---|
| D-1 | 关闭 | — | 连接池重借已断开连接的竞态已修复，失败时会打印 stderr（已脱敏）。审查方连续 3 次全量全绿 | — |
| D-2 | 关闭 | — | 结论：问题与 Node 版本无关 | — |
| D-3 | **Sev3** | `services/control/src/bridge/openscience/role-runtime.ts:26` | 正式代码里的 `prompt()` 写死了 `delegation:true`。实施说明里说这是「为测试开启」，但它在生产路径上。现在防内置委派全靠 `task: deny` 这一道权限规则，少了一层冗余 | 生产默认 `delegation:false`；需要证明「拒绝来自权限规则、而不是这个总开关」的测试，通过一个只在测试里用的构造参数打开。两种情况各保留一个测试 |
| D-4 | Sev4 | `role-runtime.test.ts`、`independent-role.test.ts`、`role-system-race.test.ts`、`fixtures/review-toctou.ts` | 跑一次普通的 `pnpm test`，就会改写已提交的 `evidence/P1-10/*.json`（审查方复跑后有 3 个文件被改，已用 `git checkout` 还原）。证据会被悄悄覆盖，工作区也被弄脏 | 默认写到临时目录；只有设置了明确的环境变量（如 `REINLAB_EVIDENCE_OUT`）才写进 `evidence/` |

## 观察（不阻塞，但要记进后续范围）

1. **重启后的恢复还没测。** `RoleRuntime.sessions` 是内存里的 Set。T-ROLE-5 目前只证明了「同一个实例、请求已完成」时的幂等重放。P1-10 结束前要补三种情况：
   - 控制面重启后恢复会话绑定；
   - 请求还在进行中时被重放；
   - 内核重启后重放。

   这三种都要能拿到原收据，并且不会重复执行。
2. **代码可读性。** `role-project.ts` 和插件是安全边界的核心，却几乎都写成一行一个函数，审查成本很高。建议这类安全模块按正常的换行和缩进排版（不改逻辑）。后续审查会把可读性算进 Sev4。
3. **多文件补丁工具（patch、apply_patch、multiedit）目前一律拒绝。** 首个 PR 这么做可以接受；P1-11 做正式受控工具时要逐个路径校验后再放开。
4. **CI。** 审查方本机的 `gh` 没有登录，GitHub 公开接口也被限流，所以没能亲自核对：
   - run 39279672175（最终证据提交 `eedd591`）的终态；
   - 实现提交 `df7a3bc` 的 CI 成功。

   后者采信 Codex 下载的产物摘要。`eedd591` 只改了证据文件，Codex 已逐项核对源码摘要一致，所以不阻塞；仍请 Codex 在下一次汇报里贴出它的终态。
5. **部署前提（保留，不是缺陷）。** 角色目录必须由控制面独占。「先检查、再读取」防不住同一 UID 下的恶意本机进程精确并发地换文件，Codex 的文档已经如实写明。后续任何文档都不得把这一点称作操作系统级隔离。

## 下一步

1. Codex 继续 P1-10 的其余部分，第一个提交修 D-3。
2. D-4 和观察 1 在 P1-10 结束前完成，作为 P1-10 送审的门槛。
3. 用户待决事项不变：Fly / Supabase 东京 staging（Q-006 / 012 / 029）、三档模型和汇率（Q-021）、费用预估的假设（Q-025）、无头脚本入库（Q-005）。
