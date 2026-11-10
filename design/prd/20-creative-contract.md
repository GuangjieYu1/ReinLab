# 20 · 创作台 · 前端契约（MVP-1）

日期：2026-11-06。分支：`codex/creative-1a`（1B、1C 各开一个分支）。依据：[19-creative.md](19-creative.md)（用户已批准；契约和它冲突时以 19 为准）、[16-creative-ux.md](16-creative-ux.md)。

本契约只覆盖 MVP-1：1A 写全，1B、1C 写到能开工的程度，开工前我再补细节。MVP-2/3/4 到时候另写契约。

沿用已有约定：
- 路由在 `/backend` 同源前缀下，认 Cookie；写操作带 `X-ReinLab-CSRF: 1` 和 `Idempotency-Key`；错误格式是 `{ code, message }`。
- 审批和提问走现有收件箱 `/v1/approvals`；资源地址由服务端给 `/v1/...`，前端补 `/backend`。
- 共用类型放在 `packages/contracts/src/creative.ts`，前后端都从这里引用。
- 一个创作台档案（`bench:'creative'`，`kind:'workspace'`）就是一个世界观。作品是世界观里的对象，不另开档案。
- 修改沿用探索台的做法：带 `baseRevision` 的**原子操作批次**（[07-explore-contract.md](07-explore-contract.md) 第 230 行）。

## 0. 分工

| 部分 | Claude（前端） | DSH（后端 / 插件 / 测试） |
|---|---|---|
| 世界观面 | 以地图为主重排：中间是地图，下方是按人物分行的时间轴，左边是实体树，右边是检查 / 待确认 / 助手；实体、事件、规则、改造层的编辑表单；手绘路线 | 世界观存储；操作批次；故事时间换算；路网导入；pgRouting 算路；轨迹；五类检查；AI 推断路线 |
| 地图 | 复用探索台的 MapLibre 底图和莱茵样式；按故事时间叠改造层；轨迹的实线、虚线、点位动画 | 下发底图配置、各时刻生效的改造层 GeoJSON、轨迹几何 |
| 检查 | 红 / 黄 / 信息不足 / 未覆盖四种显示；修法预览；单条和批量处理 | 判定、依据、修法及其预览，全部由服务端算 |
| 小说（1B） | 章节、大纲确认卡、正文编辑和差异接受、导入向导、待确认清单 | 设定顾问 / 写作助手会话、抽取、历法换算、导出 |
| 版本（1C） | 版本列表、作品采用的设定组合、影响清单和三种决定 | 版本快照、组合还原、影响分析 |

前端只读服务端投影，**不在前端推断**以下内容：冲突、路程、故事时间换算、出处状态、版本组合。唯一例外：拖动时间轴时，人物沿服务端给的折线按时间比例画位置（§1.5），这只是画图，不算判断。

## 1. 类型（`packages/contracts/src/creative.ts`）

```ts
type Iso = string;
type Cny = { value: number | null; known: boolean };          // 用量未知 → { value:null, known:false }，不记 0
type LngLat = [number, number];
type Geo = GeoJSON.Point | GeoJSON.LineString | GeoJSON.Polygon | GeoJSON.MultiPolygon;
type Decision = 'pending' | 'accepted' | 'rejected' | 'deferred';      // 处理状态

// ── 出处（19 §2：出处性质和处理状态分开）──
type Provenance = {
  basis: 'explicit' | 'inferred' | 'unknown' | 'author';      // 原文明写 / 推断 / 未知 / 作者手写
  by: 'user' | 'route_ai' | 'advisor' | 'writer' | 'importer' | 'swarm';
  source?: { workId: string; textVersion: number; chapterId: string; para: number; sentence: number; quote: string } | null;
  why?: string;                                                // 推断依据（人话），作者确认后也保留
  stale?: boolean;                                             // 原文改了，这条出处过期
};

// ── 故事时间：服务端换算，前端只显示 label ──
type StoryTime = {
  t: number | null;            // 世界纪元起的分钟数；未知 / 只有相对关系时为 null
  range?: [number, number] | null;   // 只知道一个范围时
  label: string;               // 显示用：「康熙二十三年三月初七 · 约 1684-04-21」「三天后（参照：出城）」
  original?: string;           // 原文写法
  calendar?: string;           // 所用历法 id
  relative?: { to: string; rel: 'before' | 'after' | 'meets' | 'during' | 'overlaps' | 'equals'; offsetMin?: [number, number] } | null;
  certainty: 'exact' | 'range' | 'relative' | 'unknown';
  candidates?: { t: number; label: string; why: string }[];   // 年号、闰月等不确定时的候选
};

// ── 世界观 ──
type World = {
  id: string; dossierId: string; title: string;
  revision: number;            // 草稿修订号；每个生效的操作批次 +1
  version: { latest: number; draftChanges: number };   // 已确认版本号；草稿上还有多少条没确认成版本的改动
  basemap:
    | { kind: 'real'; bbox: [number, number, number, number] }          // 复用探索台 map-config
    | { kind: 'generated'; source: 'azgaar'; scaleKmPerUnit: number | null; assetId: string }   // 比例未定 → null，不算耗时
    | { kind: 'blank'; scaleKmPerUnit: number | null };
  timeSpan: { from: StoryTime; to: StoryTime } | null;   // 时间轴默认范围（服务端按事件算）
  calendars: Calendar[];
  network: NetworkStatus;
};

type Calendar = { id: string; name: string; kind: 'gregorian' | 'chinese_era' | 'custom'; note?: string };

// ── 实体 ──
type EntityKind = 'person' | 'place' | 'item' | 'org';
type PlaceLevel = 'world' | 'region' | 'city' | 'building' | 'floor' | 'room' | 'site';
type Entity = {
  id: string; kind: EntityKind; name: string; aliases: string[];
  summary?: string;
  origin: Provenance; status: Decision;
  // 地点
  place?: {
    level: PlaceLevel; parentId: string | null;
    geo: Geo | null;                     // 真实或架空坐标；古地名没定位时为 null
    geoCertainty: 'exact' | 'area' | 'unlocated';
    connects: { to: string; passable: boolean; note?: string }[];   // 房间、楼层之间的连接（1A 不要几何）
    osm?: { type: 'node' | 'way' | 'relation'; id: number; version?: number } | null;
  };
  // 人物
  person?: { born?: string | null; died?: string | null };   // 关联事件 id（出生、死亡也是事件）
  workRefs: { workId: string; chapterId?: string }[];        // 1B 起：被哪些作品引用
};
type Relation = { id: string; a: string; b: string; label: string; from?: StoryTime | null; to?: StoryTime | null; origin: Provenance; status: Decision };

// ── 事件账本 ──
type Participation = 'actor' | 'present' | 'remote' | 'mentioned';
type WorldEvent = {
  id: string; title: string; what: string;
  kind: 'stay' | 'travel' | 'interaction' | 'birth' | 'death' | 'other';
  participants: { entityId: string; entityName?: string; as: Participation }[];   // entityName 只出现在提议的 ops 里，见 §1.1 补注
  placeId: string | null;                       // 未知可为 null
  start: StoryTime; end: StoryTime;
  travel?: { fromId: string | null; toId: string | null; modeId: string | null } | null;
  narrative: 'fact' | 'hearsay' | 'dream' | 'hypothetical' | 'flashback';
  origin: Provenance; status: Decision;
  gaps: string[];                               // 服务端写：缺什么导致检查做不了（人话）
  workRefs: { workId: string; chapterId?: string; sceneId?: string }[];
};

// ── 规则 ──
type TransportMode = { id: string; name: string; kmPerHour: number; network: 'road' | 'water' | 'any' | 'none'; note?: string };
type WorldRule = {
  id: string; text: string;                     // 作者写的规则原文
  machine: { kind: 'teleport' | 'remote_presence' | 'resurrection' | 'custom'; params: Record<string, unknown> } | null;   // null = 程序还判不了 → 检查里显示「未覆盖」
  origin: Provenance; status: Decision;
};

// ── 改造层（19 §3）──
type MapEdit = {
  id: string; title: string;
  effect: 'add' | 'hide' | 'rename' | 'restyle' | 'passability';
  target: { osm?: { type: 'node' | 'way' | 'relation'; id: number; version?: number }; area?: GeoJSON.Polygon; placeId?: string } | null;   // add 时为 null
  geometry?: Geo | null;                        // add 的几何
  props?: { name?: string; style?: 'wall' | 'road' | 'ancient_road' | 'water' | 'building' | 'area' | 'mark' };
  passable?: { open: boolean; modeIds?: string[] } | null;   // 影响路网时才有；外观和通行分开
  valid: { from: StoryTime | null; to: StoryTime | null };   // 故事生效时间段；null 端 = 一直
  needsRemap?: boolean;                         // 目标对不上了：显示待确认，不静默改别的
  origin: Provenance; status: Decision;
};

// ── 路网与路线 ──
type NetworkStatus = {
  state: 'none' | 'importing' | 'ready' | 'failed';
  sources: { kind: 'osm' | 'azgaar' | 'manual'; bbox?: [number, number, number, number]; edges: number; importedAt: Iso }[];
  error?: string;
};
type RouteKind = 'network' | 'manual' | 'inferred' | 'none';
type RouteLeg = {
  id: string; entityId: string; fromEventId: string; toEventId: string;
  modeId: string | null;
  kind: RouteKind;             // 正式路网 / 作者手绘（已确认）/ AI 推断（未确认）/ 算不出
  path: GeoJSON.LineString | null;            // none 时为 null；绝不给直线冒充
  segments?: { from: number; to: number; kind: 'network' | 'inferred' }[];   // 混合路段：按顶点下标标出哪段是推断
  distanceKm: number | null; durationMin: number | null;
  inferred?: { proposalId: string; why: string; sources: { title: string; url?: string }[] } | null;
  failure?: string | null;     // 算不出 / 推断失败的原因（人话）
};

// ── 轨迹（前端画图用）──
type Track = {
  entityId: string;
  spans: (
    | { kind: 'at'; t0: number; t1: number; eventId: string; placeId: string | null; at: LngLat | null }
    | { kind: 'move'; t0: number; t1: number; legId: string; routeKind: RouteKind }
    | { kind: 'unknown'; t0: number; t1: number; why: string }            // 位置未定
    | { kind: 'dead'; t0: number }
  )[];
};
// 前端规则：t 落在 move 段时，按 (t-t0)/(t1-t0) 沿 legId 的 path 线性取点；
// routeKind='inferred' 画虚线、点位加「推断」；unknown 段不画点，人物行显示「位置未定」。

// ── 检查（19 §4）──
type ConflictKind = 'double_location' | 'travel_time' | 'dead_appearance' | 'presence' | 'place_hierarchy';
type Conflict = {
  id: string; kind: ConflictKind;
  severity: 'hard' | 'suspect';                 // 红 / 黄（按未确认推断路线算出来的只能是 suspect）
  entityIds: string[]; eventIds: string[]; legIds?: string[];
  why: string;                                  // 人话：「需要 3 天 4 小时，只有 1 天」
  numbers?: { needMin?: number; haveMin?: number };
  fixes: Fix[];
};
type Fix = {
  id: string; label: string;                    // 「把『进城』挪到 4 月 25 日之后」
  kind: 'move_this' | 'move_other' | 'drop_constraint' | 'other';
  ops: Op[];                                    // 接受后执行的操作（服务端生成）
  preview: { eventId?: string; field: string; before: string; after: string }[];
};
type CheckRun = {
  id: string; at: Iso; revision: number;
  conflicts: Conflict[];
  insufficient: { eventId: string; gaps: string[] }[];   // 信息不足（不算通过）
  uncovered: { ruleId: string; why: string }[];          // 规则程序还判不了
  clean: ConflictKind[];                        // 本次查过、未发现冲突的类型（不等于「完全没矛盾」）
};

// ── 待确认（1A 只有路线；1B 起才有其他种类）──
type Proposal = {
  id: string; batchId?: string;
  kind: 'route' | 'entity' | 'event' | 'merge' | 'relation' | 'rule' | 'map_edit' | 'itinerary' | 'text_edit';
  title: string; summary: string;
  ops: Op[];                                    // 接受后执行；「修改后接受」= 前端改 ops 再提交
  origin: Provenance;
  doubts: string[];                             // 疑点
  dependsOn: string[];                          // 依赖的其他提议
  conflicts: Conflict[];                        // 接受后会出现的冲突（服务端先试算）
  candidates?: { label: string; ops: Op[]; why: string }[];   // 多候选时（古地名、共指、年号）
  status: Decision;
  resolution?: { decision: Decision; reason: string; at: Iso; by: 'user' | 'agent' } | null;   // 怎么处理的、为什么；见 §1.1 补注
};

// ── 版本（1A 只保留，1C 才有界面）──
type WorldVersion = { n: number; at: Iso; summary: string; changes: number };

// ── 快照 ──
type WorldSnapshot = {
  world: World;
  entities: Entity[]; relations: Relation[]; events: WorldEvent[];
  modes: TransportMode[]; rules: WorldRule[]; edits: MapEdit[];
  legs: RouteLeg[];
  proposals: Proposal[];                        // 只含 pending / deferred
  check: CheckRun | null;
  versions: WorldVersion[];
  cursor: number;                               // 事件流 seq
};
```

