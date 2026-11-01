# 10 · 探索台第二版 · 前端契约

日期：2026-11-01。分支：`codex/explore-2`。依据：[09-explore-v2.md](09-explore-v2.md)（已批准）、[08-explore-v2-ux.md](08-explore-v2-ux.md)、第一版契约 [07-explore-contract.md](07-explore-contract.md)。

沿用第一版的一切约定：路由在 `/backend` 同源前缀下、认 Cookie；写操作带 `X-ReinLab-CSRF: 1` 和 `Idempotency-Key`；错误 `{ code, message }`；计划修改走 `POST /ops`（原子批次、修订号、`AppliedOp.result`、`pending` 审批）；事件走 `/v1/stream?bench=exploration` 且每条带 `dossierId`；资源地址服务端给 `/v1/...`、前端补 `/backend`。共用类型继续放 `packages/contracts/src/explore.ts`。

## 0. 前后端分工

| 部分 | Claude（前端） | DSH（后端 / 工具 / 开发测试） |
|---|---|---|
| 局域网可信 HTTPS | 页面在固定 origin 下注册 Service Worker、申请持久存储 | `pnpm local:up22 --lan`：固定主机名（如 `reinlab.local`）+ 本机 CA 签的证书、同源反代构建后的前端和控制面；输出设备装 CA 的说明。不靠忽略证书警告 |
| 离线包 | Service Worker、Cache Storage、IndexedDB；按清单下载、校验、显示完整性；离线重开 | 生成清单（范围、瓦片、字形、建筑场景、光线、天气快照、缩略图、未知项）；带 ReinLab UA 代取瓦片；守 OpenFreeMap 3000 瓦片 / 50 MB / 并发 4 |
| 现场 | 两套布局、定位（只在内存）、到达判断、该走了、高德链接（前端做 WGS84→GCJ-02）、记录队列 | 现场事件入库（按客户端 ID 幂等）、更正语义、取出发时的计划快照 |
| 照片 | tus-js-client 批量上传、进度、续传、重选文件 | `@tus/server` 接权限、流式落盘、JPEG 校验、摘要去重、exifr、Sharp 派生图、分组、对时、落位 |
| 回顾 | 选片界面、对时确认、批量改归属、实际时间线、游记编辑 | 回顾工具（联系表、单图、局部）、推荐、对照、游记版本、经验提案与写入 |
| 白模 / 楼影 | Three.js 场景、视觉阴影、机位视角、取景框、示意图 | Overpass 取建筑、高度来源与换算、场景快照；双位置射线求交得见光时段（权威） |

## 1. 新增与扩展的类型

