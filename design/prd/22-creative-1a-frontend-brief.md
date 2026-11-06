# 22 · 创作台 MVP-1A 前端 · 给 Claude 的开场

日期：2026-11-06。后端已交付：提交 `9494261`（分支 `codex/creative-1a`）。输入：
- [19-creative.md](19-creative.md)：已批准的 PRD，1A 范围在 §10，验收在 §11；
- [20-creative-contract.md](20-creative-contract.md)：前端契约，1A 部分是 §1–§4、§7、§10；
- 本文：后端实际长什么样，以及你接页面时要避的坑。

## 后端已经能跑，直接调

- 控制面 `http://127.0.0.1:3001`，前端 `http://127.0.0.1:5183`，页面里一律走 `/backend` 前缀（同源 Cookie）。
- 已有一份能直接打开的世界观（试用账户 B）：**`dc55c5ff-0e39-4455-b725-dfe1b824a3a9`**《阊门到山村 · 旧河道考》。
  里面有：真实 OSM 路网（苏州城西，38,185 段边）、3 个人物、9 条事件、2 个改造层、4 段行程（2 条推断虚线 + 1 条已确认手绘 + 1 条真路网）、2 条待确认路线、1 个版本；
  检查里红黄、信息不足、未覆盖、clean 都有样本。
- 造/重造数据：`pnpm tsx tooling/creative/seed-world.ts`（默认试用账户；`--user A`、`--osm-only`）。
- 建世界观用已有接口：`POST /v1/dossiers { bench:'creative', kind:'workspace', title, intent? }`。

## 适配器（`src/data/creative-live.ts`）八个方法

| 契约 §8 的方法 | 实际调用 | 备注 |
|---|---|---|
| `load()` | `GET /v1/creative/worlds/:id` | 返回 `WorldSnapshot`：`world/entities/relations/events/modes/rules/edits/legs/proposals/check/versions/cursor`；`?version=n` 读历史版本（`check` 为 null） |
| `ops(baseRevision, ops)` | `POST .../ops` | 一个批次原子；回 `{ revision, applied, check }`；落后回 **409 `REVISION_STALE`**，`body.revision` 和 `body.snapshot` 是最新快照，直接拿它回滚界面 |
| `tracks(from,to,ids)` | `GET .../tracks?from=&to=&entityIds=` | `from/to` 是 `StoryTime.t`（分钟数，拿来当下标用），`entityIds` 逗号分隔 |
| `editsAt(t)` | `GET .../edits/geojson?t=` | 这一时刻生效的改造；`properties = { editId,title,effect,style,name,passable,needsRemap, osm?, placeId? }`，**`geometry` 可能为 null**（目标对不上就显示待确认） |
| `check()` | `POST .../check`（body `{}`） | 手动全部重查，回 `CheckRun` |
| `importNetwork(req)` | `POST .../network/import` | `{source:'osm', bbox:[西,南,东,北]}` 或 `{source:'azgaar', assetId}`；回 202 `{jobId}`，进度和结果走 `creative.network` 事件 |
| 上传 Azgaar（契约没写，要你加一个） | `POST .../assets { name, content, format:'geojson' }` | 回 201 `{assetId}`；`content` 是 Azgaar 「Tools → Export → Export to GeoJSON → routes」导出的文本，坐标已经是经纬度 |
| `saveVersion(summary)` | `POST .../versions` | 回 201 `WorldVersion { n, at, summary, changes }` |
| `subscribe(after)` | `GET .../stream?after=seq` | SSE，每帧就是 `{seq, at, dossierId, type, data}`；15 秒一条 `: ping` |

写操作统一带 `X-ReinLab-CSRF: 1` 和**每次新换**的 `Idempotency-Key`（1–200 字符 `[-A-Za-z0-9_.:]`）；同键同体重复提交才是重放。

事件类型（契约 §3）实际都在：`creative.op`（`{revision, applied}`）、`creative.check`（`CheckRun`）、`creative.proposal`（`Proposal`）、`creative.leg`（**完整 `RouteLeg`**，手绘/重画/确认都推）、`creative.network`（`NetworkStatus`）、`creative.usage`（`{ cost: {value, known} }`）。

## 这些坑别踩

