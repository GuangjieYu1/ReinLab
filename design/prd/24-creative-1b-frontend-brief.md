# 24 · 创作台 MVP-1B 前端 · 给 GPT 的交接开场

日期：2026-11-07。后端已交付：分支 `codex/creative-1b`（8 个提交，最新 `18ed0a7`）。输入：
- [20-creative-contract.md](20-creative-contract.md) §5：1B 的类型、接口、事件、页面（以它为准）；
- [19-creative.md](19-creative.md) §5、§6、§10、§11：范围与验收；
- 本文：后端**实际**长什么样、以及我踩过的坑。

本机栈照旧：`pnpm local:up22 --lan --real-models`（前端 :5183、控制面 :3001、Postgres :54322），页面一律走 `/backend` 前缀、认 Cookie。写操作带 `X-ReinLab-CSRF: 1` 和**每次新换**的 `Idempotency-Key`；错误体是 `{ code, message }`，422 的 message 直接显示在字段旁。

## 已经能调的接口（作品面，`/v1/creative/worlds/:id` 下）

| 契约 §5.2 | 实际调用 | 备注 |
|---|---|---|
| 作品列表 | `GET /works` | `Work[]`，**不带正文**（省带宽），带 `baseVersion/words/outline/chapters` |
| 建作品 | `POST /works {kind:'novel',title,targetWords?}` | 201；`baseVersion` = 建时最新版本号（没有版本就是 0，照实显示） |
| 作品详情 | `GET /works/:workId` | 带 `Scene.text` 与 `Scene.marks` |
| 改作品 | `POST /works/:workId/ops {baseRevision, ops: WorkOp[]}` | 回 `{revision, work}`；落后 409 `REVISION_STALE`（`body.revision` + `body.work` 是最新） |
| 导出 | `GET /works/:workId/export?format=md\|docx` | 直接是文件（`Content-Disposition`），md 是 text/markdown |
| 生成 | `POST /works/:workId/generate {sceneIds,mode,hint?,range?}` | 202 `GenerateJob`；`mode` = `draft/continue/complete/rewrite`；`GET .../generate/:jobId`、`POST .../generate/:jobId/stop` |
| 导入 | `POST /works/:workId/import {assetId}` 或 `{text,title?}` | 202 `ImportJob`；`GET /imports/:jobId`、`POST /imports/:jobId/pause`、`/resume` |
| 上传原文 | `POST .../assets {name, content, format:'text'}` | 201 `{assetId}`；content ≤ 8 万字符/8 MB（其余接口仍 1 MB） |
| 待确认 | `GET .../proposals?kind=&batchId=&doubt=&status=&cursor=&limit=` | `{proposals, nextCursor}`；默认只给 pending/deferred |
| 助手 | `POST /v1/kernel/runs {dossierId, query, mode:'creative_advisor'\|'creative_writer', workId?, sceneId?}` | 201 `{id, sessionId:null, resume:null}` |

**接受/拒绝提议**：世界观那一套 ops —— `{op:'proposal.decide', id, decision:'accepted'|'rejected'|'deferred', candidate?}`，提交到 `POST /v1/creative/worlds/:id/ops`（一批 ≤ 40 条）。唯一例外：`text_edit` 类提议**不能用**它接受，要走作品的 `text.accept`。

**WorkOp 全量**（`packages/contracts/src/creative.ts` 的 `WorkOp`）：
`work.set`、`outline.set`、`outline.confirm`、`chapter.add/update/remove/move`、`scene.add/update/remove/move`、`text.set{sceneId,baseTextVersion,text}`、`text.accept{proposalId,text?}`。

**事件**（世界观流 `/v1/creative/worlds/:id/stream?after=cursor`，帧就是 `{seq,at,dossierId,type,data}`）：
1B 新增 `creative.work {workId,revision}`、`creative.text {workId,sceneId,state,textVersion}`、`creative.import`（整个 `ImportJob`）、`creative.generate`（整个 `GenerateJob`）；1A 的 `op/check/proposal/leg/network/usage` 照旧。

**助手会话**（按契约走运行流）：建完之后订阅 `GET /v1/kernel/runs/:id/stream`（帧 `{seq,action,payload}`），对话在 `user/message` 与 `assistant/message` 里，文本在 `payload.message.content[].text`；也可以用 `GET /v1/kernel/runs/:id/events?after=`。助手只产出提议，不会自己落笔。

## 这些坑别踩

