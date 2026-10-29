# 第三批中期审查（P1-10 其余部分 + 本地化 + harness）

- 日期：2026-10-21
- 审查方：Claude
- 被审对象：Codex 工作树 `research-foundation`，分支 `codex/p1-10-translation-complete`
  - 已提交：最新提交 `ed91225`，自 `eedd591` 起共 8 个提交
  - 未提交：工作区有 69 个文件
- 性质：**中期审查**。Codex 自己标为「送审准备稿」：真实冒烟、后台账单核对、CI/PR 都还是 TODO。本审查只看已经做完的部分

## 结论

**已完成部分通过，但 P1-10 还不能关闭。** 关闭 P1-10 前还差三件事：
1. 修好「新账户没有可用的 DeepSeek 模型配置」这个问题（Codex 自己发现的红灯，见 B-1）；
2. 执行一次真实冒烟，并核对后台账单；
3. 提交，并补上 CI 和 PR 的终态。

## 审查方亲自复核的内容

| 项 | 方法 | 结果 |
|---|---|---|
| 全量测试 | Node 22.23.3 下跑 `pnpm test` | **1257 个，1256 通过**。唯一失败的是**未提交**的新测试 `runtime-smoke-native.test.ts`，是 Codex 正在写的红灯（证据 `smoke-guard/native-model-red.json`）。已提交的代码与 Codex 报告的 1256/1256 一致 |
| 依赖边界 / 类型 / 示例模式构建 | `pnpm lint`、两个 tsc、`VITE_BACKEND=mock pnpm build` | 全部通过 |
| T-REG | 用 Codex 分支的前端，在 5198 端口跑 18 个场景 | **18/18 通过**，包括新增的 `live` |
| D-4 | 跑完全量和 T-REG 后看工作区 | 已跟踪的证据文件一个都没被改（全量前后都是 69 个未提交文件） |
| D-3 | 读 `role-runtime.ts` | `delegation` 默认关闭；只有 `testOnlyDelegation` 参数能打开它，而且在非测试环境下打开会直接报错拒绝 |
| 安全底线（T-HAR-1） | 读 `harness/manifest.ts` | `*` 和 `task` 只能设为 deny；danger 工具不能设为 allow；工具和 MCP 能力都必须在注册表里登记过；写目标必须是档案内的纯相对路径；拒绝 `{file:` / `{env:` 插值 |
| 合并规则（T-HAR-2） | 读 `harness/resolver.ts` | 宽严顺序 allow < ask < deny；放宽 = 需要审批；记忆范围只能收窄；预算不超过账户上限；合并后再跑一次安全底线检查。符合 HARNESS.md |
| 决定回填 | 读 `decisions.ts` | 范围只有 once / session，没有 project 和 always；问题卡只能用 once |
| 观察器 | 搜索 observer 和 observation-store | 没有调用任何 `prompt`，符合 CR-3 |
| 凭据 | 扫描整个工作树（含未跟踪文件）里的 `sk-` 形式 key | 0 命中。冒烟脚本只从 `~/.config/reinlab/local.env` 读取 key，账户容器只拿到一次性临时令牌 |
| 新问题 Q-055～061 | 读 `docs/questions.md` | 都是 Codex 自行处理并写明理由的，没有需要用户拍板的 |

## 缺陷与观察

| 编号 | 级别 | 描述 | 要求 |
|---|---|---|---|
| B-1 | **阻塞** | Codex 自己发现：一个全新的账户在提交第一个 prompt 之前，没有配置好可用的 DeepSeek 模型。按现状执行真实冒烟会失败。红灯已保留，修复还没提交 | 修好后先让该测试转绿，再执行冒烟 |
| B-2 | Sev3 | 清单里的 `tunable` 白名单只做了 schema 校验，**执行时没有用上**。resolver 会接受 `write_targets`、`memory`、`dossier_note` 的修改，而研究台清单的 `tunable` 并没有列出它们。目前危险方向的改动仍要审批，所以没有越权，但和 HARNESS.md 第 6 节「只能改 tunable 列出的字段」不一致 | 在 resolver 里按 `tunable` 过滤，不在白名单里的字段一律拒绝（返回 400）；加一个测试 |
| B-3 | 观察 | `write_targets` 里的 `read/layers/`、`findings/`、`experiments/` 不在 `dossier.layout` 里 | 要么把这些目录补进 layout，要么在清单校验里允许并写明理由（建等同于建档案时就有的目录） |
| B-4 | 观察 | 冒烟脚本要求操作者手动传入 DeepSeek 的峰谷价格窗口（UTC 毫秒），对用户门槛太高 | 由 Codex 自己从 DeepSeek 官方价格页查好窗口，在冒烟计划里写明来源和时刻，用户只需要确认 |
| B-5 | 观察 | 未提交的文件有 69 个 | 每完成一个完整的小步就提交，别攒着 |

