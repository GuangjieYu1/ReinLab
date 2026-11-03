# 交付 · 群研 MVP-3 第二批二修（B13 原生收件箱投递）+ 四处小修

分支 `codex/swarm-3`，一个提交。契约 13 没改；前端 `02a3d69` 没动。

## B13：用户的话走 DSH 原生收件箱，不再塞进工具返回

**原因**：上一版把待送消息并进了「下一次工具调用的返回」，而那一次调用可能是**任何人的**——
核实员先调工具，给负责人的「改方向 / 加人」就落进了它的结果里，它当然当成可疑注入拒绝；
@ 研究员 01 那句则因为按「谁先调工具」找收件人，谁也没拿到。

**改法**：

- 投递走 **DSH 原生的 prompt 收件箱**：`DeepSeekHarness.client.prompt(sessionId, blocks)` ——
  消息按**收件人的会话**排队，运行时在它的步骤边界把 `agent/inbox/spliced` 插进去；负责人那边就是一条用户消息。
- 收件人按名字解析会话：队员用名册里的会话 id，负责人用 `lead_session`。
  队员是团队里的子会话，直接 `prompt` 会被运行时拒（`session … already exists`），这时退一步：
  把这句话排进**负责人**的收件箱并请它用 `send_message` 原样转达——仍是原生收件箱，只是经负责人转一手，回执会写明「已交给负责人转达给 X」。
- **工具返回注入这条路整条删掉**（`kernel-tools` 的 `swarmInbox` 钩子与 `app.ts` 的接线都没了）。
- **送达以会话里真的出现这条消息为准**：投影时读 `agent/inbox/spliced` 的 `inserted` 与 `user/message`
  的正文，匹配到才把收件箱条目与干预改成 `delivered`；排不进队列就写 `failed` + 原因。

## 四处小修

1. **改方向后的新计划带 `diffFrom`**：`{ version: 上一版, changes: [...] }`，按「研究问题 / 范围 / 路线增删改 / 额度」逐条生成。
2. **暂停原因写人话**：额度、网络、回答超长、运行时崩溃各一句，不再把 `exit code: 255 … MODULE_TYPELESS_PACKAGE_JSON` 贴给用户。
3. **状态说明里的空路线名**：`stop_route` 现在从计划 / 路线登记里取标题，取不到就用 id，不再出现「已停止路线 ：需要新机制才能重开」。
4. **exit 255 的原因查清了**：控制面日志里那段 `TypeError: terminated … [cause]: Error: read ECONNRESET / ETIMEDOUT` 就是它——
   DeepSeek 上游**流式响应中途被重置**时，DSH 运行时里的 undici 抛出的 `terminated` 没人接，进程以 255 退出（已见三次）。
   运行时内部那段我们改不了，但能做的一半已经做了：模型转发代理现在把上游断流包成「发一个 SSE error 事件再正常收尾」，
   运行时看到的是干净的结束（它的重试策略会接手），而不是一个被硬扯断的 body。

## 真机证据（运行 `364bbb89`，档案 `60f1497c`，¥6.62）

负责人在跑第一轮/第二轮时，依次做三件事：

| 操作 | 回执 | 证据 |
|---|---|---|
| `@研究员 01`（r1-curve） | `received`「已交给负责人转达给 r1-curve」→ **`delivered`** | `swarm_inbox`：`target=r1-curve, state=delivered, reason=queued:a42f3b88…`（SDK 的排队身份） |
| 改方向「只看相同总 token 预算下的比较」 | `received`「已排进负责人的收件箱」→ **`delivered`** | `swarm_inbox`：`target=lead, state=delivered, reason=queued:b735143e…`；该运行共 **206 条 `agent/inbox/spliced`** |
| 加人（critic）批准 | 卡「指令会在下一步送到」→ **`applied`** | 名册 **7 → 10**；干预 `add_member: applied` |

改方向被消费之后，负责人交上来的新版本是 **plan v2**，带 `diffFrom`：

```json
{ "changes": [
  "研究问题：在 LLM 多智能体系统…增加 agent 数量是否一定提… → 在「总 token 预算相同」的条件下…",
  "范围：包含：已发表的 LLM 多智能体实证论文中，凡报告了 agent 数量…"
] }
```

运行现在是 `paused`（我重起栈时把这一轮打断了），36 条结论、10 名成员、plan v2 都在，点继续就能接着跑。

## Claude 的复现步骤

1. 打开运行 `364bbb89`：干预列表最后四条是 `mention: delivered`、`redirect: delivered`、`add_member: applied`、`resume`；
   计划卡是 **v2**，且有 `diffFrom`（页面可以出差异卡）；名册 10 人。
2. 自己走一遍：新建群研 → 确认计划 → **在负责人跑第一轮时**依次 `@某队员`、点「改方向」（收窄口径，比如「只看同预算」）、
   在收件箱批准一张加人卡。期望：三件事先显示「已排进收件箱 / 已交给负责人转达」，随后都变「已送到」；
   负责人这一步会看到它们并照做——新计划 v2 带差异、名册多出一人。
3. 负责人那一轮若被网络打断，群研应显示「已暂停」+ 人话原因（额度 / 网络 / 回答超长 / 运行时崩溃），不是原始报错。

## 验证

`services/control` + `packages`：**601 条全绿**。覆盖：忙时三件事只排队、排进收件人会话、送到才 `delivered`、
加人真多出人才 `applied`、负责人挂了转 `paused` 且原因不含原始报错、`diffFrom` 与自动继续。