### 1.1 操作（`Op`）

一个批次是原子的：要么全部生效，要么全部不生效。生效后 `revision + 1`，推一条 `creative.op` 事件，然后服务端自动做一次增量检查。

```ts
type Op =
  | { op: 'entity.add'; entity: Omit<Entity, 'id' | 'origin' | 'status' | 'workRefs'> }
  | { op: 'entity.update'; id: string; patch: Partial<Entity> }
  | { op: 'entity.remove'; id: string }                    // 被引用时 409 IN_USE，带引用位置
  | { op: 'relation.add' | 'relation.update' | 'relation.remove'; /* 同上 */ [k: string]: unknown }
  | { op: 'event.add'; event: Omit<WorldEvent, 'id' | 'origin' | 'status' | 'gaps' | 'workRefs'> & { start: { input: string; calendar?: string }; end: { input: string; calendar?: string } } }
  | { op: 'event.update'; id: string; patch: Partial<WorldEvent> & { start?: { input: string; calendar?: string }; end?: { input: string; calendar?: string } } }
  | { op: 'event.remove'; id: string }
  | { op: 'mode.set'; mode: TransportMode } | { op: 'mode.remove'; id: string }
  | { op: 'rule.set'; rule: Omit<WorldRule, 'origin' | 'status'> } | { op: 'rule.remove'; id: string }
  | { op: 'edit.add'; edit: Omit<MapEdit, 'id' | 'origin' | 'status'> } | { op: 'edit.update'; id: string; patch: Partial<MapEdit> } | { op: 'edit.remove'; id: string }
  | { op: 'route.draw'; legId: string; path: GeoJSON.LineString }      // 作者手绘：直接成为正式路线
  | { op: 'route.redraw'; legId: string; hint?: string }               // 让 AI 重画（异步，结果是新的 route 提议）
  | { op: 'proposal.decide'; id: string; decision: 'accepted' | 'rejected' | 'deferred'; ops?: Op[]; candidate?: number }
  | { op: 'constraint.drop'; eventId: string; field: string; reason: string }   // 删约束是明确的设定决定
  | { op: 'world.set'; patch: Partial<Pick<World, 'title' | 'basemap'>> };
```

**补注（2026-11-09，用户同意 DSH 的两处开口）**

1. **只写名字的参与者和地点。** 导入和顾问交上来的提议里，事件的人物、地点可能还没有正式 id，因为它们本身也在待确认里。这时可以留空 `entityId`，只写 `entityName`；地点同理，留空 `placeId`，只写 `placeName`。
   - 服务端在**接受提议、执行操作时**按名字或别名解析，解析不到就整批拒绝。所以正式账本里的事件永远是真 id。
   - 页面在提议卡上照原样显示名字，并标「接受后匹配」。
   - 提议里的硬检查试算：没解析成 id 的人或地点不参与判定，放进 `doubts`，写明「某某还没确认，试算没算他」。不能当作没有冲突。
2. **`Proposal.resolution`。** 记录处理结果、原因、时间，以及是谁做的决定（`user` 是作者，`agent` 是系统自动作废）。
   - 例：作者手绘路线后，旧的推断路线提议改成 `rejected`，`by: 'agent'`，`reason: '作者手绘了新路线'`，不能看起来像作者亲手拒的。
   - 旧数据没有这个字段，页面显示「已处理」。

时间输入只给原文写法（`input`，比如「1684-04-21 08:00」「康熙二十三年三月初七」「出城后三天」），由服务端解析成 `StoryTime`。解析不了返回 422 `TIME_UNPARSED`，并附候选。

## 2. 接口

| 方法 | 路由 | 说明 | 批 |
|---|---|---|---|
| 快照 | `GET /v1/creative/worlds/:dossierId[?version=n]` → `WorldSnapshot` | 打开、刷新、重连都先取它；带 `version` 时只读历史版本 | 1A |
| 改 | `POST /v1/creative/worlds/:dossierId/ops { baseRevision, ops }` → `{ revision, applied: AppliedOp[], check: CheckRun }` | `baseRevision` 落后时返回 409 `REVISION_STALE`，并带最新快照 | 1A |
| 轨迹 | `GET /v1/creative/worlds/:dossierId/tracks?from=&to=&entityIds=` → `{ tracks: Track[], legs: RouteLeg[] }` | 时间轴范围变化时取；改动后由事件提示重取 | 1A |
| 改造层 | `GET /v1/creative/worlds/:dossierId/edits/geojson?t=` → `FeatureCollection` | 这一时刻生效的改造（新增几何、隐藏范围、改名、样式），前端叠在底图上 | 1A |
| 底图 | 复用 `GET /v1/explore/map-config` | 只在 `basemap.kind='real'` 时用 | 1A |
| 全部重查 | `POST /v1/creative/worlds/:dossierId/check` → `CheckRun` | 手动「全部重查」 | 1A |
| 应用修法 | `POST .../ops`，内容是 `fix.ops` | 预览来自 `Fix.preview`，接受后才提交 | 1A |
| 路网导入 | `POST /v1/creative/worlds/:dossierId/network/import { source:'osm', bbox }` 或 `{ source:'azgaar', assetId }` → `{ jobId }` | 异步；进度和结果走事件；`World.network` 跟着变 | 1A |
| 上传 Azgaar | 沿用档案的文件上传 → `assetId` | 用 Azgaar 导出的 `.map` 或 GeoJSON（格式由 DSH 定，交付单写明） | 1A |
| 推断路线 | 服务端遇到 `RouteLeg.kind='none'` 时自动发起；也可以用 `route.redraw` 手动触发 | 结果是 `kind:'route'` 的提议，同时 leg 变成 `inferred`，立即参与轨迹和检查 | 1A |
| 确认版本 | `POST /v1/creative/worlds/:dossierId/versions { summary }` → `WorldVersion` | 1A 只要能存能取，界面放「保存为版本」一个按钮 | 1A |
| 事件流 | `GET /v1/creative/worlds/:dossierId/stream?after=seq`（SSE） | 见 §3 | 1A |

```ts
type AppliedOp = Op & { opId: string; actor: 'user' | 'agent'; summary: string;
  result: { entity?: Entity; event?: WorldEvent; edit?: MapEdit; leg?: RouteLeg; proposal?: Proposal; removedId?: string } };
```

## 3. 事件（`/v1/creative/worlds/:dossierId/stream`）

每条事件是 `{ seq, at, dossierId, type, data }`，`seq` 全局递增。前端按 seq 去重；seq 跳号或断线超过 30 秒，就重取快照。

| `type` | `data` | 前端动作 |
|---|---|---|
| `creative.op` | `{ revision, applied: AppliedOp[] }` | 合并改动；时间范围内有人物受影响就重取轨迹 |
| `creative.check` | `CheckRun` | 刷新冲突列表、地图和时间轴上的红黄标记 |
| `creative.proposal` | `Proposal` | 待确认列表；route 类还要刷新那段虚线 |
| `creative.leg` | `RouteLeg` | 推断路线画好、失败或被确认时 |
| `creative.network` | `NetworkStatus` | 导入进度条和结果 |
| `creative.usage` | `{ cost: Cny }` | 本世界观累计花费（AI 推断路线会花钱）；只显示，不拦截 |

心跳每 15 秒一次。

## 4. 页面（Claude 实现，这里写清楚要读哪些字段）

### 4.1 世界观面布局

```
┌ 实体树 ─────┐┌ 地图（主）──────────────────────────────┐┌ 检查 · 待确认 ┐
│ 人物        ││ 底图 + 当前故事时刻的改造层              ││ 红 2 · 黄 1   │
│ 地点（分层）││ 人物点位（虚线 = 推断路线）              ││ 信息不足 3    │
│  └ 城 └ 楼  ││ 点人物 → 这段行程 / 关联事件             ││ 未覆盖 1      │
│ 物件 组织   ││                                          ││ 待确认：路线 4│
│ 交通 · 规则 ││                                          ││               │
└─────────────┘└──────────────────────────────────────────┘└───────────────┘
┌ 时间轴：每个人物一行（Campfire 式），事件是块；红黄标记挂在块上；拖动或播放 ───────┐
```

- **时间轴**：范围取 `World.timeSpan`；刻度按事件密度自适应，标签直接用 `StoryTime.label`。拖动时间轴，或按「播放」：
  - 地图按 `Track` 移动点位；
  - 改造层按 `edits/geojson?t=` 切换。为避免拖动时请求太多，取数做节流，只在生效时间段的边界上重取。
- **人物点位**：`at` 段在地点上；`move` 段沿路线移动；`unknown` 不画点，人物那一行显示「位置未定 · 原因」；`dead` 之后变灰。
- **点一个事件块**：右栏显示事件详情。出处显示 `basis` 和原文引用（1B 起才有），缺口显示 `gaps`。
- **地点分层**：实体树按 `parentId` 缩进；点建筑会放大到它；楼层和房间没有几何（1A），选中时在右栏列出「属于哪栋楼、和哪些空间相通」。

### 4.2 检查（照抄 Aeon Timeline）

右栏冲突列表分组：红（`hard`）、黄（`suspect`，标「按推断路线估算」）、信息不足、未覆盖。最下面一行写「本次查过、未发现：……」，只列 `clean` 里的类型，不写「没有矛盾」。

点一条冲突：地图和时间轴高亮涉及的事件和路线。修法按钮列出 `fixes`，点开先看 `preview`（前后对照），接受后才提交 `fix.ops`。「全部处理」把能自动处理的修法汇总成一张预览，一起接受。