1. **推断路线是异步的**：leg 算不出来时服务端自己发起，25 秒到 4 分钟不等。这期间 leg 是 `none` + `failure`，页面照 §4.3 显示「路线待定 · 原因」；收到 `creative.leg` 或 `creative.proposal` 再取。别在前端等、也别自己补一条线。
2. **时间只认服务端**：写事件/改造层时 `start/end/valid` 提交 `{ input: 原文写法, calendar? }`（如 `1684-04-21 08:00`、`第 3 日 08:00`、`出城后三天`）；读回来是 `StoryTime`，只显示 `label`。`t` 只当时间轴下标。服务端解析不了回 **422 `TIME_UNPARSED`**，消息里写了该怎么写。
3. `tracks` 的 `from/to` 用分钟数；`edits/geojson?t=` 同理。别把日期字符串塞进去。
4. 一批 ops 最多 **40 条**。批量修法（「全部处理」）先自己汇总成一批，超了就分批。
5. `check.conflicts[].numbers` 可能只有 `haveMin` 或只有 `needMin`，缺的那个别显示成 0。
6. `check` 的四档 + 最后一行「本次查过、未发现」只列 `clean`；`clean` 表示「这次查过且没发现」，不是「没有矛盾」。
7. 修法必须先展示 `preview`（`before → after`），接受后把 `fix.ops` 原样作为一批提交；`fix.ops` 里可能是 `event.update`、`constraint.drop`、`entity.update`、`proposal.decide` 混在一起。
8. 确认推断路线用 `{op:'proposal.decide', id, decision:'accepted'}`（或直接把 `proposal.ops` 一起带上做「修改后接受」）；确认后 leg 变 `manual`，同一段按硬冲突算——我已在验收世界里验证过一次。
9. 手绘路线提交 `{op:'route.draw', legId, path:{type:'LineString',coordinates:[...]}}`，直接成为正式路线；「重画」是 `{op:'route.redraw', legId, hint?}`，结果是一条新的 `route` 提议。
10. 事件流按 `cursor` 续；`seq` 跳号或断线超过 30 秒就重取快照（契约 §7）。
11. 上传 OSM 单块上限：0.25 平方度、40,000 条 way，超了回 422 并说明；公共 Overpass 偶尔排队，`importing` 状态可能持续一两分钟。
12. 前端只做一件计算：`move` 段按 `(t-t0)/(t1-t0)` 沿 `leg.path` 取点。冲突、路程、故事时间换算、版本组合都不在前端算。

## 页面（契约 §4 的具体落点）

- 世界观面按 §4.1 重排：左实体树（按 `parentId` 缩进）、中地图（MapLibre + 莱茵样式，`GET /v1/explore/map-config` 拿 `vector.tilejson/glyphs/attribution`）、下时间轴（每人一行，块 = 事件，红黄标记挂在块上）、右栏检查/待确认/助手。
- 拖动时间轴：按 `edits/geojson?t=` 切换改造层（只在生效时间段的边界重取，做节流），人物点按 `Track` 走；`unknown` 不画点、`dead` 之后变灰。
- 路线画法：`network` 实线、`manual` 实线 +「手绘」、`inferred` 虚线 +「推断」（点开看 `why` 和 `sources`）、`none` 不连线。
- 冲突面板：红 hard / 黄 suspect（标「按推断路线估算」）/ 信息不足（事件的 `gaps`）/ 未覆盖（`uncovered`）；点一条高亮涉及的事件和路线；修法先看 preview 再提交。
- 待确认：`proposals` 里只有 `pending/deferred`；route 类有「确认 / 重画 / 自己画」三个动作。
- 空世界观给引导：「建第一个人物 / 导入路网」，不要用示例数据冒充真实验收（§4.5）。

## 验收清单（你点一遍）

19 §11 的 1A：手工建人物/地点/交通方式/一段行程 → 拖时间轴看到沿真实路网移动 → 改时间出现红色赶不到 → 修法预览、接受、重查消失 → 其余四类检查各做一次 → 古道/桥按故事时间切换、路线跟着变 → 房间归属与连接检查 → 导入 OSM 区域和 Azgaar 地图 → 缺路时出现虚线推断路线、黄色疑似冲突、确认后变红 → 刷新以后都还在。

验收世界 `dc55c5ff-0e39-4455-b725-dfe1b824a3a9` 里已经摆好样本：红「同时异地」（顾嬷嬷 10:00 同时在阊门和客栈）、红「赶不到」（王二）、黄「赶不到」（沈砚，按推断路线）、红「死后出场」（沈砚）、信息不足（货郎那句只有传闻）、未覆盖（夜里城门落锁那条规则）、clean（地点层级与连接）。

## 不做

- 不改接口和语义：契约 20 的字段、路径、状态码就是后端的实现；要改先回来说。
- 不做 1B/1C（作品、正文、逐条版本、影响分析）。
- 不新增模拟验收数据；`?preview` 的示例数据继续留给 CI。
- 不在前端推断冲突、路程、故事时间换算、版本组合（契约 §0 最后一段）。

## 命令

```bash
pnpm local:up22 --lan --real-models     # 本机整栈（前端 :5183，控制面 :3001，局域网 https://<IP>:8443）
npx vitest run services/control/test/creative-*.test.ts   # 后端相关测试（32 条）
```