```ts
// ── 停留点细节扩展（旧数据兼容：guidance 允许旧的 string[]，前端读到 string 当 { id, text, pose: null }）──
type Pose = 'walk' | 'look-back' | 'lean' | 'touch' | 'pockets' | 'scarf' | 'step' | 'stand' | 'sit' | 'squat';
type GuidanceLine = { id: string; text: string; pose: Pose | null };
type ShotSettings = {
  bodyId?: string; lensId?: string; snapshot?: { body?: string; lens?: string };   // 资料引用 + 当时名称
  focalMm: number | null; aperture: number | null; shutterS: number | null; iso: number | null;   // 建议起点，未知为 null
};
type Frame = {                                   // 构图意图（0–1 归一化，原点左上）
  orientation: 'landscape' | 'portrait';         // 横 3:2 / 竖 2:3
  subject: { x: number; y: number; w: number; h: number } | null;   // 中心点 + 宽高；无人物为 null
  horizon: number | null;                        // 地平线高度（0 顶 – 1 底）
};
// Stop.detail 新增：guidance?: (GuidanceLine | string)[]; settings?: ShotSettings; frame?: Frame
// Stop 新增（经 stop.update patch 修改，正常编辑规则）：
//   subjectPoint?: LngLat | null    独立模特站位；null = 不设（风光）
//   cameraHeightM?: number          默认 1.5
//   subjectHeightM?: number         受光采样高度，默认 1.5（显示为假设）
//   areaRef?: LngLat                街区要算光时选的参考点
// Profile(gear, kind:'body') 新增 sensor?: { wMm: number; hMm: number } | null   —— 缺则前端显示"按全画幅假设"

// ── 双位置受光（替代第一版 StopLight，旧字段保留只读）──
type LightState = 'night' | 'terrain' | 'building' | 'maybe_lit' | 'unknown';
type LightSegment = { start: string; end: string; state: LightState; cause?: { buildingIds?: string[]; note?: string } };
type PositionLight = {
  point: LngLat; heightM: number; heightAssumed: boolean;
  segments: LightSegment[];                      // 覆盖当天，按时间连续
  litWindows: { start: string; end: string }[];  // 已知数据下预计见光（maybe_lit 的合并）
  missing: string[];                             // 缺项说明，如 "西侧 1 km 外楼高未知"
};
type StopLight2 = { version: number; computedAt: string; sceneId: string | null; radiusM: number;
  camera: PositionLight; subject: PositionLight | null; dem: string };
// Stop 新增 light2?: StopLight2（服务端算，异步；变化时推 explore.light）

// ── 建筑场景（白模与楼影同源）──
type Building = {
  id: string; osm: string;                       // 如 'way/123'
  footprint: [number, number][];                 // 局部米制坐标（以 scene.origin 为原点，x 东 y 北），闭合环
  holes?: [number, number][][];
  baseM: number | null;                          // 基底海拔（相对 origin 地面），未知 null
  heightM: number | null; minHeightM: number;    // 未知高度 null：只画轮廓 + 未知标记
  heightSource: 'tag' | 'levels' | 'unknown'; basis: string;   // 如 "building:levels=6 × 3 m"
};
type BuildingScene = {
  id: string; version: number; origin: LngLat; radiusM: number; fetchedAt: string; source: string;
  buildings: Building[];
  coverage: { status: 'ok' | 'partial' | 'empty' | 'failed'; note: string };   // empty 不代表没有楼
};

// ── 现场记录（独立于计划 revision）──
type FieldEventKind = 'arrived' | 'shot' | 'note' | 'situation' | 'correction';
type FieldEvent = {
  clientId: string;                              // 设备生成，幂等键
  kind: FieldEventKind;
  stopId: string | null; stopName: string | null;            // 当时的名称（点被删后仍可显示）
  planRevision: number;                          // 记录时设备上的计划修订
  at: string; tz: string;                        // 设备记录时间（带偏移）+ IANA 时区
  text?: string;                                 // note / situation 的内容；situation 带按钮标签
  situation?: 'rain' | 'late' | 'crowd' | 'light' | 'other';
  position?: { at: LngLat; accuracyM: number };
  refersTo?: string;                             // correction 指向的 clientId
  correction?: { action: 'retract' } | { action: 'edit'; text: string } | { action: 'relink'; stopId: string };
};
type FieldEventRecord = FieldEvent & {
  serverId: string; receivedAt: string;
  status: 'ok' | 'orphan' | 'retracted';         // orphan = 点已不在当前计划，待重新关联
  effectiveText?: string;                        // 叠加更正后的内容
};

// ── 照片 ──
type PhotoStatus = 'uploading' | 'processing' | 'ready' | 'failed';
type Photo = {
  id: string; batchId: string; fileName: string; bytes: number; sha256: string; status: PhotoStatus; error?: string;
  exif: {
    dateTimeOriginal: string | null;             // 原文，不带解释
    offset: string | null;                       // OffsetTimeOriginal
    subSec: string | null; gpsTime: string | null; gps: LngLat | null;
    body: string | null; lens: string | null; focalMm: number | null; aperture: number | null;
    shutterS: number | null; iso: number | null; orientation: number | null;
  };
  cameraGroupId: string | null;
  time: { corrected: string | null; basis: 'offset_tag' | 'gps' | 'clock_fix' | 'unknown'; trust: 'certain' | 'estimated' | 'pending' };
  placement: { stopId: string | null; basis: 'gps' | 'event' | 'plan_time' | 'manual' | 'unplanned' | 'pending'; at: LngLat | null };
  ai: { mark: 'recommend' | 'alternate' | null; reason?: string; inspected: 'none' | 'preview' | 'detail' } ;
  picked: boolean;                               // 用户精选（与 ai 分开）
  thumb: string; preview: string;                // /v1/... 派生图地址
};
type UploadBatch = { id: string; createdAt: string; files: number; bytes: number;
  uploaded: number; processed: number; failed: number; unsupported: { fileName: string; reason: string }[] };
type CameraGroup = {
  id: string; label: string;                     // 机身型号；序列号不展示
  photos: number; timezone: string | null; timezoneBasis: 'offset_tag' | 'plan' | 'user' | null;
  offsetSec: number | null; residualSec: number | null;
  status: 'auto' | 'needs_anchor' | 'inconsistent' | 'confirmed';
  anchors: { photoId: string; eventClientId?: string; time?: string; deltaSec: number }[];
  suggestion?: { photoId: string; eventClientId: string; note: string };   // 推荐让用户确认的锚点
};

// ── 回顾成果 ──
type Comparison = { revisionUsed: number; items: {
  stopId: string; stopName: string;
  evidence: 'shot' | 'arrived_only' | 'none_found';   // none_found ≠ 没去
  plannedStart: string | null; actualStart: string | null; lateMin: number | null;   // 对时不准则 null
  light: string | null; notes: string[]; photoIds: string[];
}[]; unplannedPhotoIds: string[] };
type Travelogue = { id: string; revision: number; markdown: string; photoIds: string[]; sources: Source[]; updatedAt: string };

// ── 地点经验（账户级资料新类型，与模特 / 器材同一套 /v1/profiles）──
// Profile 增加 | { id; type: 'place'; revision; name; at: LngLat; radiusM: number; standpoint?: string;
//                 observedOn: string; season?: string; timeOfDay?: string; text: string;
//                 evidence: { photoIds?: string[]; eventIds?: string[]; dossierId: string }; confirmedBy: 'user' }
type ExperienceProposal = { approvalId: string; target: 'model' | 'place'; profileId?: string; title: string;
  text: string; evidence: { photoIds?: string[]; eventIds?: string[]; dossierId: string }; summary: string };
```