### 4.3 路线

- `network`：实线。
- `inferred`：虚线，加「推断」标；点开看 `why` 和 `sources`，按钮有「确认」「重画」「自己画」。
- `manual`：实线，加「手绘」标。
- `none`：两点之间不连线，只在时间轴上显示「路线待定 · failure」。

手绘时在地图上逐点点击，双击结束，提交 `route.draw`。

### 4.4 编辑表单

- 实体：名称、别名、地点层级和父级、在地图上点选或圈选位置。
- 事件：标题、参与者及参与方式、地点、起止时间（原文写法输入框，旁边实时显示服务端解析出的 `label`）、类型、叙述性质。
- 交通方式、规则、改造层：画点、线、面，或在底图上点选要隐藏或改名的对象，再填生效时间段和通行性。

所有表单都只提交 `Op`，不在前端校验业务规则；服务端 422 的 `message` 直接显示在对应字段旁边。

### 4.5 现有示例的处理

`creative/world.ts`、`novel.ts` 里的魔戒示例留给 `?preview` 和 CI 使用。真实模式只读接口，空世界观显示「建第一个人物 / 导入路网」引导。示例数据不能用来充当真实验收。

## 5. MVP-1B · 小说双向（2026-11-07 补全）

依据 19 §5、§6，以及 §10 的 1B 行。1A 的约定照旧：原子操作批次、服务端算好、前端不推断、红黄只给冲突。

### 5.1 类型（追加到 `packages/contracts/src/creative.ts`）

```ts
type Work = {
  id: string; worldId: string; kind: 'novel' | 'film' | 'comic'; title: string;
  baseVersion: number;          // 建作品时锁定当时最新的已确认版本，以后不自动更新（逐条更新在 1C）
  revision: number;             // 作品自己的修订号（大纲、章节、正文的操作批次）
  targetWords: number | null; words: number;
  outline: Outline | null;
  chapters: Chapter[];
  source?: { kind: 'import'; assetId: string; title: string; textVersion: number } | null;   // 导入来的作品
};
type Outline = {
  state: 'draft' | 'confirmed';
  logline: string; pov: string; ending: string;
  chapters: { id: string; title: string; scenes: { id: string; title: string; goal: string; eventIds: string[]; targetWords: number | null }[] }[];
  proposalIds: string[];        // 大纲里提到的新设定、新事件：仍然是提议，确认大纲不等于入账
};
type Chapter = { id: string; no: number; title: string; scenes: Scene[] };
type Scene = {
  id: string; title: string; goal: string;
  eventIds: string[];           // 本场引用的事件（双向：事件的 workRefs 也会带上它）
  text: string;                 // 正文，段落用空行分隔
  textVersion: number;          // 每次落笔 +1；改正文都带 baseTextVersion
  words: number; targetWords: number | null;
  state: 'empty' | 'generating' | 'draft' | 'written';
  marks: TextMark[];            // 服务端算好的正文标注，前端只画
};
type TextMark = {
  para: number; from: number; to: number;      // 段落下标 + 段内字符区间
  kind: 'entity' | 'event' | 'conflict' | 'stale_source';
  refId: string;                                // entityId / eventId / conflictId / proposalId
};
type TextEdit = {                               // Proposal.kind = 'text_edit' 的 payload，放在 proposal.ops[0]
  workId: string; sceneId: string; baseTextVersion: number;
  mode: 'draft' | 'continue' | 'complete' | 'rewrite';
  range: { para: number; from: number; to: number } | null;   // rewrite 替换的范围；continue 为 null（接在末尾）
  before: string; after: string;
};
type ImportJob = {
  id: string; workId: string; state: 'queued' | 'running' | 'paused' | 'done' | 'failed';
  chapters: { total: number; done: number }; proposals: number;
  current?: { chapterId: string; title: string } | null;
  error?: string | null; cost: CreativeCny;
};
type GenerateJob = { id: string; workId: string; sceneIds: string[]; done: string[]; state: 'running' | 'stopped' | 'done' | 'failed'; error?: string | null; cost: CreativeCny };
```

`Proposal` 在 1B 用上全部种类。服务端还要多给三个字段：
- `origin.source`：原文位置，加上原句；
- `batchId`：同一章的抽取共用一个；
- `candidates`：别名、共指、年号、古地名这类有多个候选时给出。

`kind:'itinerary'` 是「加人物」提议。它的 `ops` 里包括新人物、几条事件、几段路线；`conflicts` 是服务端先跑过硬检查后的结果。

### 5.2 接口

| 方法 | 路由 | 说明 |
|---|---|---|
| 作品列表 | `GET /v1/creative/worlds/:id/works` → `Work[]`（不带正文） | 左栏「作品」 |
| 建作品 | `POST /v1/creative/worlds/:id/works { kind, title, targetWords? }` → `Work` | 锁定当前最新版本 |
| 作品详情 | `GET /v1/creative/worlds/:id/works/:workId` → `Work` | 带正文和标注 |
| 改作品 | `POST /works/:workId/ops { baseRevision, ops: WorkOp[] }` → `{ revision, work }` | 原子批次，落后时 409 `REVISION_STALE` |
| 生成 | `POST /works/:workId/generate { sceneIds, mode, hint?, range? }` → `GenerateJob` | 已授权的场景连续生成、逐场保存，可以停（`POST .../generate/:jobId/stop`）。产出是 `text_edit` 提议；空场景的起稿可以直接落成 `draft`，由作品设置 `autoAcceptDraft` 决定，默认关 |
| 导入 | `POST /works/:workId/import { assetId } \| { text }` → `ImportJob` | 按章推进；`POST /imports/:jobId/pause`、`/resume` |
| 导入状态 | `GET /imports/:jobId` → `ImportJob` | |
| 待确认 | 沿用世界观快照里的 `proposals`；另加 `GET /v1/creative/worlds/:id/proposals?kind=&batchId=&doubt=&status=` 分页 | 1B 的提议多，单独分页 |
| 批量决定 | 沿用 `ops`：多条 `proposal.decide`，每批不超过 40 条 | 依赖项一起显示；有歧义、要合并、出处过期的不能批量 |
| 助手 | `POST /v1/kernel/runs { dossierId, mode: 'creative_advisor' \| 'creative_writer', query, workId?, sceneId? }` | 对话在 AgentDock 里，沿用探索台的会话事件；助手只能产出提议，不能自己落笔 |
| 导出 | `GET /works/:workId/export?format=md\|docx` | |
| 上传原文 | 沿用 `POST /v1/creative/worlds/:id/assets { name, content, format:'text' }` | 支持 txt 和 md；docx 先不做 |

```ts
type WorkOp =
  | { op: 'work.set'; patch: Partial<Pick<Work, 'title' | 'targetWords'>> & { autoAcceptDraft?: boolean } }
  | { op: 'outline.set'; outline: Omit<Outline, 'state' | 'proposalIds'> }
  | { op: 'outline.confirm' }                                  // 确认大纲：按大纲建章、建场景；新设定照旧留在待确认
  | { op: 'chapter.add'; title: string; at?: number } | { op: 'chapter.update'; id: string; title: string } | { op: 'chapter.remove'; id: string } | { op: 'chapter.move'; id: string; to: number }
  | { op: 'scene.add'; chapterId: string; title: string; at?: number } | { op: 'scene.update'; id: string; patch: Partial<Pick<Scene, 'title' | 'goal' | 'eventIds' | 'targetWords'>> }
  | { op: 'scene.remove'; id: string } | { op: 'scene.move'; id: string; chapterId: string; to: number }
  | { op: 'text.set'; sceneId: string; baseTextVersion: number; text: string }   // 作者直接写：直接落笔
  | { op: 'text.accept'; proposalId: string; text?: string };                      // 接受 AI 的改动；带 text 就是「改后接受」
```

### 5.3 事件（追加）

| `type` | `data` | 前端 |
|---|---|---|
| `creative.work` | `{ workId, revision }` | 重取作品 |
| `creative.text` | `{ workId, sceneId, state, textVersion }` | 场景正在生成 / 已出草稿 |
| `creative.import` | `ImportJob` | 导入进度条 |
| `creative.generate` | `GenerateJob` | 生成进度、停止 |

### 5.4 页面（小说面解锁）

```
┌ 章节 ──────┐┌ 正文 ────────────────────────────┐┌ 本场 · 待确认 · 助手 ┐
│ 作品切换   ││ 第 2 章 · 补斗篷                  ││ 本场目标 / 引用事件   │
│ 卷→章→场景 ││ 段落；@实体 下划线，悬停看设定卡   ││ 待确认（按批次筛）    │
│ 字数/目标  ││ 冲突段落标红黄；过期出处标灰       ││ 写作助手 / 设定顾问   │
└────────────┘└──────────────────────────────────┘└──────────────────────┘
```

- **建作品**：选「从世界观写」或「导入一部小说」。导入向导分三步：上传或粘贴原文 → 看分章结果 → 开始，可以暂停、续做。
- **大纲确认卡**：主线、视角、结局、章场安排、关键事件、目标字数，都能改；确认之后才能「按场景生成」。
- **生成**：选中一场或几场，点「生成」；进度逐场显示，能停。AI 的改动按差异显示，接受才落笔；也能改完再接受。
- **正文**：作者直接写，失焦或停顿 2 秒自动 `text.set`。选中一段可以续写、改写。冲突落在哪一段，就在那一段标红或标黄。
- **待确认**：按批次、种类、有没有疑点筛；明确的项可以批量接受；有歧义的单独处理，显示各个候选和原句。
- **加人物**：设定顾问对话里说「加一个……」，产出一张经历提议卡：人物、几条事件、几段路线和硬检查结果，看过再接受。
- **世界观面联动**：点正文里引用的事件，跳到世界观面的地图和时间轴；事件详情里列出它在哪部作品的哪一章出现。
- **花费**：生成和导入的任务各自显示花费，状态栏显示累计。

### 5.5 首例

- 原创短篇：5,000–10,000 字，3–6 场。
- 公版：《聊斋志异》选两三篇人物走动多、年代写得具体的，比如《王六郎》《聂小倩》《画皮》；原文用维基文库的版本，由用户拍板。

## 6. MVP-1C · 多部作品共用一个世界观，改了设定怎么办（2026-11-09 补全）

依据 19 §7、§10 的 1C 行、§11 的 1C 验收。1A、1B 的约定照旧：原子批次、服务端算好、前端不推断。

一句话：**世界观可以往前改，每部作品自己决定跟不跟。** 改设定从不偷偷改作品；作品用哪套设定，随时能完整还原，检查和助手都按它来。

### 6.1 三个概念

- **草稿和版本**：世界观平时改的都是草稿（`World.version.draftChanges` 记有多少条没成版）。作者点「保存为版本」，草稿上的改动形成新版本 vN。旧版本只读，随时能看（`?version=n`，1A 已有）。
- **设定条目**：版本差异按「条目」算。条目就是带稳定 id 的一样东西：实体、关系、事件、交通方式、规则、改造层。一条条目在一个版本里只有三种变化：新增、修改、删除。
- **作品的设定组合**：作品记三样东西：
  - 基准版本 `baseVersion`（建作品时锁定，1B 已有）；
  - 逐条采用的更新 `picks`：比如「基于 v1，但城门位置用 v2 的」；
  - 本作品局部改写 `overrides`：只对这部作品生效，明确标「本作品设定」。

  三样合起来就是这部作品**实际用的设定**。检查、轨迹、写作助手、设定顾问，在这部作品里一律按它来。

