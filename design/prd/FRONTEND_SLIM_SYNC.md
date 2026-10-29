# 前端瘦身 F1–F3：给 DSH 的同步清单（分支 `slim/frontend`）

前端由 Claude 维护。后端工作区同步时：**下面列为「原样复制」的文件直接覆盖；列为「合并」的文件，后端工作区里有 live 接线，要把改动合进去，不能整份覆盖。**

## 删除（后端工作区同样删掉）

- `src/App.tsx`、`src/components/{Conversation,TemplateStudio,Visuals}.tsx`
- `src/components/research/`、`src/components/studios/`、`src/components/reactbits/`（整个目录）
- `src/components/cinematic/` 下：`AmbientScore.ts`、`CinematicExperience.tsx`、`FrameMeter.ts(.test)`、`LoginGate.tsx`、`archiveOpening.ts(.test)`、`archivePortalPreview.ts`、`login-entrance.css`、`motion-preview.css`、`motionPreview.ts`、`open-maic-portal.css`、`openMaicPortal.ts(.test)`、`CeremonyWorkbenchChooser-1.tsx`、`EntryComparison-1.tsx`、`ceremony-workbenches-1.css`、`SpatialWorkbenchChooser.tsx`、`spatial-workbenches.css`
- `src/components/classroom/` 下：除 `native/` 以外的所有文件（`openmaicRenderer.test.tsx` 已移到 `native/`）
- `src/components/workbenches/` 下：`{Automation,Creative,Data,Exploration,Research}Bench.tsx`、`Chat.tsx`、`bench-*.css`、`engineering/legacy/`
- 依赖：`d3-geo`、`topojson-client`、`@types/d3-geo`、`@types/topojson-client`

后端工作区的 `src/data/LiveSessionBoundary.tsx` 如果还 import `LoginGate`，改为跳回 `/?preview=entry`（入口已经是 `RhineEntry`）。

## 新增（原样复制）

- `src/backendMode.ts`：`backendMode`、`LIVE_BENCHES`、`isDemoBench`。**接通一个工作台，就把它的代号加进 `LIVE_BENCHES`。**
- `src/components/classroom/native/README.md`

## 原样复制

- `src/components/workbenches/BenchFrame.tsx`（演示数据标记）
- `src/components/workbenches/engineering/engineering.css`（`.en-demo` 样式）
- `src/components/workbenches/WorkbenchStudio.tsx`（返回入口始终用页内跳转，去掉 entry-compare）
- `src/components/workbenches/research/read/useRead.ts`（返回 `error` / `retry`）
- `src/components/workbenches/research/read/ReadMode.tsx`（读取失败时显示原因和重试）

## 合并

- `src/main.tsx`：路由只保留 `workbench`、`rhine`/`template`、`inbox`，其余（包括空值）一律走 `RhineEntry`；去掉 `App`、`StudioLayouts`、`entry-compare`。后端工作区的 `LiveSessionBoundary` 和 `liveEntryAuth` 接线保留。

## live 适配器要配合 F3

`ReadAdapter.load()` 失败时要 **reject 并带上人能读懂的原因**（`Error.message`）。不要吞掉错误，也不要返回示例快照。