## 2. 接口

### 2.1 离线包

| 路由 | 说明 |
|---|---|
| `POST /v1/explore/plans/:id/offline-packs` `{ day }` | 生成清单 → `{ pack: OfflineManifest }` |
| `GET /v1/explore/plans/:id/offline-packs/:packId` | 取清单（准备页检查完整性用）→ 直接返回 `OfflineManifest`（不包 `{pack}`） |
| `GET /v1/explore/offline-tiles/:packId/:z/:x/:y` | 服务端带 ReinLab UA 代取并缓存的矢量瓦片（只发清单里列的） |

```ts
type OfflineManifest = {
  packId: string; day: string; planRevision: number; createdAt: string;
  area: { corridorM: 500; stopRadiusM: 1000; bounds: [[number, number], [number, number]] };
  tiles: { z: number; x: number; y: number; url: string }[];     // url 为 /v1/explore/offline-tiles/...
  tileTemplate: string;                          // 如 /v1/explore/offline-tiles/<packId>/{z}/{x}/{y}，离线地图源用它
  tileZoom: { min: number; max: number };        // 清单实际覆盖的级别；更高缩放用最高级放大
  glyphTemplate: string;                         // 如 /v1/explore/offline-glyphs/{fontstack}/{range}.pbf（服务端代取 OpenFreeMap 字形）
  tileBytes: number; limit: { maxTiles: 3000; maxBytes: 52428800; withinLimit: boolean; note?: string };
  style: { vectorTilejson: string };             // 前端改写为离线源
  glyphs: { url: string }[];                     // 只含拉丁 / 标点区段；中文用设备本地字体渲染（第一版已如此）
  scenes: { stopId: string; url: string }[];     // BuildingScene
  plan: string;                                  // GET 计划快照的地址（固定修订）
  light: string; weather: string; refs: { id: string; thumb: string }[];
  unknowns: string[];                            // 如 "D 点楼高缺失"、"天气是 10/31 01:17 的快照"
};
```

- **超限：** `withinLimit: false` 时附 `note`（实际瓦片数 / 体积）。页面让用户缩小范围或明确接受较低细节，服务端按用户选择重算清单（`POST ... { day, detail: 'low' }`）。不自动分包。
- **前端完成判断：** 清单里每个资源都下载成功并写入 Cache Storage，计划 / 光线 / 天气写入 IndexedDB，才显示"可离线使用"。中断后按清单续下。
- **完整性：** 准备页随时可以"检查"，逐项核对缓存，缺了就列出来让用户补。

### 2.2 现场

| 路由 | 说明 |
|---|---|
| `POST /v1/explore/plans/:id/field-events` `{ events: FieldEvent[] }` | 批量上传。按 `clientId` 幂等，重复上传只存一份。→ `{ results: { clientId, serverId, status: 'ok' \| 'orphan' \| 'duplicate' \| 'conflict', server?: FieldEventRecord }[], planRevision }` |
| `GET /v1/explore/plans/:id/field-events` | → `{ items: FieldEventRecord[] }` |
| `GET /v1/explore/plans/:id/revisions/:rev` | 某个修订的计划快照（出发时的计划，回顾对照用）→ 整份 `ExploreSnapshot`（与 `GET plans/:id` 同形状） |

