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
  participants: { entityId: string; as: Participation }[];
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

## 5. MVP-1B（开工前 Claude 再补细节）

- **作品**：`Work { id, kind:'novel'|'film'|'comic', title, baseVersion, picks, overrides, outline, chapters: { id, title, scenes: { id, title, eventIds, text, textVersion, targetWords }[] }[] }`。接口：`/v1/creative/worlds/:id/works`、`/works/:workId`、`/works/:workId/ops`。正文修改也走 ops，带 `textVersion`。
- **助手**：设定顾问、写作助手沿用内核会话：`POST /v1/kernel/runs { dossierId, mode:'creative_advisor' | 'creative_writer', query, workId? }`，在 AgentDock 里对话。助手产出的东西一律是 `Proposal`；正文改动是 `text_edit` 提议（带差异），作者接受才写入。
- **加人物**：设定顾问产出 `kind:'itinerary'` 提议，`ops` 里包含新人物、事件和路线，`conflicts` 是试算后的检查结果。
- **导入**：`POST /works/:workId/import { assetId | text }` → 导入任务。按章推进、能暂停续做；进度走事件 `creative.import`。抽取结果进待确认，可以按 `batchId`、`kind`、`doubts` 筛选后批量决定；被拒绝过的项不会再出现，除非原文或依据变了。
- **历法**：服务端提供 `chinese_era` 历法，负责年号、干支、农历和公历互转。不确定时给 `StoryTime.candidates`。
- **导出**：`GET /works/:workId/export?format=md|docx`。
- **群研委托（可选）**：沿用契约 13 §6，`fromBench:'creative'`；结果卡被采用后，变成一批 `Proposal`。

## 6. MVP-1C（开工前 Claude 再补细节）

- `Work.baseVersion` 加上 `picks: { itemId, fromVersion }[]` 和 `overrides: { itemId, patch, note }[]`；`GET /works/:workId/effective` 还原这部作品实际采用的设定组合。
- 改设定以后：`GET /v1/creative/worlds/:id/impact?fromVersion&toVersion` 返回 `{ items: { itemId, before, after, sure: { workId, chapterId, sceneId, why }[], maybe: { workId, chapterId, quote, why }[] }[] }`。
- 作者决定：`POST /works/:workId/sync { itemId, decision:'follow'|'keep'|'change_world' }`。选「跟着改」时生成 `text_edit` 提议；未处理的地方标「待同步」。

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