### 6.2 类型（追加到 `packages/contracts/src/creative.ts`）

```ts
type ItemKind = 'entity' | 'relation' | 'event' | 'mode' | 'rule' | 'edit';
type ItemChange = {
  itemId: string; kind: ItemKind; title: string;      // title 给人看：「阊门（地点）」「沈砚病故（事件）」
  change: 'add' | 'update' | 'remove';
  before: unknown | null; after: unknown | null;      // 该条目在两个版本里的完整内容（删除时 after 为 null）
  fields: string[];                                   // 改了哪些字段，人话：「开始时间」「地点」「参与者」
};
// WorldVersion 追加：
type WorldVersion = { n: number; at: Iso; summary: string; changes: number; items?: ItemChange[] };   // items 只在单独取版本时给

// Work 追加：
type WorkSetting = {
  baseVersion: number;
  picks: { itemId: string; fromVersion: number; at: Iso }[];          // 这条条目改用 fromVersion 的内容
  overrides: { itemId: string; kind: ItemKind; patch: unknown; note: string; at: Iso }[];   // 本作品设定
  decisions: { itemId: string; toVersion: number; decision: 'follow' | 'keep'; at: Iso }[];  // 作者对每条更新的决定（含「保留旧版」）
  pendingSync: number;                                  // 还有多少处正文标着「待同步」
};
// Work 上直接带 setting: WorkSetting（baseVersion 移进来，保留原字段兼容）

// 影响清单
type ImpactRef =
  | { kind: 'scene'; workId: string; chapterId: string; sceneId: string; para?: number; quote?: string }
  | { kind: 'event'; eventId: string } | { kind: 'leg'; legId: string };
type ImpactItem = {
  change: ItemChange;
  group: string;                                        // 同一原因的成组：比如「阊门挪了位置」牵出的所有路线和场景同一组
  sure: (ImpactRef & { why: string })[];                // 程序沿引用和依赖找到的，确定受影响
  maybe: (ImpactRef & { why: string; quote: string })[];// AI 在没有明确引用的正文里找到的，附原句和理由
  works: { workId: string; uses: 'old' | 'new' | 'override'; decision: 'follow' | 'keep' | null; checkAfter: CheckRun | null }[];
    // 每部作品现在用这条的哪个版本、作者决定了没有、采用新版后检查结果（服务端试算）
};
type ImpactReport = {
  fromVersion: number; toVersion: number; items: ImpactItem[];
  maybeScan: { state: 'none' | 'running' | 'done' | 'failed'; cost: CreativeCny; error?: string | null };
};

// 正文标注追加一种
// TextMark.kind 加 'sync'：这一段因为某条设定更新待同步，refId = itemId
```

### 6.3 接口

| 方法 | 路由 | 说明 |
|---|---|---|
| 版本详情 | `GET /v1/creative/worlds/:id/versions/:n` → `WorldVersion`（带 `items`） | 版本面板展开看「这一版改了什么」 |
| 草稿差异 | `GET /v1/creative/worlds/:id/versions/draft` → `{ items: ItemChange[] }` | 「保存为版本」前先给作者看会存进哪些改动 |
| 影响清单 | `GET /v1/creative/worlds/:id/impact?from=&to=` → `ImpactReport` | `sure` 当场算好；`maybe` 读最近一次扫描结果 |
| 扫正文 | `POST /v1/creative/worlds/:id/impact/scan { from, to }` → `ImpactReport['maybeScan']` | AI 读各作品正文找「可能受影响」，异步、花钱、只记不拦；进度走 `creative.impact` 事件 |
| 作品实际设定 | `GET /v1/creative/worlds/:id/works/:workId/effective` → `WorldSnapshot` | 同快照形状，内容是这部作品实际用的组合；`check` 也按组合算；条目上带 `setting: 'base' \| 'picked' \| 'override'` |
| 决定 | `POST /works/:workId/ops`，用下面的 `WorkOp` | 同 1B，作品 revision 落后 409 |

```ts
type WorkOp = /* 1B 的全部 */
  | { op: 'setting.follow'; itemId: string; toVersion: number }     // 跟着改：picks 加一条；sure 里的场景标 sync；记 decision
  | { op: 'setting.keep'; itemId: string; toVersion: number }       // 保留旧版：只记 decision，不改 picks
  | { op: 'setting.follow_version'; toVersion: number }             // 整版跟进：baseVersion 换成 toVersion，所有未决定的条目都按 follow 处理
  | { op: 'override.set'; itemId: string; kind: ItemKind; patch: unknown; note: string }   // 本作品改写
  | { op: 'override.remove'; itemId: string }
  | { op: 'override.promote'; itemId: string }                     // 推广到共享世界观：生成一条世界观提议，作品这边不变，等提议被接受
  | { op: 'sync.suggest'; itemId: string; sceneIds: string[] }      // 让写作助手按新设定出修改建议：异步，产出 text_edit 提议（同 1B 的生成任务）
  | { op: 'sync.dismiss'; itemId: string; sceneId: string; reason: string };   // 「这里不用改」：去掉这一处待同步，记原因
```

规则：
- **「改设定本身」不是作品上的操作**：页面带作者回世界观面改草稿，存成新版本后，影响清单按新版重算。历史版本不改写。
- **跟着改 ≠ 改正文**：`setting.follow` 只换设定、给场景标「待同步」。正文要不要改、怎么改，由作者逐处决定：直接改、让助手出建议（`sync.suggest`）、或者「这里不用改」。接受 `text_edit` 提议后，这处待同步自动消掉。
- **混用要查**：作品采用部分新设定后，服务端按新组合跑一遍检查。由混用新冒出来的冲突，在 `ImpactItem.works[].checkAfter` 和作品的 `effective.check` 里标出来，不能因为「各自都对」就算通过。
- **局部改写**只影响本作品；在世界观面看这条条目时，列出「哪些作品改写了它」。`override.promote` 产出普通的世界观提议，走待确认，接受后进入草稿。
- **新作品**：建作品时锁定当前最新的已确认版本；草稿上没成版的改动不进作品。
- **可能影响（maybe）**：只是线索，作者可以忽略；忽略记在 decisions 里，不会反复冒出来。

### 6.4 事件（追加）

| `type` | `data` | 前端 |
|---|---|---|
| `creative.version` | `WorldVersion` | 新版本存好；有作品基于旧版时，弹「有 n 部作品可能受影响」 |
| `creative.impact` | `ImpactReport['maybeScan']` | 扫正文的进度和花费 |
| `creative.work` | 1B 已有 | `setting.*` / `sync.*` 之后重取作品 |

### 6.5 页面（Claude 实现）

- **世界观面 · 版本**（左栏「版本」一节，1A 只有按钮）：
  - 版本列表：每版一行「v2 · 11 月 9 日 · 改了 3 条 · 摘要」，点开看条目变化（前后对照，只标改了的字段）；点「看这一版」进只读视图（1A 已有）。
  - 「保存为版本」先弹草稿差异，填一句摘要再存。
  - 存好以后，如果有作品基于旧版本，地图上方出提示「有 2 部作品基于 v1，看看受什么影响」→ 打开影响面板。
- **影响面板**（世界观面右栏新的一页「影响」）：
  - 按 `group` 分组，每组一行原因，比如「阊门往北挪了 300 米」，展开看条目前后对照；
  - 下面按作品分行：用的是旧版还是新版、确定受影响的章节场景（点了跳过去）、可能受影响的原句（灰色，标「AI 找的，可能不准」）、采用新版后的检查结果（红黄）；
  - 每部作品三个按钮：**跟着改 / 保留旧版 / 改设定**。「改设定」带回世界观面，选中这条条目进编辑；
  - 顶部「让 AI 扫一遍正文」按钮，显示进度和花费；没扫过时 maybe 区写「还没扫」。
- **小说面**：
  - 作品头部一行：「基于 v1 · 采用了 v2 的 2 条 · 本作品改写 1 条 · 待同步 3 处」，点开是设定组合明细，每条可以撤销采用、取消改写。
  - 正文里 `sync` 标注：段落左边一条橙线，悬停写「阊门位置在 v2 改了，这段可能要跟着改」，右键或点开有「让助手改 / 这里不用改」。
  - 待同步的处理：「让助手改」就是 `sync.suggest`，结果进「待确认 · 正文改稿」，和 1B 一样看差异、接受。
- **世界观面 · 按作品看**：顶栏加一个「按作品看」下拉。选了某部作品，地图、时间轴、检查都换成它的实际设定（只读，改写的条目标「本作品」）。

### 6.6 验收（19 §11 的 1C）

在 `dc55c5ff` 上做，两部作品《阊门夜行》《1B 页面验收 · 河边访友》都引用「阊门」和「出阊门」：
1. 存 v3：把「阊门」挪个位置、把「出阊门」改早一小时；存版本前先看到草稿差异。
2. 影响面板：两部作品都列出来；确定受影响的章节场景能跳过去；扫一遍正文，能找到没明确引用、但写了「阊门」的段落。
3. 《阊门夜行》选「跟着改」：设定组合变成「v2 + 2 条 v3」，正文对应段落标待同步；让助手出一条修改建议并接受，这处待同步消掉。
4. 《河边访友》选「保留旧版」：按作品看时，地图上阊门还在老位置；检查结果不变。
5. 「改设定」：从影响面板跳回世界观面，再改一次，存成 v4；影响清单按 v4 重算。
6. 在《阊门夜行》里对「顾嬷嬷」做一条本作品改写；世界观面看顾嬷嬷，能看到「被《阊门夜行》改写」；推广到共享世界观，变成一条待确认提议。
7. 旧版本 v1、v2 都还能只读打开；刷新以后所有决定、组合、待同步都还在。

## 7. 断线与恢复

做法同契约 13 §7：先取快照拿到 `cursor`，再从 `cursor` 订阅事件流；seq 跳号就重取快照。AI 推断路线和路网导入在后台照跑，页面回来以后按事件补上。

## 8. 前端改动清单（Claude）

- `src/data/creative-live.ts`：适配器，实现 `load / ops / tracks / editsAt / check / importNetwork / saveVersion / subscribe`。`creative/mockWorld.ts` 用魔戒示例实现同一个适配器。
- `CreativeStudio.tsx` 的世界观面按 §4.1 重排：新增 `WorldMap.tsx`（MapLibre，复用 `explore/live/mapStyle.ts`）、`StoryTimeline.tsx`、`CheckPanel.tsx`、`ProposalList.tsx`、表单组件。现有关系图挪进实体详情页，作为一个标签页。
- 样式沿用 `creative.css` 和莱茵视觉；红黄两色只用于冲突，橙色留给当前选中项。

## 9. 各批在真实页面上验什么

| 批 | Claude 看什么 |
|---|---|
| 1A | 19 §11 的 1A 全部内容：手工建人物、地点、交通方式和一段行程 → 拖时间轴，看到人物沿真实路网移动 → 改时间出现红色赶不到 → 修法预览、接受、重查后消失；另外四类检查各做一次。古道或桥的改造层按时间切换，路线跟着变。房间的归属和连接能检查。导入一块 OSM 区域和一份 Azgaar 地图。缺路时出现虚线推断路线，算出黄色疑似冲突，确认后变成红色硬冲突。刷新以后都还在 |
| 1B | 原创短篇走一遍；加人物；公版选篇导入；年号换算；导出正文 |
| 1C | 两部作品，改设定，看影响清单，三种决定各做一次 |