- 同步顺序：先传事件，再拉最新计划。**旧离线快照绝不覆盖服务端计划。**
- 点被删：`status: 'orphan'`，页面显示原名称和"重新关联"按钮（发 `correction: relink`）。
- 更正（撤销、改文字、重关联）一律是新的 `correction` 事件，不改原记录。读接口的 `stopId` 返回更正后的有效停留点，原值留在库里，不另加字段。
- 冲突：同一条记录本地改过、服务端也有更正时，接口返回 `status: 'conflict'` 和服务端版本，页面让用户二选一（只有这一种冲突）。
- "情况变了"：联网时，页面把 `situation` 事件存下来，同时用一句结构化文字发进对话（`POST /v1/kernel/runs`，第一版的探索会话），格式如「【现场 · 下雨了】当前在 2 号点 · 17:42 · 用户补充：……」。之后的前后对照和应用沿用第一版的审批。离线时只存 `situation` 事件，页面明说"现在连不上 ReinLab，助手暂时不能重排"，**不排队成回来后自动执行的命令**。

### 2.3 照片

| 路由 | 说明 |
|---|---|
| `POST /v1/explore/plans/:id/photo-batches` `{ files: { name, bytes, lastModified }[] }` | 建批次，提前返回不支持的文件（非 JPG）和空间是否够 → `{ batch: UploadBatch, uploadUrl, space: { freeBytes, needBytes, ok } }` |
| tus 端点 `uploadUrl`（如 `/v1/explore/uploads/`） | tus 协议，metadata 带 `batchId`、`filename`、`lastModified`；每个请求都按会话校验同账户档案 |
| `GET /v1/explore/plans/:id/photo-batches/:batchId` | 批次进度 |
| `GET /v1/explore/plans/:id/photos?cursor=&stopId=&group=` | 分页 → `{ items: Photo[], cursor }` |
| `GET .../photos/:pid/thumb` · `/preview` · `/crop?x=&y=&w=&h=`（0–1） | 派生图（细看用 crop） |
| `GET .../photos/:pid/original` | 原图（只读下载） |
| `POST .../photos/assign` `{ photoIds, stopId \| null, basis: 'manual' }` | 批量改归属（null = 计划外）。手动归属不会被重算覆盖 |
| `POST .../photos/pick` `{ photoIds, picked }` | 用户精选（不影响 ai 推荐） |
| `DELETE .../photos/:pid` | 用户明确删除 |
| `GET .../storage` | `{ dossierBytes, freeBytes }` |

续传：页面以 `fileName + bytes + lastModified` 加批次 ID 作为 tus 指纹；刷新后浏览器丢了文件句柄，就让用户重新选原文件，tus-js-client 按指纹查到已传偏移后接着传。

### 2.4 对时与落位

| 路由 | 说明 |
|---|---|
| `GET .../clock` | `{ groups: CameraGroup[] }` |
| `POST .../clock/:groupId/anchor` `{ photoId, eventClientId? , time? }` | 加锚点（这张照片 = 这个打卡 / 这个时刻） |
| `POST .../clock/:groupId/confirm` `{ timezone, offsetSec }` | 确认后应用：重算该组照片时间和落位（手动归属不动） |
| `POST .../clock/:groupId/split` `{ beforePhotoId }` | 时钟变化前后拆组 |
| `GET .../actual?revision=` | 实际时间线：`{ items: ({ type: 'event'; record: FieldEventRecord } \| { type: 'cluster'; stopId; start; end; photoIds; basis })[] }` |

### 2.5 回顾与经验

- 挑片、对照、游记、经验都由用户在对话里发起（第一版的探索会话）。工具名和细节由 DSH 定，工具结果里带下面的字段时，页面渲染对应的卡：
  - `photoIds?: string[]` → 照片条（缩略图 + AI 标记 + 理由，可点开看细节）
  - `comparison?: true` → 刷新并打开"计划 vs 实际"
  - `travelogueId?: string` → 打开游记
  - `pending?.kind === 'experience'` → 经验确认卡（`ExperienceProposal`，确认 = 审批通过，写入资料）
