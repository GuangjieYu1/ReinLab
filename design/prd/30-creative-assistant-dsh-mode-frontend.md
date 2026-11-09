# 30 · 1C 验收四条 + 29 号助手（DSH 模式）· 给 Claude 的交接

日期：2026-11-09。分支：`codex/creative-1c-front`，后端提交 `ecfb578`。104 条测试通过，栈在跑。

## 一、页面要改的地方（就三处）

1. **助手改成「续一句」**：建会话仍用 `POST /v1/kernel/runs { dossierId, query, mode, workId?, sceneId? }`；
   之后每发一句改调 **`POST /v1/kernel/runs/:id/messages { query }` → 202 `{id, state:'running'}`**，
   回复还是写在同一条事件流里（`user/message`、`assistant/message`），按 `runId` 订阅不变。
   一轮结束后 run 仍是 `completed`，可以继续续；想新开就再建一个 run。没有自动过期。
   回复是模型写的 Markdown（列表/表格/加粗都可用），页面现有排版够用。
2. **新增「让模型判规则」**：`POST /v1/creative/worlds/:id/rules/judge`（无 body 也行）→
   `{ judged, skipped, cost, check }`。结果并进 `check.conflicts`，`kind: 'rule_model'`、`severity: 'suspect'`
   （黄色、附原句和理由），自动显示在检查面板。我已在 `Panels.tsx` 的 `KIND_ZH` 加了一行
   `rule_model: '规则（模型判的疑似）'`（类型兼容，不动样式）。建议放在检查区旁边，标上花费。
   规则和事件没变时再点不花钱（返回 `judged: 0`）。
3. **1C 那几条不用改页面**：影响面板、按作品看、sync 标注都只是后端修好了，接口形状没变。

## 二、四条验收问题现在什么样（可以直接复验）

- **C1 影响清单**：`GET .../impact?from=2&to=3` 从 22 秒降到 **约 1.7 秒**（261KB 不变）。面板不用改。
- **C2 让助手改**：`sync.suggest` 产出的提议带 `range {para,from,to}` 和 `before`（待同步那一段原话），
  接受是**替换那一段**，不再接在末尾；待同步标也落在正确段号。改写找不到原句会回 409 `TEXT_STALE`。
- **C3 按作品看**：`GET .../works/:id/effective` 永远从 `baseVersion` 快照起算 + picks + overrides。
  《河边访友》（baseVersion 2、无 pick）现在是 v2 的阊门坐标、没有老周、出阊门 06:00。
- **C4 timeSpan**：返回最早开始 → 最晚结束（`dc55c5ff` 现在是 1684-04-15 → 1684-05-02）。页面仍可按事件自己算。

## 三、验证步骤

1. **多轮**：顾问里连问三句，第二句引用第一句（「刚才说的第一个人做过什么？」），第三句让它总结；
   看是不是续在同一个 run 里、回复是 Markdown。约 6 秒一轮、3 轮约 ¥0.02。
2. **规则**：`dc55c5ff` 里我已经加了一条「苏州城宵禁：入夜（戌时以后）城门关闭，任何人不得出城。」，
   点「让模型判规则」应出一条黄色疑似（实测会指出「04:30 天未亮出阊门」）；再点一次 `judged: 0`。
3. **C1**：打开影响面板 v2→v3，秒开；按作品看《河边访友》，阊门在旧位置。
4. **C2**：《阊门夜行》里对「出阊门」跟着改 → 待同步 → 让助手改 → 看提议的 `before` 是那段原话 →
   接受后是替换（不是新加一段），待同步减 1。

## 四、边界（按这个判断，不算 bug）

- 助手工具：读（世界观快照、事件搜索、检查、正文、版本差异、读工作区文件）+ 只能交提议的写工具
  （顾问 `propose_setting`、写作助手 `propose_text_edit`）。**没有 bash / 联网搜索**（这一批没开，
  要开回来说）。
- 规则判定是**显式触发**（按钮），不会在每次检查时自动跑；结果按「事件 + 规则」指纹缓存。
- 花费用途新增 `creative_assistant`、`creative_judge`；账单页按用途显示时带上。
- 多轮会话的 token 会随轮数增长（每轮带上历史）；目前没做压缩，长会话到十几轮后再看。

## 五、命令

```bash
pnpm local:up22 --lan --real-models                          # 整栈
npx vitest run services/control/test/creative-*.test.ts      # 103 条
```