## 10. 留给 DSH 的问题

- 本机 Supabase 能不能装 pgRouting（19 的 questions）？装不了的话，先回来说备选方案。
- OpenFreeMap 的矢量瓦片里，要素带不带稳定的 OSM id（`feature.id`）？带的话，「隐藏、改名」可以按 id 精确对准；不带的话，前端按 `target.area` 遮罩处理，`target.osm` 只用来对应路网。请核实后告诉我。
- OSM 区域导入用什么数据源（Overpass 截取，还是 Geofabrik 分省文件），单块范围上限多大，交付单里写清楚。
- Azgaar 用哪种导出格式导入；没有经纬度时，坐标怎么换算到 MapLibre（我倾向于把它当成一块「假经纬度」平面，比例按 `scaleKmPerUnit` 算）。
- 推断路线由哪个角色、用哪个模型来画；它要能查资料（古道、驿道）。一次大概花多少，记进 `creative.usage`。

## 11. MVP-1D · 顾问的提议先画在看板上（2026-11-09）

**为什么做。** 用户定的设计取向：AI 的产出应该是「看板上的一处变化」，不是「一篇新文章」。作者不用从头读一遍，只看动了哪里；委派出去以后，看板上能实时看到 AI 在看什么、做到哪一步，「像 AI 拿着画笔把每一步画出来」。这一批只做**设定顾问**，机制跑通以后，写作助手、扫正文、判规则、导入再按同一套接上。

### 11.1 三件事

1. **提议先画成虚影。** 顾问交上来的提议不落账，先算出「采纳以后看板会多出 / 变掉什么」，在地图、时间轴上画成虚影。作者在看板上点「接受 / 拒绝 / 改一下」。
2. **AI 在看什么，看板上亮出来。** 顾问每次读世界观（某个人物、几条事件、一场正文），推一条「正在看」，看板上把这些东西描一圈，地图上方写一行「顾问 · 正在看沈砚的 4 条事件」。
3. **改一版只看改了什么。** 作者在虚影上说「改一下：让他晚一天出现」，顾问交第 2 版，旧版作废，「被新版替代」。看板上只突出两版之间变了的那几处。

对话里只留一两句话和「在看板上看」的入口，明细不再在对话里复述。

### 11.2 类型（追加到 `packages/contracts/src/creative.ts`）

```ts
/** 提议采纳以后看板上的样子：只算，不落库。按作品看时按作品的实际设定算。 */
export type ProposalPreview = {
  proposalId: string;
  baseRevision: number;
  workId?: string | null;
  /** 新加的条目。id 是预览用的临时 id（`pv:` 开头，同一提议同一修订下稳定），接受后以真 id 为准，前端重取。 */
  added: { entities: Entity[]; events: WorldEvent[]; relations: Relation[]; rules: WorldRule[] };
  /** 改已有条目：复用 1C 的 ItemChange（前后对照）。 */
  changed: ItemChange[];
  removed: { kind: ItemChange['kind']; id: string; title: string }[];
  /** 新事件带出来的行程，按路网算；算不出来 path 为 null，绝不画直线。 */
  legs: CreativeRouteLeg[];
  /** 受影响人物采纳后的轨迹（含新人物），时间轴和播放用。 */
  tracks: Track[];
  /** 只列采纳后新出现的冲突，和消失的冲突 id；已有的冲突不重复列。 */
  conflictsNew: CreativeConflict[];
  conflictsGone: string[];
  /** 名字解析不到的（entityName / placeName），人话。 */
  unresolved: string[];
  /** 这一版替代了旧版时：和旧版比变了什么（条目级，复用 ItemChange）。 */
  vsPrevious?: ItemChange[] | null;
};

/** 看板上的一处东西。 */
export type BoardRef =
  | { kind: 'entity' | 'event' | 'relation' | 'rule' | 'leg'; id: string }
  | { kind: 'scene'; workId: string; sceneId: string; para?: number };

/** AI 正在看 / 正在做什么（事件流 creative.focus）。 */
export type BoardFocus = {
  runId: string;
  mode: 'creative_advisor' | 'creative_writer';
  /** 人话，20 字以内：「正在看沈砚的 4 条事件」「在画老周的路线」「交了提议」「完成」。 */
  step: string;
  refs: BoardRef[];
  /** 交了提议时带上，前端据此取预览。 */
  proposalId?: string | null;
  done?: boolean;
};
```

`Proposal` 追加两个字段：

```ts
  /** 1D：交这条提议的会话；看板卡片「改一下」续在这个会话里。 */
  runId?: string | null;
  /** 1D：这一版替代了哪条旧提议。旧提议作废，resolution = { by:'agent', reason:'被新版替代' }。 */
  supersedes?: string | null;
```

### 11.3 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/creative/worlds/:id/proposals/:pid/preview?workId=` | → `ProposalPreview`。按（提议，世界修订）缓存，世界改了重算。已处理的提议返回 409 `PROPOSAL_SETTLED` |
| POST | `/v1/kernel/runs/:id/messages` | 29 号已有，加可选 `about: { proposalId }`：作者在虚影上说「改一下」时带上，顾问知道改的是哪一条，交新版时填 `supersedes` |

顾问的工具：`propose_setting` 加可选 `supersedes`；读工具每调用一次推一条 `creative.focus`（`refs` 是这次读到的东西，`step` 由服务端按工具和参数写人话，不靠模型）。

提示词底线追加一句：**提议的明细作者会在看板上看到，回复里不复述明细，只说一两句要点和拿不准的地方。**

### 11.4 事件（追加）

| `type` | `data` | 前端 |
|---|---|---|
| `creative.focus` | `BoardFocus` | 看板上把 `refs` 描一圈「AI 在看」，地图上方一行写 `step`；`done` 时撤掉 |
| `creative.proposal` | 已有 | 顾问交的（带 `runId`）：取预览、画虚影、地图飞到虚影范围 |

### 11.5 页面（Claude 实现）

- **虚影层**：
  - 地图：新地点是虚线空心圈；新人物是空心头像；新路线是橙色虚线；改动的条目旧位置淡显、新位置虚线，中间一条细箭头。
  - 时间轴：新人物多一行虚线框；新事件是空心块；改了时间的事件，旧块淡显、新块虚线。
  - 新冲突直接描在虚影上（红 / 黄）；冲突面板只列「采纳后新出现的」和「采纳后消失的」。
  - 播放时虚影人物也沿路走。
- **提议条**（地图上方）：「顾问提议：增设老周 · 1 人物 · 4 事件 · 新冲突 1」，按钮「接受」「拒绝」「改一下…」「先收起」。「改一下」就地展开一个输入框，发到同一会话（带 `about`）。第 2 版起写「第 2 版 · 比上一版：到山村 改晚了一天」，看板上只给变了的几处加橙色描边。
- **默认只画一条**：画的是顾问最新交的那条，或者在待确认里点中的那条，不把所有待确认都画上去。
- **「AI 在看」**：被读到的条目描一圈脉动的细橙线，地图上方一行 `step`；时间轴上被读到的事件块同样描边。
- **对话**：顾问交了提议的那一轮，回复下面有一个「在看板上看《标题》」的小标签，点了回到地图并画出虚影。

### 11.6 验收（真实页面）

1. 顾问里说「加一个渡口的老船夫，和沈砚有交集」：顾问工作时，看板上逐个亮出它在看的人物和事件；交上提议后，地图上出现虚影人物和虚线路线，时间轴多一行虚线；对话里只有一两句话和「在看板上看」。
2. 播放：虚影人物沿路走。
3. 冲突面板只列这条提议新带出来的冲突。
4. 在提议条上「改一下：让他晚一天出现」：交第 2 版，提议条写清比上一版改了什么，看板上只有那几处描边；旧版在待确认里显示「被新版替代」。
5. 接受：虚影变实，冲突照常重算；拒绝：虚影消失。
6. 刷新后，从待确认点开这条提议，仍能看到虚影。
7. 按作品看时问顾问，预览按这部作品的实际设定算。

## 12. MVP-2 · 人物形象：立绘和三视图（2026-11-09）

**为什么做。** 往全链路走的第一段：「小说 → 出图 → 白模 → 视频」里的出图。MVP-3 的白模、镜头都要引用人物的稳定形象，所以形象先要有稳定的资产 ID 和版本。做完以后，活地图上的人物头像从名字首字换成真图。

**取向照 1D**：出图是看板上的一处变化——人物卡上四个格子当场一格格出图，新版先当候选和当前版并排，作者点「用这一版」才换，换了只标出变了的那一格。

### 12.1 定下的几件事（用户没专门定，我按惯例选的，有异议再改）

1. **外貌是设定的一部分。** 人物加一个 `look`（外貌描述，自然语言），和其他设定一样走版本、提议、作品改写；出图只从它读。顾问可以通过提议改 `look`，作者接受后才算数。
2. **画风归世界观。** 世界观加 `artStyle`（如「明清工笔淡彩」），同一世界观所有人物共用，保证放在一起不违和。作品不单独改画风（MVP-3 的成片再说）。
3. **一次出一套四张**：立绘 1 张 + 正、侧、背三视图。先出立绘，三视图拿立绘当参考图出，保证是同一个人。作者也可以只重出其中一格。
4. **出图由作者点，顾问不自己花钱。** 顾问这一批只能提议改 `look`，不能调出图。
5. **文件存在 ReinLab 自己这里**，不只存平台临时链接；取回失败标「待保存」，可以只重试取回，不重新付费。

### 12.2 类型（追加到 `packages/contracts/src/creative.ts`）

```ts
/** Entity.person 追加 */
look?: string | null;            // 外貌描述，设定的一部分

/** CreativeWorld 追加 */
artStyle?: string | null;        // 画风，同一世界观共用

export type PersonView = 'portrait' | 'front' | 'side' | 'back';

/** 一个人物的形象资产：ID 稳定，重出产生新版本。MVP-3 的白模、镜头引用 (assetId, versionId)。 */
export type PersonAsset = {
  id: string;                    // 稳定资产 ID
  entityId: string;
  selectedVersionId: string | null;   // 当前选用的；地图头像、MVP-3 默认引用它
  versions: PersonAssetVersion[];     // 新的在前
};

export type PersonAssetVersion = {
  id: string;
  n: number;                     // 第 n 版
  createdAt: string;
  /** 依据：出图时的世界修订、look 和 artStyle 原文，换了设定能看出这版是按旧设定出的。 */
  basis: { revision: number; look: string; artStyle: string | null; note?: string | null };
  /** 这一版从哪一版改来（只重出某一格、或拿旧版当参考时）。 */
  from?: string | null;
  views: Partial<Record<PersonView, AssetImage>>;
  provider: string; model: string;    // 例：volcengine-ark / seedream-x.x
  cost: Cny | null;                   // 未知就是 null，不记 0
};

export type AssetImage = {
  state: 'queued' | 'generating' | 'unsaved' | 'saved' | 'failed';
  url?: string | null;           // 只在 saved 时有，走 ReinLab 自己的地址
  width?: number; height?: number;
  taskId?: string | null;        // 平台任务号，「待保存」重试取回用
  failure?: string | null;       // 人话：「平台拒绝：内容审核未通过」「取回超时」
};
```