- `GET .../review` → `{ comparison: Comparison | null, travelogue: Travelogue | null }`
- `PUT .../review/travelogue` `{ baseRevision, markdown }` → 新 revision（409 同第一版处理）
- `GET .../review/travelogue/export?format=md|html` → 文件；生成后作为档案成果（`kind: 'file'`）
- 地点经验读写走 `/v1/profiles`（`type: 'place'`），页面"资料"栏多一个"地点经验"分区，可改、可删。

### 2.6 白模与楼影

| 路由 | 说明 |
|---|---|
| `GET .../scene?stopId=` | `BuildingScene`（按机位 1 km，可复用缓存） |
| `POST .../light/recompute` `{ stopId }` | 位置、高度、日期变了后请求重算（ops 改这些字段时服务端也会自动排队） |

`Stop.light2` 随计划一起返回；算完推 `explore.light`。页面用同一个 `BuildingScene` 和第一版约定的太阳方向，在 Three.js 里画楼块和视觉阴影；**见光状态只读 `light2`，不读屏幕上的阴影**。

## 3. 事件（`/v1/stream?bench=exploration`，都带 `dossierId`）

| 事件 | 载荷 | 页面 |
|---|---|---|
| `explore.field` | `{ planRevision, results }` | 刷新现场记录（多设备时） |
| `explore.photos` | `{ batchId, uploaded, processed, failed }` | 更新进度；处理完的照片出现在网格 |
| `explore.clock` | `{ groupId, status }` | 刷新对时面板 |
| `explore.review` | `{ part: 'comparison' \| 'travelogue' \| 'picks' }` | 刷新对应区块 |
| `explore.light` | `{ stopId, version }` | 重取该停留点 |
| `explore.scene` | `{ stopId, sceneId, status }` | 重取场景 |

## 4. 页面状态

### 4.1 现场（两套布局）

- **手机（< 768px）：** 单栏，上到下：现在的点 + 倒计时（大字）→ 此刻的光（一行状态 + 下次见光）→ 引导词（大字，左右滑切换，带姿势小人）→ 底部两个大按钮"到了 / 拍到了"+ 记一句；情况按钮收在"情况变了"抽屉里。地图是可展开的小图。
- **iPad 横屏：** 沿用演示版布局：左地图（位置、下一段路线）、中当前点卡片、右记录与清单、底部时间线。
- **顶部状态条（两套都有）：** `ReinLab 可连接 / 连不上` 和 `互联网 有 / 无` 分开显示；`待同步 N 条`；离线包版本（`第 N 版计划 · 11/08 准备`），服务端已有更新版本时提示"计划有新版本，联网时更新离线包"。
- **定位：** 用户点"开启定位"才调用 `watchPosition`；精度 > 50 m 时显示"定位不准，不自动判断"；离开现场页 / 页面隐藏 / 锁定时停止。多点歧义时弹选择。
- **该走了：** `出发时间 = 下一点开拍 − 当前段步行耗时 − 5 分钟`，显示来源；已过时显示预计迟到；不能算时写原因。
- **用高德打开：** 每个点一个按钮，`https://uri.amap.com/marker?position=<gcj经>,<gcj纬>&name=<名>&coordinate=gaode&callnative=1`；唤起失败时保留链接和坐标。

### 4.2 回顾

- 上传区：拖入文件夹 → 先列出不支持的文件和空间检查 → 开始；每个文件和总批次的字节进度、失败重试、暂停；"刷新后请重新选择原文件继续"。
- 对时面板：每个相机组一行（机身、张数、状态）；`needs_anchor` / `inconsistent` 时展示建议锚点（照片缩略图 + 打卡时间），用户确认或另选；显示校正前后时间。
- 照片网格：按停留点 / 计划外分组；每张显示 AI 标记（推荐 / 备选、是否细看过）和用户精选星；落位依据小标签（GPS / 打卡 / 按时间推定 / 手动 / 待确认）；多选批量改归属。
- 实际时间线：在计划时间线下加"实际"一轨：打卡、照片簇、笔记；推定的用虚线。
- 计划 vs 实际、游记（可编辑、导出）、经验卡。

### 4.3 机位面

