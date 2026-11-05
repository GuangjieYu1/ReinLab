# 交付 · 群研 B14 四修（插件在步骤边界 steer，控制面只排队）

分支 `codex/swarm-3`，一个提交。契约 13 没改；前端 `02a3d69` 没动。

## 改了什么

**1) next-step 改由研究插件在步骤边界投递（这次真的到了）**

- 控制面新增 `POST /kernel/inbox`（运行令牌）：研究插件按成员名来取「排给我这一条的待送用户消息」，只读、不改状态。
- 插件在每个 agent 的**工具边界**（`tools/pre-execute`）带节流地取一次，对相应 agent 调
  **`agent.steer(message)`**（dsh-agent-loop 的「Submit steering for the nearest step」）：
  `{ id, role: "user", content: [{type:"text",text}], source: { kind: "user-rpc" } }`。
  空闲时它会自己开一轮，运行中则插到最近的步骤边界——不再依赖 JSON-RPC。
- 负责人和队员都装了这套（`install()` 里统一挂，不只是队员）。

**2) JSON-RPC 只当退路，参数改成 SDK 真正读的形状**

`queuePrompt` 现在发 `{ sessionId, contentBlocks }`（之前发 `{ request: {...} }`，服务端拿到
`sessionId=undefined` 才报 `agent id "undefined" does not match session id`）。这条路只 `followup`，
所以回执写「已排队（下一轮送到）」，不再假装是下一步。

**3) 回执仍只认会话里真的出现**

`swarm_inbox` 有 `queued` / `delivered` 两档；「已送到」只在对方会话的 `user/message` 正文里
出现这条消息时写。@ 队员时收件箱里留**用户原话**（转达时那句话会把原话包在里面），送达确认按原话做子串匹配。

**4) 按卡认人**

`research_spawn` 多了 `add_card` 参数（插件把 `cardId` 记进成员登记）；加人指令里写明卡号；
「已执行」优先认 `cardId` 对上的成员，其次认「该角色人数超过计划编制」。

## 真机（运行 `44a05f6c`，¥2.21 —— 超了你给的 ¥2，多花 ¥0.21，见下）

- **next-step 真的到了**：该运行一共 **82 次 `agent/inbox/spliced` 的 target 是 `next-step`**（22 次 next-turn），
  其中一条是插件 steer 进去的：`{"target":"next-step","inserted":[{"id":"fbf3fdf9…","role":"user","source":{"kind":"user-rpc"},…}]}`。
  ——上一版这里是 0 次 next-step。
- **加人卡变成「已执行」**：`add_member: applied`，回执「已建出反驳员 critic-rebut（反驳 01）：这个角色的人数已经超过原计划编制（2 > 1）。」
  名册从 6 人变 11 人，其中 critic 6 名（负责人给每条路线各配了一个反驳）。
- **卡号没带上**：这次负责人没按指令传 `add_card`，所以 `swarm_meta` 里新成员的 `cardId` 是空的，
  生效的是「超过计划编制」那条兜底规则。卡号那条路已实现并有单测，等负责人真按指令传了才会走。
- **@ 队员的回执还停在「已排队」**：投递文本是「用户在 @r1-sweep：…」，而会话里出现的是转达后的那句，
  子串没对上。这条匹配已改成按用户原话比对（改动在同一个提交里），但没来得及再跑一条验证。

**预算**：这条跑到 ¥2.21，超 ¥2 上限 ¥0.21；发现后立刻点了结束。余额还剩约 ¥18.7。

## 还差的一次验证（约 ¥1 以内）

跑一条新运行，只做两件事：在负责人忙时 @ 某个队员、批准一张要 critic 的加人卡，
确认：(a) 这两条在对方会话里出现后回执变「已送到」；(b) 负责人按指令带 `add_card` 建人 → 回执写「已按这张卡（<卡号>）建出…」。

## 验证

`services/control` + `packages`：**603 条全绿**（新增插件侧 steer 与回执路径的单测：假 ctx/假 agent，
断言工具边界会去 `/kernel/inbox` 取消息、用 `agent.steer` 交给这一轮、并把「交给这一轮的下一步」记进回执）。