1. **两套 revision，别混**：改作品用**作品**的 `revision`；接受/拒绝提议用**世界观**的 `revision`。接受正文提议会同时 bump 两边的 revision。
2. **正文版本**：`text.set` 要带 `baseTextVersion`（就是那个场景当前的 `textVersion`），不对回 409 `TEXT_VERSION_STALE`——照提示重新取一次作品再写，别静默覆盖作者刚写的东西。
3. **生成慢**：一场 20–60 秒。别在页面上等死：拿 `jobId` 轮询 `GET .../generate/:jobId`（1–2 秒一次）或者听 `creative.generate`；`done` 里是已完成的场，`stopped` 表示停住了。生成前必须 `outline.state === 'confirmed'`，否则 409 `OUTLINE_NOT_CONFIRMED`。
4. **生成结果只是提议**：正文不会自己进 `Scene.text`。`text_edit` 提议的 `ops[0]` 是 `{op:'text.set', sceneId, baseTextVersion, mode, range, before, after}`，把 `before/after` 做成差异给人看；接受走 `text.accept`，带 `text` 就是「改后接受」。
5. **改写（rewrite）要带 `range`**（段落下标 + 段内起止），服务端按这个范围取原话；不带 range 的改写等于整场重写。
6. **导入**：一章一场，原文直接写在 `Scene.text` 里（`state='written'`）。一章 30–90 秒；进度看 `ImportJob.chapters.done/total` 和 `current`。暂停/续做就在任务上，**控制面重启过的任务会自动变成 `paused`**（错误写「任务中断（服务重启），可以继续」），页面点继续就行。
7. **提议可以按批次筛**：导入的每章一个 `batchId`（`import_<章id>`），生成的每批一个（`generate_<jobId>`）；`doubt=true/false` 筛「有疑点 / 无疑点」，批量接受就按这个筛完再提交（≤40 条）。
8. **候选**：别名、共指、古地名这类提议带 `candidates[]`，每项有自己的 `label/why/ops`；用 `proposal.decide` 带 `candidate: 下标` 就是「选这个候选」。
9. **`Scene.marks` 是服务端算好的，你只画**：`kind` 是 `entity/event/conflict/stale_source`，`para/from/to` 定位到段内区间，`refId` 指向实体/事件/冲突/提议。`stale_source` 表示那条提议的原文句子在正文里已经找不到了（正文改过）。
10. **事件的 `workRefs`** 会反向带上「哪部作品的哪一章哪一场」，事件详情里直接列出来；点正文里的 `event` 标就跳世界观面。
11. **断线恢复**：世界观流用快照里的 `cursor` 续；运行流用 `seq` 续。两边都是跳号就重取。
12. **别在前端算**：字数、冲突、路程、故事时间换算、进度、花费全是服务端给的（`words/conflicts/marks/cost`），页面只显示。

## 页面（契约 §5.4 的落点）

- 左栏：作品切换 + 卷→章→场景树 + 字数/目标（`work.words` / `targetWords`，场里也有）。
- 中间：正文。作者直接写 → 失焦/停顿 2 秒 `text.set`；选中一段 → 续写/改写（`generate` 带 `range`）；AI 结果按差异显示，接受才落笔。
- 右栏：本场目标与引用事件、待确认（按批次/种类/疑点筛）、助手（`kernel/runs` 会话，`workId`+`sceneId` 带上）。
- 大纲确认卡：`outline.set` 可反复改，`outline.confirm` 之后才建章建场、才能生成；确认大纲不等于入账，新设定仍在待确认。
- 导入向导三步：上传/粘贴原文（`assets` 或直接 `{text}`）→ 看分章结果（`ImportJob.chapters.total`，导入后作品里能看到章）→ 开始，可暂停/续做。
- 花费：`ImportJob.cost` / `GenerateJob.cost` 是 `{value, known}`，`known:false` 就是「用量未知」，显示未知，别显示 0。

## 验收世界（试用账户 B，可直接打开）

**`dc55c5ff-0e39-4455-b725-dfe1b824a3a9`**《阊门到山村 · 旧河道考》
- 作品一《阊门夜行（原创短篇）》`a2547ae6…`：大纲已确认，两场真生成已接受（1568 + 1426 字），有实体标注，两场各自引用了「出阊门」「到山村」。
- 作品二《聊斋志异 · 选篇（宅妖 / 王六郎 / 画皮）》`ad498de7…`：3 章 3,503 字，导入跑完，待确认 74 条——别名（王俊升 → 王生俊升/王生）、年号（康熙十七年）、古地名候选（淄之北郭 → 淄川、招远县 → 招远市）都有样本。
- 一条顾问提议（西门老兵/货郎），带疑点 + 试算的硬检查结果。
- 想重造：`pnpm tsx tooling/creative/seed-1b.ts`（真模型，约 ¥0.2）。

## 两条可以问我的地方

- 事件参与者/地点除了 id 也接受 `entityName/placeName`（导入和顾问的实体还在待确认里，没有 id，前端**不用**自己解析名字，原样提交）。
- `Proposal.resolution{decision,reason,at}` 记录处理结果和原因（比如「这段路你手绘了，这条推断提议作废」），处理过的提议别只当消失，可以显示一行原因。

## 不做

- 不改后端接口与语义（契约 §5 是准）；要改先回来说。
- 不做 1C（逐条版本、影响分析）、出图、白模。
- 不在前端推断冲突、路程、时间换算、版本组合。

## questions · 前端接入实测（2026-11-07）

- 实际生成状态/停止路由为世界观下 `/generate/:jobId`、`/generate/:jobId/stop`（不在 `/works/:workId` 下），前端已按实际接线。
- 导入目前没有独立分章预览接口：前端先预览原文，开始后展示服务端分章；要在开始前预览分章需 DSH 补接口。
- 最后一章执行中暂停，可能留下 `done=total`、`state=paused`，继续返回「已经抽完」；正文和提议已保存，请 DSH 修正末章暂停的终态。