`Entity.person.portrait`（1C 已留）= 选用版本的立绘：`{ assetId, url }`，后端在快照里直接填好，前端不自己拼。

### 12.3 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/creative/worlds/:id/entities/:eid/asset` | → `PersonAsset`（没出过图是 `versions: []`） |
| POST | `/v1/creative/worlds/:id/entities/:eid/asset/versions` | 出一版。body `{ views?: PersonView[]; note?: string; from?: versionId }`。不传 `views` 就是四张全出；`from` + 部分 `views` = 只重出那几格，其余格沿用 `from` 版的图。`look` 为空时 422 `LOOK_MISSING`「先写外貌」。立刻返回新版本（各格 `queued`），之后靠事件更新 |
| POST | `.../asset/versions/:vid/retry` | 只重试取回 `unsaved` 的格子，不重新付费 |
| POST | `.../asset/versions/:vid/stop` | 停掉还没开始的格子；已经在出的照常出完（钱已花） |
| PUT | `.../asset/selected` | `{ versionId }` 用这一版；`null` 取消选用（历史保留） |
| GET | `/v1/creative/assets/files/:fileId` | 图片文件，带登录校验；`url` 就指这里。下载加 `?download=1` |

设定这边：`entity.update` 能改 `person.look`；`world.update`（或现有世界设置接口）能改 `artStyle`。都走现有的修订、版本、作品改写，不另起。

### 12.4 事件（追加）

| `type` | `data` | 前端 |
|---|---|---|
| `creative.asset` | `{ entityId, assetId, version: PersonAssetVersion }` | 人物卡上对应格子换状态 / 出图；选用变了就换地图头像 |
| `creative.usage` | 已有 | 每张图出完记一次（`purpose: 'creative_image'`），按峰值价估；平台没给用量就记未知 |

### 12.5 页面（Claude 实现）

- **人物卡（左栏点人物 → 详情）**：
  - 「外貌」一栏可改；「画风」在世界观设置里。
  - 「形象」区：四格（立绘大、三视图小）。点「出形象」后四格当场变「排队 → 出图中（转圈）→ 图」，失败的格子写原因、给「重试」。
  - 新版先作为候选和当前版并排，标「第 n 版 · 比当前版：外貌改了 / 只重出了侧面」，点「用这一版」才换；没选用前地图头像不变。
  - 每格右上「只重出这一格」；历史版本可展开；能下载。
  - 当前版是按旧外貌出的（`basis.revision` 之后 `look` 又改过），格子上标「外貌已改，这版是旧的」。
- **地图和时间轴**：人物头像用 `portrait.url`（1C 已经能显示，只差真图）；出图中头像外圈转一圈橙色，出完闪一下。
- **顾问**：作者问「沈砚长什么样」时，顾问可以交一条改 `look` 的提议，看板上照 1D 画（人物卡外貌一栏虚影显示新旧对照）。

### 12.6 验收（真实页面，真出图）

1. 给世界观写画风，给沈砚写外貌，点「出形象」：四格依次出图，地图上沈砚的头像外圈转；出完后点「用这一版」，地图头像换成立绘。
2. 刷新、重启控制面后图还在（不是平台临时链接）；能下载原图。
3. 三视图和立绘是同一个人（同一套衣服、发型、脸）；验收时人看，写进记录。
4. 改沈砚的外貌（比如「左眉有一道疤」）：当前版标「外貌已改，这版是旧的」；出第 2 版，并排比，选用后头像换。
5. 只重出侧面：其余三格沿用，新版写「只重出了侧面」。
6. 故意让一格失败（DSH 留一个办法，例如外貌写进会被平台拒的内容，或者断网取回）：格子写人话原因；「待保存」的能只重试取回、不再花钱。
7. 花费：每张图都进 `usage_record`，账本能按版本加出总数。5 个人物各出一套，总花费写进账本。

## 13. MVP-3 · 从小说场景到成片：白模、镜头、Seedance（2026-11-10）

**为什么做。** 全链路的最后一段：「小说 → 出图 → **白模 → 视频**」。作者挑一场正文，分镜导演在看板上搭出这场的房间白模、摆好人物和机位、列出镜头；作者在三维视口里看着改；每个镜头真出视频候选，选好拼成一段成片，能下载。

**取向照 1D / MVP-2**：导演的产出是看板上的变化——白模、人偶、机位、镜头条先以虚影出现，作者接受才落账；出片时镜头格子当场「排队 → 出片中 → 片」，新候选和当前选用并排。

### 13.1 分两半交，验收也分两半

- **3A 白模和镜头（不花出片的钱）**：房间几何、白模、人物体型、镜头表、机位、分镜导演模式、白模预演片段、glTF 导出。
- **3B 真出片（花钱）**：Seedance 候选、选用、拼成片、下载、改设定后镜头标旧。

### 13.2 定下的几件事（我按惯例选的，有异议再改）

1. **白模归地点**（房间这一层），有版本；镜头归作品的某一场，引用白模的明确版本和人物形象的明确版本。改白模、换立绘不自动改已有镜头，只标「依据旧了」。
2. **房间几何**：轮廓（米，局部坐标）、层高、原点锚到底图的经纬度、朝向。室外场景就把那块地方当一个「房间」，没墙。
3. **人物体型**：人物加身高（米）和体型（瘦 / 中等 / 壮），人偶按它摆。~~人偶只画躯干和头，不画四肢~~（2026-11-10 实测推翻）：人偶有头、躯干、长袍下摆、双臂双腿，有走位终点时迈腿摆臂走过去再转向（参考开源 Blockout）。预演越清楚，Seedance 跟得越紧（`BENCHMARKS.md` 2026-11-10 夜）。
4. **分镜导演是 DSH 的第三个模式** `creative_director`，和顾问、写作助手同一套（会话、续一句、focus、提议、改一下）。它只能交提议（白模、镜头表），作者接受才入账；它**不能自己出片**，出片由作者点。
5. **送给 Seedance 的东西**：用「全模态参考」——人物三视图当参考图（每人 1–3 张，总共不超过 9 张），白模预演片段当参考视频（管机位和走位），提示词由服务端按镜头的动作、对白、光线、画风拼。**实测（2026-11-10）：参考视频只认公网 URL**——预演 mp4（24fps）上传火山 TOS 桶 `rein-lab-creative`（私有），用 S3 兼容接口 + SigV4 预签名出一个 2 小时的下载链接交给 Seedance，已跑通。只给首帧当参考图时机位走位基本不跟，所以不再作为退路。密钥 `TOS_ACCESS_KEY / TOS_SECRET_KEY / TOS_BUCKET / TOS_REGION` 在 `local.env`，只在进程内存里读。
6. **白模预演片段由前端渲染**：三维视口按镜头机位录一段（和镜头一样长），传给后端存成资产。后端不跑三维渲染。
7. **成片拼接在服务端**（ffmpeg），只做按顺序硬切拼接，不做转场、配乐、字幕。平台自带的声音保留；不做配音。
8. **用户定（2026-11-10）：不换平台，继续 Seedance 2.0；默认出 480p 草稿、每镜 5 秒**（实测带参考视频约 ¥2.5 一段，3–4 分钟），作者选定后再按需出 720p 定稿（约 ×2.2）；可改 4–10 秒；每次点「出片」只出一个候选。对比过 MiniMax H3：带参考视频时参考视频也按秒收费，768P 一段约 ¥5，不比 Seedance 便宜。

### 13.3 类型（追加到 `packages/contracts/src/creative.ts`）

```ts
export type V3 = [number, number, number];   // 米；x 向右、y 向上、z 向镜头外（three.js 习惯）

/** Entity.place 追加（level 为 room 时用；室外场景也可以用）。 */
room?: {
  outline: [number, number][];   // 局部坐标 (x, z)，米，首尾不重复
  height: number;                // 层高，米
  origin: LngLat | null;         // 局部原点锚在底图上的经纬度
  heading: number;               // 局部 -z 指向的方位角，度（0 = 北）
} | null;

/** Entity.person 追加 */
body?: { heightM: number | null; build: 'slim' | 'average' | 'heavy' | null } | null;

/** 白模：归地点，有版本。 */
export type WhiteboxPrim = {
  id: string;
  kind: 'box' | 'cylinder' | 'prism';
  c: V3;                         // 底面中心
  s: V3;                         // box: 长宽高；cylinder / prism: [半径, 高, 0]
  sides?: number;                // prism 的棱数
  rotY?: number;                 // 绕 y 转，度
  label?: string;                // 「柜台」「门」「窗」
  entityId?: string | null;      // 物件在世界观里有条目就挂上
};
export type Whitebox = { placeId: string; version: number; prims: WhiteboxPrim[]; updatedAt: string };

/** 一个镜头：归作品的一场。 */
export type Shot = {
  id: string;
  n: number;                     // 场内顺序
  workId: string; sceneId: string;
  para?: number | null;          // 对应正文第几段（看板上和正文互相跳）
  durationSec: number;           // 4–10
  placeId: string; whiteboxVersion: number;
  cast: { entityId: string; assetVersionId: string | null; at: V3; facing: number; pose: 'stand' | 'sit' | 'walk'; to?: V3 | null }[];
  // facing：度，0 = 朝 -z（镜头外方向），顺时针为正；at 同样是底面中心（y 一般是 0）。
  camera: { eye: V3; target: V3; fov: number; end?: { eye: V3; target: V3 } | null };
  action: string;                // 这一镜发生什么（人话）
  dialogue?: string | null;
  light?: string | null;         // 「黄昏」「烛光」
  /** 依据旧了：白模或人物形象出了新版、正文这段改了。前端照显示。 */
  stale?: string[];
};

/** 镜头的一个出片候选。 */
export type ShotTake = {
  id: string; shotId: string; n: number; createdAt: string;
  state: 'queued' | 'generating' | 'unsaved' | 'saved' | 'failed';
  url?: string | null; posterUrl?: string | null;
  durationSec: number; resolution: '480p' | '720p';
  /** 出片依据：镜头的样子、白模版本、用了哪些参考图、预演片段、拼好的提示词。 */
  basis: { shotHash: string; whiteboxVersion: number; refImages: { assetVersionId: string; view: PersonView }[]; previewId: string | null; mode: 'reference_video' | 'reference_image_only'; prompt: string };
  provider: string; model: string;
  taskId?: string | null; failure?: string | null;
  cost: CreativeCny | null;
};

/** 一场的成片。 */
export type SceneCut = {
  workId: string; sceneId: string;
  shots: { shotId: string; takeId: string | null }[];   // 每镜选用的候选
  file?: { state: 'building' | 'saved' | 'failed'; url?: string | null; durationSec?: number; failure?: string | null } | null;
};
```

提议追加两种 `kind`：`whitebox`（ops 是 `whitebox.prim.add / update / remove`）和 `shots`（ops 是 `shot.add / update / remove / reorder`），走 1D 的预览、改一下、`supersedes`。

### 13.4 接口

