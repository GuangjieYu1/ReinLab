# 28 · 创作台 MVP-1C · 给 Claude 的开场

日期：2026-11-09。分支：`codex/creative-1c`，从 main `90deabc` 拉出；后端提交 `e9d61ae`。
输入：
- [19-creative.md](19-creative.md) §7、§10 的 1C 行、§11 的 1C 验收；
- [20-creative-contract.md](20-creative-contract.md) **§6**：类型、接口、事件、页面、验收（页面部分 §6.5 归你）；
- [27-creative-1c-brief.md](27-creative-1c-brief.md)：DSH 这一批的边界；
- 本文：后端**实际**长什么样、验收数据在哪、每个面板按钮对应哪条接口。

**这一批和 1B 不同：1C 的前端还没做**（契约 §6.5 整节都要接）。所以这次的开场是「接线 + 验收」二合一。

## 一、打开哪一份（数据已经造好）

试用账户 B，世界观 **`dc55c5ff-0e39-4455-b725-dfe1b824a3a9`**：
- 版本：v1、v2、**v3**（`v3：阊门北移约 300 米、出阊门提前一小时`）。
  v3 是「当前草稿成版」，所以除了上面两条，还带着 1B 验收期间没成版的改动（老周、西门、陈掌柜、阊门外渡口、年号事件、夜间规则）——`changes = 13` 条，页面要按 13 条分组列，不是 bug。
- 《阊门夜行（原创短篇）》`a2547ae6…`、《1B 页面验收 · 河边访友》`59febbea…`：**都 baseVersion 2**（仍用旧版），**都引用了「出阊门」**，正文里都写了「阊门」。
- 另有三部作品（聊斋选篇、大纲门、聊斋再导入）也 baseVersion 2，影响面板会一起列出来。
- **扫正文已经跑过一次**（完成、¥0.0397），所以「可能受影响」区现在有内容：13 条里 3 条有线索，阊门那条有 4 处，含「…下在阊门的青石板上…」这句没明确引用的。

要重造：`pnpm tsx tooling/creative/seed-1c.ts`（幂等，不会二次挪位置）。

## 二、接口 ↔ 页面（§6.5 每块对着做）

| §6.5 的块 | 接口 / 操作 |
|---|---|
| 版本列表、点开看条目变化 | `GET /v1/creative/worlds/:id/versions/:n` → 带 `items`（每条 `change` 增删改、`fields` 改了哪些字段、`before/after` 完整内容）；`GET .../versions` 在快照的 `versions` 里 |
| 「保存为版本」先看草稿差异 | `GET .../versions/draft` → `{items}`；确认后 `POST .../versions {summary}` |
| 存完提示「有 n 部作品可能受影响」 | 事件流里的 `creative.version`（data 就是那条 `WorldVersion`）；哪几部基于旧版：`GET .../works` 看 `baseVersion < 新版本号`，或直接开影响面板 |
| 影响面板 | `GET .../impact?from=&to=` → `items[]`：`group` 分组、`sure[]`（确定受影响，scene 带 workId/章/场/段/原句）、`maybe[]`（AI 找的，带原句和理由）、`works[]`（`uses`、`decision`、`checkAfter`） |
| 「让 AI 扫一遍正文」 | `POST .../impact/scan {from,to}` → 202 `{state:'running',cost}`；轮询 `GET .../impact` 的 `maybeScan`，或听 `creative.impact` 事件（进度+花费）；`state` 为 `none/running/done/failed` |
| 跟着改 / 保留旧版 / 改设定 | 作品 ops：`{op:'setting.follow'|'setting.keep', itemId, toVersion}`；「改设定」不带操作，回世界观面改草稿存新版本（影响清单按新版重算） |
| 整版跟进 | `{op:'setting.follow_version', toVersion}` |
| 作品头部「基于 v1 · 采用 2 条 · 改写 1 条 · 待同步 3 处」 | `Work.setting`（`baseVersion/picks/overrides/decisions/pendingSync`） |
| 正文 sync 标注 | `Scene.marks[kind:'sync']`，`refId = itemId`；处理完（接受改稿或「不用改」）自动消失 |
| 「让助手改」 | `{op:'sync.suggest', itemId, sceneIds}` → 202（起一条生成任务，结果进「待确认 · 正文改稿」，batchId 是 `sync_<itemId>`）；接受那条 `text_edit` 后待同步自动消 |
| 「这里不用改」 | `{op:'sync.dismiss', itemId, sceneId, reason}` |
| 本作品改写 / 取消 / 推广 | `{op:'override.set', itemId, kind, patch, note}`、`{op:'override.remove', itemId}`、`{op:'override.promote', itemId}`（推广产出普通世界观提议，进待确认） |
| 世界观面看条目「被哪些作品改写」 | 快照条目上的 `overriddenBy: [{workId, workTitle}]`（只在当前草稿，历史版本不挂） |
| 「按作品看」 | `GET .../works/:workId/effective` → 同快照形状；条目带 `setting: 'base'|'picked'|'override'`；`world.work` 里带 `baseVersion/picks/overrides`；`check` 是按组合现算的 |