- 白模区：Three.js 灰白楼块；未知高度的楼只画地面轮廓 + 斜线 + "高度未知"；场景 `coverage` 不是 `ok` 时顶部提示。环绕 / 机位视角切换；时间轴拖动；相机高度、模特站位（地图上拖）可改。
- 机位视角：按站位、高度、朝向、焦段和传感器（缺则"按全画幅假设"）算视野，叠 3:2 / 2:3 框和三分线。
- 受光提示框：分"机位 / 模特"两行，各写当前状态（山挡 / 楼挡 / 预计有光 / 未知）和下一次见光，未知写原因。
- 参数行、构图框（可拖动人和地平线，写回 `detail.frame`）、引导词配姿势小人（`pose: null` 只显示文字）。

## 5. 兼容

- 旧档案：`guidance` 是字符串数组时按仅文字显示；没有 `light2` 时显示第一版的 `light`；没有 `frame` / `settings` 时不画对应示意；旧 PDF 不动。
- 第一版接口和事件不变。

## 6. 留给 DSH / Codex 的问题

1. **局域网主机名：** 我倾向用 `reinlab.local` 加固定端口（mDNS），手机和电脑都能用同一个 origin。如果路由器不支持 mDNS，退回固定局域网 IP 也行，但要选定一个之后不再改，否则离线缓存会丢。
2. **字形：** 地图中文用设备本地字体，离线包只带拉丁字形区段。iOS Safari 的本地中文字体能正常渲染（第一版在桌面验过，手机要在 V1 里确认）。
3. **Service Worker 只在构建版本里启用**：`--lan` 模式要服务构建后的前端，开发模式不注册，避免热更新和缓存打架。

## 7. DSH 回执（后端已实现的口径，B1–B3）

1. **局域网入口**：`pnpm local:up22 --lan` 固定 `https://reinlab.local:8443`（dns-sd 广播局域网 IP，证书 SAN 里另带本机 `.local` 名与局域网 IP），输出里给 `ca.pem` 路径和设备装证书的说明；`/backend` 同源反代，`/v1` 也认。
2. **字形**：清单只带 `0-255` / `256-511` 两个区段 × `Noto Sans Regular/Bold`，中文靠设备本地字体；样式里的 fontstack 改名要告诉我。
3. **Service Worker**：只在 `--lan` 的构建产物里启用，`pnpm dev` 不注册。
4. **tus**：`POST photo-batches` 的 `uploadUrl` 与上传后的 `Location` 都是**绝对地址**（带 `/backend` 前缀）——`tus-js-client` 用 `new URL(location, endpoint)` 解析，相对 base 会抛 `Invalid URL`。每个请求都按 Cookie 会话校验同账户档案，写请求要 `X-ReinLab-CSRF: 1`。
5. **资料 PATCH**：页面把整条资料带回时，`id` / `revision` / `confirmedBy` 认下但不用；其它未知字段仍拒绝。
6. **用量**：`PlanUsage.byPurpose` 仍是 4 种，回顾看图记 `vision`。要区分「挑片 / 对照 / 游记 / 经验」得先改 contracts 加用途。
7. **对时建议**：没有计划时区时不给 `suggestion`（宁可不建议，也不给没依据的对应）；锚点取中位数，残差 > 120 秒标 `inconsistent`。
8. **看的等级**：联系表 = `preview`，看局部 = `detail`；模型声称细看过但实际没看过局部时会被降成 `preview`。
9. **对照口径**：`none_found` 只表示没找到拍摄证据；只有「时间可信的照片」或「拍到了」打卡才给 `lateMin`，只「到了」给实际到达时间但不给迟到分钟。
10. **回顾工具**：`explore_photos`、`explore_contact_sheet`、`explore_photo_view`、`explore_photo_mark`、`explore_field_events`、`explore_compare`、`explore_travelogue`、`explore_experience`；结果里分别带 `photoIds` / `comparison` / `travelogueId` / `pending.kind='experience'`。看图在 `--real-models` 起栈时才接通（没授权不花钱）。
11. **游记里的照片引用**：约定写法 `![一句说明](photo:<照片id>)`——服务端存 `photoIds`，导出 md/html 时换成真实图片地址；裸 id 直接写进正文的老写法仍认，但别再用。页面按这个写法渲染成图片。
12. **审批结果怎么告诉模型**：决定记成档案事实（`user_op` / `decision`），下一轮以「档案变动：…」注记带进会话——页面上是注记，不是用户气泡；紧跟其后的用户消息才是用户说的话。
13. **预算**：看图和对话的模型调用都按峰值费率估一次再放行（不够就明确拒绝），花费累加到这份档案本月的账上（`budget_allocation.spent_cny`），所以 `/v1/me` 的可用额度会真的减少；金额未知的调用照实记未知，不记 0。