**3A**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/creative/worlds/:id/places/:pid/whitebox?version=` | → `Whitebox`（没有就 `prims: []`, `version: 0`） |
| POST | `/v1/creative/worlds/:id/ops` | 已有。追加 `whitebox.prim.add / update / remove`（带 `placeId`）、`shot.add / update / remove / reorder`；`entity.update` 能改 `place.room`、`person.body` |
| GET | `/v1/creative/worlds/:id/works/:wid/scenes/:sid/shots` | → `{ shots: Shot[]; cut: SceneCut }` |
| POST | `.../shots/:shotId/preview` | 前端上传白模预演片段（`video/webm` 或 `mp4`）和首帧（png）→ `{ previewId, url, posterUrl }`；同一镜头新传的覆盖旧的引用，旧文件留着 |
| POST | `/v1/kernel/runs` | 已有。`mode: 'creative_director'`，带 `workId`、`sceneId` |
| GET | `/v1/creative/worlds/:id/proposals/:pid/preview` | 已有。`whitebox` / `shots` 提议的预览：`added / changed / removed` 里带 prims 和 shots（复用 `ItemChange`，kind 加 `prim`、`shot`） |

**3B**

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `.../shots/:shotId/takes` | 出一个候选。body `{ resolution?: '480p' \| '720p'; durationSec?: number; note?: string }`。没有预演片段时 422 `PREVIEW_MISSING`「先在视口里录一段预演」；镜头里有人物没选用形象时照出，`basis.refImages` 里少那个人并在返回里写一句 |
| POST | `.../takes/:takeId/retry` | 只重新取回 `unsaved`，不重新付费 |
| PUT | `.../shots/:shotId/selected` | `{ takeId }` |
| POST | `.../scenes/:sid/cut` | 按镜头顺序拼选用的候选 → `SceneCut.file` 变 `building`，好了 `saved`；有镜头没选用就 422 `CUT_INCOMPLETE` 并列出哪几镜 |
| GET | `/v1/creative/assets/files/:fileId` | 已有。视频、海报、预演片段、成片都走这里；`?download=1` 带人话文件名（「阊门夜行-出城-镜03-候选2.mp4」） |

### 13.5 事件（追加）

| `type` | `data` | 前端 |
|---|---|---|
| `creative.whitebox` | `Whitebox` | 视口重画 |
| `creative.shot` | `{ workId, sceneId, shots: Shot[] }` | 镜头条、视口机位重画 |
| `creative.take` | `ShotTake` | 镜头格子换状态 / 出片 |
| `creative.cut` | `SceneCut` | 成片进度、好了能播能下 |
| `creative.focus` | 已有 | 导演读到的场景段落、人物、白模部件、镜头，视口和镜头条上描一圈 |
| `creative.usage` | 已有 | 每个候选出完记一条 `purpose: 'creative_video'`，按官方价算已知；没出成的记 0 并注明 |

### 13.6 页面（Claude 实现，「03 视频」解锁）

- **布局**：左边场景正文（当前段落高亮），中间三维视口（白模 + 人偶 + 当前镜头机位视锥），下面镜头条（每镜一格：海报 / 状态 / 时长 / 对白），右边详情和导演对话。
- **视口**：拖人偶、拖机位、切到机位视角；「录预演」按当前镜头机位从 `camera` 运到 `end`，录成和镜头一样长的片段上传。白模和人偶的颜色按 1D：提议是虚影（虚线、半透明橙），改动的描橙边。
- **导演**：对话框里说「把这一场拆成镜头」，导演读正文和设定时视口、正文上逐个亮起它在看的东西；交上白模和镜头表后虚影出现，提议条「接受 / 拒绝 / 改一下 / 先收起」。
- **出片**：镜头格子里「出片」→ 当场「排队 → 出片中 → 片」；候选并排，新候选和当前选用对比，点「用这一条」；可以和预演片段并排对比。
- **成片**：所有镜头都选好了，「拼成片」→ 进度 → 能播、能下载。
- **标旧**：镜头 `stale` 有内容时格子角上标「依据旧了：沈砚出了第 5 版立绘」，点开能「按新的重出」。
- **glTF**：视口「导出白模」，前端用 three.js 导出（人偶一起，带地点和人物 ID）。

### 13.7 验收（真实页面）

**3A**
1. 选《阊门夜行》（或现有作品）里发生在悦来客栈的一场，2–3 个人物；没有就先用写作助手补一场。
2. 导演里说「把这一场拆成镜头」：导演工作时，正文段落、人物、房间逐个亮起；交上白模和 4–6 个镜头的提议，视口和镜头条上是虚影；接受后变实。
3. 「改一下：第 3 镜换成从柜台后面拍」：交第 2 版，只有第 3 镜描橙边。
4. 拖动人偶、改机位，刷新后还在；人偶高矮按人物身高。
5. 每镜「录预演」：片段长度对、机位按设定运动，刷新后能播。
6. 导出 glTF，能在别的查看器里打开（人工看一眼）。

**3B**
7. 对一镜出片：格子当场换状态；出完能播；刷新、重启控制面后还在。
8. 片子里的人物看得出是立绘那个人（人眼看，写进记录）；机位大致跟预演一致。
9. 再出一个候选并排，选用其中一个。
10. 全部镜头选好后拼成片，能播、能下载；长度等于各镜之和。
11. 给沈砚出新版立绘并选用：用到他的镜头标「依据旧了」。
12. 花费：每个候选一条 `creative_video`，按官方价记已知；拼片不花钱。账本加出总数。

### 13.8 修订（2026-11-10）：白模改成「房间壳 + 关系布局 + 求解器」

**为什么改。** 3A 两轮验收，导演交的白模一直出界、超高、悬空。根子是让语言模型直接心算每个部件的三维坐标，连墙和顶棚也让它算；另外判断出界用的射线法对轮廓线上的点不对称（右、后两边的线算外面），贴着东墙、南墙的墙心必被判出界。对比开源做法（`design/BENCHMARKS.md` 2026-11-10，Holodeck / Holodeck 2.0）：**模型只说物件之间的关系，坐标由求解器算**，硬约束保证不出房间、不相撞。

**三层：**
1. **房间壳**：墙、地面、顶棚、门窗洞，服务端按 `place.room` 生成，导演不碰。
2. **布局**：导演只交「放什么、多大、和谁什么关系」，服务端求解器算坐标。
3. **外观**：白模阶段仍是带 `material` / `color` 的方块。

**方位约定**（房间局部坐标）：北 = -z、南 = +z、东 = +x、西 = -x，和 `heading`（局部 -z 指向的方位角）一致。轮廓按边编号时从第一个点起顺序数。

#### 类型（追加）

```ts
export type Side = 'north' | 'south' | 'east' | 'west';

/** 墙上的开口：门、窗。at 是这面墙从西 / 北端算起的位置（0–1 的中点比例）。 */
export type Opening = { kind: 'door' | 'window'; wall: Side | number; at: number; width: number; height: number; sill?: number; label?: string };

/** 物件之间的关系（照 Holodeck 的约束词表，加「叠在上面」）。软约束尽量满足，满足不了列出来；硬约束见下。 */
export type Relation3 =
  | { type: 'wall'; side?: Side | 'any' }               // 靠墙（背贴墙，正面朝屋里）
  | { type: 'middle' }                                   // 在屋子中间一带
  | { type: 'corner'; sides?: [Side, Side] }             // 在墙角
  | { type: 'near' | 'far'; of: string }                 // 靠近 / 远离某件
  | { type: 'front' | 'behind' | 'beside'; of: string }  // 在某件的前面（它正面那侧）/ 后面 / 旁边
  | { type: 'align'; of: string }                        // 和某件中心对齐
  | { type: 'face'; of: string | 'door' | Side }         // 正面朝向某件 / 门 / 某个方向
  | { type: 'on'; of: string };                          // 叠在某件上面（台面、碗架、灯）