写操作照旧：`X-ReinLab-CSRF: 1` + 每次新 `Idempotency-Key`；作品 ops 用作品 `revision`，世界观 ops 用世界观 `revision`；409 都带最新值。

## 三、验收（§6.6 七条）怎么点

1. 世界观面 → 改「阊门」位置、「出阊门」时间 → 存版本前看到草稿差异（应该有这两条）→ 存 v4（v3 已存，你可以直接存 v4 验「再改一次」）；
2. 影响面板：两部作品都在；点「确定受影响」的场景能跳过去；扫一遍正文，找到没明确引用的「阊门」段落（参考：阊门 4 处）；
3. 《阊门夜行》跟着改 → 头部显示「采用了 1 条 · 待同步 n 处」→ 正文橙线标 sync → 「让助手改」→ 接受 → 待同步减 1；
4. 《河边访友》保留旧版 → 「按作品看」时阊门还在老坐标，check 不变；
5. 「改设定」回世界观面再改一次存新版本 → 影响清单按新版本重算；
6. 在《阊门夜行》里对「顾嬷嬷」做本作品改写 → 世界观面看她显示「被《阊门夜行》改写」→ 推广 → 待确认多一条提议；
7. v1、v2 只读还能打开；刷新后决定/组合/待同步都还在。

## 四、已知的边界（不是 bug，按这个判断）

- `WorldVersion.changes` 现在是**条目数**（v1/v2 的历史数字会变小），不是操作数。
- `effective` 是世界观快照，**没有正文**；作品正文仍在 `/works/:workId`。
- `sync.suggest` 是**整场改写**，没有逐段范围；提议的 batchId 是 `sync_<itemId>`。
- `override.patch` 是**顶层浅合并**（改地点位置给 `patch: {place: {...}}`）。
- `pendingSync` 是「条目 × 场景」对数；处理过的不会再冒出来。
- 扫正文要两个版本都已存；`maybe` 只是线索，作者忽略后记在 `syncDone/decisions` 里。
- 新用量用途 `creative_scan`（扫正文花费单列），账单页按用途展示时带上。
- 1A/1B 的页面不受影响：`setting`/`overriddenBy` 都是可选字段，`marks` 只是多了一种 `sync`。

## 五、命令

```bash
pnpm local:up22 --lan --real-models                          # 整栈（迁移 202611100001 已应用）
pnpm tsx tooling/creative/seed-1c.ts                         # 重造 1C 验收数据（幂等）
npx vitest run services/control/test/creative-*.test.ts      # 101 条
```

## 六、交回来什么

1. §6.5 里没接上的块（一条一句）；
2. §6.6 七条的通过情况；
3. 给 DSH 的后端清单（现象 → 断点 → 期望），没有就写「无」；
4. 扫一次正文的实际花费，和 ¥0.04 对一下。