## 关闭 P1-10 前

1. 修复 B-1，提交。
2. 修复 B-2（可以和 B-1 一起提交）。
3. 按 B-4 准备好冒烟计划；用户确认后，执行唯一一次真实冒烟（上限 ¥1），再核对后台账单。
4. 提交并开 PR，给出所有 CI 运行的终态，包括遗留的 run 39279672175。
5. 然后正式送审，审查方做 P1-10 的关闭审查。

---

## 追加（2026-10-22）：B-1 / B-2 修复与真实冒烟失败

**修复：**
- B-1 修复在 `42bbcd8`，B-2 修复在 `090d2fd`，工作区已全部提交（0 个未提交文件）。
- B-3 按 Q-063 处理：`layout` 是初始目录骨架，`write_targets` 可以指向骨架之外的档案内子目录。审查方接受。

完整复核放到 P1-10 关闭审查时一起做。

**冒烟结果：** 2026-10-22 02:31 执行了唯一一次真实转发，DeepSeek 返回 HTTP 400，提示思考模式要求回传 `reasoning_content`。没有拿到用量，账本记为 unknown / unpriced，没有重试。处理是对的。

**根因判断（审查方读了上游源码）：** Codex 的推断成立。
- 上游 `provider/transform.ts` 只在模型的 API id 匹配 `/deepseek-v[4-9]/` 时，才自动注入 `thinking: {type: "disabled"}`。
- B-1 把 API id 映射成了 `deepseek-flash`，正好绕过了这个分支。于是请求以默认的思考模式发了出去。
- 审查方另外发现：单次冒烟守卫 `one-shot-smoke-guard.ts` 在 `thinking` 字段**缺失**时也放行，只在它存在但不是 disabled 时才拒绝。所以守卫没能拦下这次请求。

| 编号 | 级别 | 描述 | 要求 |
|---|---|---|---|
| B-6 | **阻塞** | 思考模式没有显式关闭，真实请求返回 400 | 在 SDK 的模型配置里**显式**设置 `thinking: {type: "disabled"}`，不依赖上游按 API id 正则自动注入；不改上游源码 |
| B-7 | Sev2 | 守卫在 `thinking` 缺失时放行 | 守卫改为：`thinking.type === "disabled"` **必须存在**，否则拒绝转发。按约定做独立安全评审 |
| B-8 | Sev2 | fixture provider 没有模拟 DeepSeek 的协议约束，所以 1284 个测试全绿，也没能发现这个问题 | 给 fixture 加上 DeepSeek 的协议规则：请求没有显式 `thinking: disabled` 就返回和线上一样的 400。原生测试截获出站请求体，断言 `thinking` 字段确实存在且为 disabled |
| B-9 | 观察 | 后台账单只有按「小时 + 模型 + key」的聚合，同一小时里本机还有其他程序在用同一个 key（如 OpenMAIC），所以没法单独归因 | 建议用户为 ReinLab 冒烟单独建一个 DeepSeek key。账单按 key 聚合后就能精确归因 |

**第二次真实冒烟：** 必须同时满足四个条件才能执行：
1. B-6、B-7、B-8 都已修复，并提交；
2. fixture 截获的出站请求体证明 `thinking` 字段确实被关闭；
3. 用户**重新明确授权**；
4. 换用专属 key（按 B-9）。

上一次的单次标记照旧保留，新一次冒烟使用新的标记和 requestID，并在证据里写明「第二次授权」。