/** 导演交的一件东西：只给尺寸和关系，不给坐标。 */
export type LayoutItem = {
  key: string;                         // 本提议内的名字，关系里用它互相引用（「柜台」「桌一」）
  label: string;
  kind: 'box' | 'cylinder';
  size: [number, number, number];      // box: 宽（东西向，未转时）× 高 × 深；cylinder: [半径, 高, 0]
  material?: WhiteboxPrim['material']; color?: string | null;
  relations: Relation3[];
  outside?: boolean;                   // 门外街面这类，按门的位置放到屋外
  entityId?: string | null;
};
```

`WhiteboxPrim` 追加两个只读字段：`from?: 'shell' | 'layout' | 'author'`（房间壳生成 / 求解器摆的 / 作者拖过的），`key?: string`（对应的 `LayoutItem.key`）。前端照旧按 `c` / `s` 画，不用改渲染。

#### 求解器（服务端）

- **硬约束**（满足不了就不摆这件，原因回给导演）：整件在房间轮廓内（按四角判，贴墙件允许贴住墙内皮）；底面落地（`y = 0`），有 `on` 的落在那件的顶面；顶面不超层高；和其他件不穿插；不挡门（门洞前 0.8 米净空）。
- **软约束**：`relations` 里其余的，尽量多满足；满足不了的写进提议的 `unmet: string[]`（人话：「桌二没能靠近柜台：中间被方凳挡着」）。
- 做法照 Holodeck：在网格上按依赖顺序（先被引用的、先大件）逐件深度优先搜索，按满足软约束的多少打分；朝向在 0 / 90 / 180 / 270 里选。可以移植 Holodeck 的求解器（**接入前先核实它的许可**），也可以自己写。
- 结果写成普通的 `whitebox.prim.add`（带 `from: 'layout'`、`key`），所以预览、接受、版本、glTF 都不用改。

#### 工具和接口

- `propose_whitebox` 的输入改成 `{ placeId, openings: Opening[], items: LayoutItem[], note? }`。服务端：生成房间壳（墙按轮廓每条边一段，厚 0.2 米朝屋里长；地面；顶棚放在层高下面；按 `openings` 在墙上开洞）→ 求解布局 → 交提议。导演再也不写坐标。
- 房间没有 `place.room` 时，`propose_whitebox` 可以带 `room: { outline, height }`，和白模一起成为一条提议（接受时一并写进 `place.room`）。
- 「改一下」：导演只交改了的 `items`（按 `key` 合并），没提到的件**保持原坐标不动**，只给改了的和受它影响的重新求解。
- 作者在视口里拖过的件 `from: 'author'`，之后导演改版时这件当固定障碍，不挪。
- `whitebox.prim.update`（已有）：前端拖家具用；服务端照样跑硬约束校验（出房间、穿插就 422）。
- 预览：`ProposalPreview` 追加 `unmet?: string[]`。

#### 顺带要修的

- 判断「点在轮廓内」对边界要对称（压在轮廓线上的算在内，留 1 厘米容差）。
- 交提议时、预览时（带不带 `workId`）、接受时，用**同一套**校验。
- run 带了 `placeId`，白模和镜头都用它；导演认为该换地点要在回复里说，不自己换。
- 白模和镜头一轮交完，作者分开接受（提示词底线写明）；不等作者确认白模再交镜头。
- 回复正文是「（调用工具）」这类占位字也当成空，兜底把最后一次工具的退回原因发给作者。

#### 页面（Claude）

- 视口里能拖家具（`from` 不是 `shell` 的件），松手提交 `whitebox.prim.update`，被拒就弹回原位并写原因。
- 房间壳的件不能拖，剖开显示照旧。
- 提议条多一行「没满足的摆放要求：…」（`unmet`）。

#### 验收（替换 §13.7 的第 2、3 条）

2. 门厅里说「把这一场拆成镜头」：一轮交上白模和镜头两条提议；白模四面墙正好沿门厅轮廓、顶棚不超 3.2 米、所有家具落地或叠在指定件上、互不穿插、都在屋里；接受两条都成功，镜头不标「依据旧了」。
3. 「改一下：柜台挪到西墙，第 3 镜从柜台后面拍」：白模第 2 版只有柜台（和被它挤动的件）变了位置，镜头第 2 版只有第 3 镜变了；其余件、其余镜头（连人物、形象版本）原样。

### 13.9 修订（2026-11-10）：3B 出片按实测定稿 + 场景模板与家具库

**实测依据**（`design/BENCHMARKS.md` 2026-11-10 夜三节，`design/walkthroughs/creative-3/scene-first/`、`kit/`）：同一镜送 Seedance 四次——只给首帧：机位走位不跟；含糊预演（人偶不动、顶棚悬空）：只取大意；清楚预演（人偶会走、白模摆正）：构图走位几乎 1:1；模板门厅 + 家具库：连「什么家具、摆在哪」也跟上。长相靠立绘参考图一直稳。

#### 定下的

1. **平台**：Seedance 2.0（`doubao-seedance-2-0-260128`），用户定不换 H3。**默认 480p 草稿、5 秒**（实测 ¥2.5–2.8 一段、2.5–4 分钟）；作者在候选上点「出定稿」才出 720p（约 ×2.2）。
2. **参考视频走 TOS 预签名**：预演 webm → 服务端 ffmpeg 转 mp4（H.264、24fps、yuv420p、无音轨）→ 传私有桶 `rein-lab-creative` → 签 2 小时 GET 链接当 `reference_video`。base64 会被平台拒（「reference_video must be provided as a web url」）。TOS 用 S3 兼容接口 `{bucket}.tos-s3-{region}.volces.com` + SigV4 预签名即可（实验脚本 `/tmp/mvp3/seedance-video.mjs` 的做法）。参考图（立绘）照旧 base64。
3. **送给 Seedance 的内容**：
   - `content`：文字 + 每个出场人物选用形象的立绘（`reference_image`，首张免费）+ 预演（`reference_video`）；
   - 提示词服务端拼，结构照实测有效的写法：「完全参考 @视频1 的机位、构图、镜头推进、家具位置和人物走位：@视频1 是白模预演，木色的是家具（列出画面里的家具名），〈颜色〉长袍的人偶是 @图片N 里的〈人物〉……」+ 场景（时代、地点、光线、天气）+ 动作 + 运镜 + 画风；
   - **画面里看不见的门窗要写明位置**（「门在镜头背后，画面里的墙上没有门」），否则模型会自己补一道；
   - `resolution`、`duration`、`ratio: '16:9'`、`watermark: false`。
4. **计费**：按返回的 `usage.total_tokens` × 官方单价（带视频输入 ¥28 / 百万 token，不带 ¥46）记已知；没出成的记 0 并注明平台未收费。
5. **预演必须清楚**（前端已做，`Viewport3.tsx`）：人偶有四肢，设了走位终点就迈腿摆臂走过去再转向；白模不悬空、贴轮廓；大面切块避免遮挡。录预演时不画标注。

#### 场景模板与家具库（前端已试做，`furniture.ts`）

- **家具库**：15 种明清家具（八仙桌、长凳、方凳、椅、条案、柜台、货架、碗架、茶炉、屏风、门、窗、灯、坛、匾额），给外框尺寸就按参数拆成面、腿、牙板、层板画出来。**按部件 `label` 认**，认不出照旧画方块。所以**导演交白模时，家具的 `label` 要用库里的名字**（可以加修饰，如「柜台后货架」「八仙桌一」），尺寸用真实尺寸。
- **场景模板**：「客栈门厅」一套（24 件：地面、四墙、临街大门、门外石阶、顶棚、花窗、柜台、货架、油灯、酒坛、茶炉、碗架、条案、匾额、八仙桌 ×2、长凳 ×4），按房间轮廓外接矩形摆，门在南墙正中。页面上「套用场景模板」一键套（先问要不要清掉现有白模），走普通的 `whitebox.prim.add / remove`。
- **给导演**：`propose_whitebox` 可选 `template: '客栈门厅'`——服务端按模板摆出初版，导演再用 `items` 增删改（§13.8 的关系布局照用）。模板清单和家具名清单作为工具说明给导演；以后加茶馆、街巷、城门、渡口、书房，只加数据不改接口。
- 模板和家具的生成代码在前端；服务端需要同一份清单（名称、默认尺寸、模板布局）——把 `furniture.ts` 里的 `innLobbyTemplate` 和家具名单抽到 `packages/contracts` 或共享模块，前后端共用。

#### 3B 验收（替换 §13.7 的 7–12）

7. 门厅（套模板）第 2 镜「出片」：格子当场换状态，约 3 分钟出 480p；能播；刷新、重启后还在。
8. 片子里沈砚是立绘那个人；家具布局、走位、推镜和预演一致（人眼看，写进记录）；画面里没有凭空多出门。
9. 再出一个候选并排，选用其中一个；对选用的点「出定稿」出 720p。
10. 门厅三镜都选好后拼成片，能播能下载，长度等于各镜之和。
11. 给沈砚出新版立绘并选用：用到他的镜头标「依据旧了：沈砚换了形象」。
12. 花费：每个候选一条 `creative_video`，按 token 和官方价记已知；账本加出总数。

## 14. 参考素材库：放链接 → 下载 → 拆解（2026-11-10）

**为什么做。** 用户：「这样我们就有源源不断的素材积累了。」实测（`BENCHMARKS.md` 2026-11-10 夜「视频片段拆解」，`design/walkthroughs/creative-3/breakdown/`）：MediaPipe 逐帧出动作和表情、背景块匹配出运镜、视觉大模型写成带时间码的拆解表，两层互补（模型还纠正了程序的误报）。把它做成助手的工具，拆过的片段进素材库，以后摆走位、写运镜、出片时能直接引用。

### 14.1 定下的

1. **谁来拿视频**：助手调工具，服务端用 **yt-dlp**（公有领域许可；B 站、抖音、微博、YouTube、X、Vimeo 等上千站点）下载，失败再试 lux / BBDown。**不用 computer use 操作用户电脑。**
2. **只取够拆解用的**：最高 720p、默认最长 10 分钟（可指定起止时间只取一段）。
3. **要登录的站点**：用户自己导出 cookie 文件放 `~/.config/reinlab/cookies/<站点>.txt`，服务端只在进程内存里读，不进日志、不回显。没有就照常下公开的，失败把原因说清（要登录 / 地区限制 / 版权加密 / 网站改版）。**有版权加密（DRM）的不下，也不尝试绕过。**
4. **版权**：素材只用来拆解和参考，原片不进作品、不外传；记来源（链接、站点、标题、作者、抓取时间）。原片默认保留在本机私有存储，作者可以「拆完删原片」，只留关键帧缩略图和拆解数据。
5. **素材库按账户共享**，跨世界观复用。

### 14.2 拆解管线（服务端，照实验）

1. **切镜**：ffmpeg 场景检测（或 PySceneDetect），每镜一条记录。
2. **运镜**：背景网格块匹配（抠掉人物框）拟合平移 / 缩放 / 旋转，**每 6 帧比一次**（逐帧会把慢推吞掉）；输出每段的推 / 拉 / 摇 / 移 / 固定 + 幅度。以后要 6 自由度再接 MegaSaM。
3. **动作**：MediaPipe Pose 逐帧（服务端用 MediaPipe 的 Python 包或无头浏览器，DSH 定），多人。
4. **表情**：**先按身体关键点裁出头部、放大到 320 再跑 Face Landmarker**（直接跑中景认不出脸）；52 个表情系数 + 头部朝向；人脸太小（≲ 40 像素）就标「表情测不到」，不编。
5. **事件**：从曲线切出「转头、眨眼、抬眉、皱眉、微笑、张嘴、视线朝下、走 / 停、抬手」等，时间码到毫秒（分辨率一帧）。阈值要防误报（实验里「走动」误报了全程）。
6. **描述**：`doubao-seed-2-1-pro-260915`（账号已开通，能看图看视频）读关键帧 + 事件 JSON，写**镜头拆解表**：运镜一句、按时间码逐段写每个人的动作表情、程序和画面矛盾处、程序没测到的画面信息。
7. **标签**：模型顺手给每镜打标签（动作：回头 / 递东西 / 坐下…；运镜：缓推 / 跟拍…；情绪；场景），素材库按标签搜。

### 14.3 类型（追加）

```ts
export type RefClip = {
  id: string;
  source: { url: string; site: string; title: string | null; author: string | null; fetchedAt: CreativeIso; note?: string | null };
  state: 'queued' | 'downloading' | 'analyzing' | 'ready' | 'failed';
  failure?: string | null;              // 人话：「这个视频要登录才能看（B 站 1080P）」「有版权加密，不下载」
  file?: { url: string; durationSec: number; width: number; height: number; kept: boolean } | null;  // kept=false：拆完删了原片
  shots: RefShot[];
  cost: CreativeCny | null;
};
export type RefShot = {
  id: string; n: number; fromMs: number; toMs: number;
  poster: string | null;                // 关键帧缩略图
  camera: { kind: 'static' | 'push' | 'pull' | 'pan' | 'tilt' | 'track' | 'mixed'; zoom: number; pan: number; tilt: number; text: string };
  people: { track: number; label: string | null; events: { fromMs: number; toMs: number; what: string }[]; faceMeasured: boolean }[];
  table: string;                        // 拆解表（Markdown）
  tags: string[];
  dataUrl: string | null;               // 逐帧数据（关键点、表情系数、运镜步）JSON，驱动人偶以后用
};
```

### 14.4 接口与工具

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/creative/refs` | `{ url, fromSec?, toSec?, note? }` → `RefClip`（queued），之后推 `creative.ref` |
| GET | `/v1/creative/refs?q=&tag=` | 素材库列表 / 搜索（标题、标签、拆解表全文） |
| GET | `/v1/creative/refs/:id` | 单条 |
| POST | `/v1/creative/refs/:id/drop-original` | 拆完删原片（留缩略图和数据） |
| DELETE | `/v1/creative/refs/:id` | 整条删 |

助手工具（顾问、导演都开）：`fetch_reference(url, from?, to?)`、`search_references(q)`、`read_reference(id)`。导演交镜头时可以在镜头上挂 `refShotId`（「这一镜的动作 / 运镜参考素材库第 n 条第 m 镜」）；3B 出片时，作者可以选「用这段参考的动作」——把那一段剪出来作为第二个 `reference_video`，提示词写「人物动作参考 @视频2」。

### 14.5 页面（Claude）

- 视频面右栏加「素材」：贴链接、看进度、列表和搜索；点开一条：播放器 + 按镜头的时间轴（运镜一轨、每个人一轨，事件是色块，悬停看表情系数），右边是拆解表。
- 镜头详情里「参考素材」：挂上的参考镜头，并排播放。

### 14.6 验收

1. 贴一个 B 站公开视频链接：下载、切镜、每镜有运镜、动作和表情事件、拆解表、标签；花费记已知或标未知。
2. 贴一个要登录的高清链接、没放 cookie：给出人话原因，不卡住。
3. 素材库搜「回头」能找到拆过的那镜。
4. 门厅第 2 镜挂上一条参考，出片时「用这段参考的动作」，成片里人物动作跟参考一致（人眼看）。
5. 「拆完删原片」后，缩略图、拆解表、逐帧数据还在，原片没了。
