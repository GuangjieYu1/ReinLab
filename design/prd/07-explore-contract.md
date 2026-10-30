# 07 · 探索台 · 前端契约

日期：2026-10-31。分支：`codex/explore-1`。依据：[06-explore.md](06-explore.md)（已批准）、[05-explore-ux.md](05-explore-ux.md)、[03-dossier-contract.md](03-dossier-contract.md)、[04-session-contract.md](04-session-contract.md)。

本文件定义页面需要的数据、动作、事件和状态。前端由 Claude 写，服务端和 Agent 工具由 DSH 写。路由都在 `/backend` 同源前缀下，认 Cookie；写操作带 `X-ReinLab-CSRF: 1` 和 `Idempotency-Key`（地基第 5 项）。错误统一为 `{ code, message }`。

## 0. 页面落在哪

沿用现有四个面，不加新面：

| 面 | 第一版（live） | 说明 |
|---|---|---|
| 01 计划 | **接通** | 中间地图 / 计划书切换（沿用现有 `view: 'map' \| 'doc'`），底部时间线，右侧助手 |
| 02 机位 | **接通，不含白模** | 选中停留点的详情：光线与山影、构图、器材、引导词、服饰、真实参考图、规定、雨天备选。2.5D 白模和机位视角画布显示"下一版"，不放京都示例 |
| 03 现场 | 不接通 | 标签可见但置灰，标"下一版" |
| 04 回顾 | 不接通 | 同上 |

左侧资源管理器两个视图：「计划与停留点」（本计划的停留点、参考资料）和「资料」（账户级模特、器材）。mock 模式保留现在的京都示例，不受影响。

## 1. 数据类型

坐标一律 WGS84 `[lng, lat]`，几何用 GeoJSON。时间一律 ISO 8601 带偏移；"当地日期"用 `YYYY-MM-DD` 加 IANA 时区表达。类型放进 `packages/contracts/src/explore.ts`。

```ts
type LngLat = [number, number];
type Source = { name: string; url?: string; fetchedAt?: string };   // 数据来源，页面照实展示

// ── 计划 ──────────────────────────────────────────
type PlanState = 'draft' | 'ready' | 'finished' | 'cancelled';     // 草拟 / 待执行 / 结束 / 取消
type ShootKind = 'portrait' | 'landscape' | 'travel' | 'street';

type ExplorePlan = {
  dossierId: string;
  revision: number;                 // 每次生效的修改 +1；页面写操作都带 baseRevision
  state: PlanState;
  destination: { name: string; center: LngLat; timezone: string } | null;   // 拍摄地点及其 IANA 时区
  days: string[];                   // 当地日期，如 ['2026-11-15']；可以多天
  kinds: ShootKind[];
  feel: FeelCard | null;            // "想要的感觉"
  people: ProfileSnapshot[];        // 选中的模特（快照）
  gear: ProfileSnapshot[];          // 选中的器材（快照）
  stops: Stop[];
  routes: RouteLeg[];               // 已确认停留点之间的真实步行路线
  conflicts: Conflict[];            // 赶不上拍摄窗口等，交给人和助手调整
  updatedAt: string;
};

type StopKind = 'spot' | 'area' | 'waypoint';     // 固定机位 / 一片街区 / 顺路点
type Stop = {
  id: string;
  kind: StopKind;
  state: 'candidate' | 'confirmed';               // "不要"就是删除，没有第三种状态
  name: string;
  geometry: GeoJSON.Point | GeoJSON.Polygon;      // area 用 Polygon；spot / waypoint 用 Point
  entry?: LngLat; exit?: LngLat;                  // area 可选
  day: string;                                    // 开拍那一刻的当地日期（跨午夜也取开拍日）
  window: { start: string; end: string } | null;  // 完整起止时间（带偏移，可以跨午夜）；未定为 null
  reason?: string;                                // 候选理由（一句话）
  facing?: number;                                // 拍摄朝向，真北 0° 顺时针
  focal?: number[];                               // 推荐焦段（只在用户已有器材内）
  light?: StopLight;                              // 服务端算好的山影与见光
  detail?: {                                      // 按需出现，未知就不给
    composition?: string; guidance?: string[];    // 引导词：有模特才有
    outfit?: { palette?: string[]; notes?: string };
    rules?: { text: string; source?: Source }[];
    fallback?: string;                            // 雨天 / 备选
  };
  refs: string[];                                 // 关联的 RefImage id
  source: 'agent' | 'user';
};

type StopLight = {
  horizon: { azimuth: number; elevation: number }[] | null;   // 地平线曲线；null = 没数据
  lit: { start: string; end: string }[] | null;               // 地形见光时段（晴空假设）
  basis: { dem: string; radiusKm: number; resolutionM: number } | null;   // 计算依据，照实展示
};

type RouteLeg = {
  from: string; to: string;                       // stop id
  geometry: GeoJSON.LineString | null;            // null = 没取到路线，页面写"路线未取得"
  distanceM: number | null; durationS: number | null;
  source: Source;
};
type Conflict = { stopId: string; text: string };

// ── 画布 ──────────────────────────────────────────
type CanvasKind = 'marker' | 'arrow' | 'line' | 'freehand' | 'area' | 'note';
type CanvasObject = {
  id: string;
  kind: CanvasKind;
  geometry: GeoJSON.Geometry;                     // 地理坐标；字号、箭头大小由前端按屏幕渲染
  text?: string;                                  // note / marker 的文字
  links?: { stopId?: string; refId?: string; place?: string };
  author: 'agent' | 'user';
  createdAt: string;
};

type Viewport = { center: LngLat; zoom: number; bearing: number; pitch: number };
type Basemap = 'vector' | 'satellite';

// ── 参考与感觉 ─────────────────────────────────────
type RefImage = {
  id: string;
  origin: 'upload' | 'web';
  kind: 'same-spot' | 'style';                    // 该机位实拍 / 风格参考
  image: { src: string; w?: number; h?: number } | null;   // 页面可显示的地址；null = 只有来源卡
  page?: { url: string; title?: string };         // 原网页
  author?: string; platform?: string; takenAt?: string;
  stopId?: string;
};
type FeelCard = {
  refIds: string[];
  observations: { aspect: 'light' | 'tone' | 'composition' | 'pose' | 'other'; text: string }[];
  guesses: { aspect: 'time' | 'focal'; text: string }[];   // 推测，页面标"推测"
};

// ── 天气 ──────────────────────────────────────────
// 单位固定，页面和模型一致：云量 %、降水概率 %、降水量 mm/h、风速与阵风 m/s、温度 °C
type WeatherHour = { at: string; cloud: number | null; precipProb: number | null; precipMm: number | null; wind: number | null; gust: number | null; temp: number | null };
type StopWeather = {
  stopId: string; at: LngLat;                     // 取预报用的位置（area 取中心，写明）
  hours: WeatherHour[];                           // 覆盖该停留点完整时段（跨午夜不截断），前后各多给 2 小时
};
type WeatherView = {
  state: 'ok' | 'out_of_range' | 'failed';        // out_of_range = 日期还不在预报范围内
  byStop: StopWeather[];                          // 按停留点分组；同一天不同地点各自一组
  destination: { at: LngLat; hours: WeatherHour[] } | null;   // 还没有停留点时，按目的地给全天
  fetchedAt: string | null; source: Source;
  nextCheckAt: string | null;                     // 下一次后台检查（账户时区 08/16/23）
};
type WeatherSuggestion = {
  id: string;                                     // 同时是收件箱审批 id
  forRevision: number;
  summary: string;
  changes: { stopId: string; before: Partial<Stop>; after: Partial<Stop>; why: string }[];
  state: 'pending' | 'applied' | 'dismissed' | 'stale';   // stale = 计划已被改过，不再适用
};

// ── 账户级资料 ─────────────────────────────────────
type Profile =
  | { id: string; type: 'model'; revision: number; name: string; height?: number; style?: string; experience?: string; wardrobe?: string; notes?: string[] }
  | { id: string; type: 'gear'; revision: number; name: string; kind: 'body' | 'lens'; focal?: [number, number]; aperture?: number; notes?: string };
type ProfileSnapshot = { profileId: string; revision: number; data: Profile; deleted?: boolean };   // 资料删了，快照还在

// ── 用量 ──────────────────────────────────────────
type PlanUsage = {
  byPurpose: { purpose: 'planning' | 'vision' | 'weather_judge' | 'weather_adjust'; calls: number; input: number | null; output: number | null; cache: number | null }[];
  byModel: { model: string; input: number | null; output: number | null }[];
  tools: { name: string; calls: number; costCny: number | null }[];   // Search/Fetch 等按次的
  unknownCalls: number;                                                 // 用量缺失的调用数，不记 0
};
```

## 2. 读接口

| 路由 | 返回 |
|---|---|
| `GET /v1/explore/plans/:dossierId` | `{ plan: ExplorePlan, canvas: CanvasObject[], refs: RefImage[], lastViewport: Viewport \| null, basemap: Basemap }` |
| `GET /v1/explore/plans/:dossierId/weather?stopId=` | `WeatherView`；不带 `stopId` 返回全部已确认停留点 |
| `GET /v1/explore/plans/:dossierId/suggestions` | `{ items: WeatherSuggestion[] }` |
| `GET /v1/explore/plans/:dossierId/usage` | `PlanUsage` |
| `GET /v1/explore/places?q=&near=lng,lat` | `{ items: { name: string; address?: string; at: LngLat; source: Source }[] }`（页面搜索框用） |
| `GET /v1/explore/map-config` | `{ vectorStyle: string; satellite: { tilejson: string; attribution: string }; contours: { tilejson: string }; publicKey: string }`（地图公开 key，按 PRD 2.2 只给地图） |
| `GET /v1/profiles?type=model\|gear` | `{ items: Profile[] }` |
| `GET /v1/account/settings` | `{ timezone: string \| null }` |

太阳：**前端用 SunCalc 现算，负责页面上的即时展示**（拖时间线要流畅，不能每帧请求）；**服务端也用 SunCalc 算一份**，给 Agent 工具、后台天气判断和 PDF 用。两边同一个库、同一套约定，结果应一致：

- 方位：真北 0°，顺时针，单位度；高度角单位度。
- 时刻：按停留点的经纬度和拍摄地点 IANA 时区；输出带偏移的 ISO 时间。
- 金色时刻：太阳高度 −4°～6°；蓝调：−6°～−4°；日出 / 日落按 SunCalc 默认（上缘接触地平线）。
- 地形：服务端另给 `StopLight`（地平线曲线、见光时段）。前端判断某时刻是否见光：太阳高度 > 该方位地平线仰角。

## 3. 写接口：页面和 Agent 用同一组动作

所有计划和画布修改走同一个入口，Agent 的工具在服务端调用同一套动作（PRD 4.3，"页面和工具共用业务动作"）：

```
POST /v1/explore/plans/:dossierId/ops
{ baseRevision: number, ops: Op[], authorization?: { messageId: string } }   // authorization 只有 Agent 会带
→ 200 { revision, applied: AppliedOp[], pending: PendingChange | null }
→ 409 { code: 'REVISION_CONFLICT', revision }
```

```ts
type AppliedOp = Op & { opId: string; actor: 'agent' | 'user'; summary: string };   // summary 是右侧操作记录那一行
type PendingChange = {                       // 需要用户批准、尚未生效的修改
  approvalId: string;                        // 复用地基第 2 项的审批（收件箱、对话里同一张卡）
  ops: Op[];                                 // 批准后会执行的修改
  summary: string;
  changes: { stopId: string; before: Partial<Stop> | null; after: Partial<Stop> | null }[];   // 前后对照
  forRevision: number;
};
```

```ts
type Op =
  // 停留点
  | { op: 'stop.add'; stop: Omit<Stop, 'id' | 'state' | 'source'> & { state?: 'candidate' | 'confirmed' } }
  | { op: 'stop.update'; id: string; patch: Partial<Stop> }
  | { op: 'stop.remove'; id: string }                         // 候选"不要"、已确认删除都用它
  | { op: 'stop.confirm'; ids: string[] }                     // 逐点或一组
  // 计划
  | { op: 'plan.set'; patch: Partial<Pick<ExplorePlan, 'destination' | 'days' | 'kinds'>> }
  | { op: 'plan.confirm' }                                    // 整份确认：所有候选 → 已确认，状态 → ready，开始天气检查
  | { op: 'plan.finish' } | { op: 'plan.cancel' }
  | { op: 'plan.select'; people?: string[]; gear?: string[]; refresh?: boolean }   // 选资料；refresh=true 采用最新修订
  | { op: 'feel.set'; feel: FeelCard }
  // 画布
  | { op: 'canvas.add'; object: Omit<CanvasObject, 'id' | 'author' | 'createdAt'> }
  | { op: 'canvas.update'; id: string; patch: Partial<CanvasObject> }
  | { op: 'canvas.remove'; id: string }
  | { op: 'canvas.undo' }                                     // 撤回最近一笔画布改动（规则见下），服务端生成反向动作
  // 视野（只记最后视野，不进 revision）
  | { op: 'view.save'; viewport: Viewport; basemap: Basemap };
```

**批量与修订**

- 一次请求里的 ops 是**一个原子批次**：要么全部生效，要么全部不生效。全部生效时修订号 **+1**（一批只加一次），推一条 `explore.op`。
- 批次里只要有一项需要用户批准，**整批都不执行**，返回 `applied: []` 和一个 `pending`，修订号不变。批准后服务端在当时的最新修订上执行；如果目标已经变了（比如那个停留点已被删除），审批卡显示"已不适用"，不执行。待批的修改**绝不**出现在 `applied` 里，也不推 `explore.op`。
- `view.save` 只记最后视野，不加修订、不推事件。
- 页面收到 `explore.op`：`revision === 本地修订 + 1` 就按顺序应用 `applied`；否则重取 `GET /plans/:id`。
- **409**：页面先重取最新状态，再看用户刚才的操作是否还成立（比如要"留下"的候选还在、还是候选）。成立就带新的 `baseRevision` 重发一次；不成立就提示"计划刚被改过"，不自动覆盖。

**授权（服务端判断，前端只显示结果）**

- 页面发来的 op（会话是用户本人）：点击即授权，直接执行，`pending` 永远为空。
- Agent 发来的 op：普通编辑（候选、草图、补充构图和引导词等）直接执行。会改变已确认内容的（候选 → 已确认、改已确认停留点的地点 / 日期 / 时段、删除已确认停留点、改计划状态）需要授权：
  - 带了 `authorization.messageId`：服务端从同账户、同档案的真实用户消息或已批准的审批里取出这条授权，核对它**指向的目标、操作和修改范围**与本批次一致，一致才直接执行；只核对"消息存在、是用户说的"不算。
  - 没带或对不上：返回 `pending`，出一张计划修改卡。
- 服务端维护的字段（`id`、`source`、`revision`、`state`）不能通过 `stop.update` 的 `patch` 改写；状态只能经 `stop.confirm` / `plan.confirm` 等动作改变。`stop.add` 里带 `state: 'confirmed'` 同样按上面的授权规则判断。

**路线**：已确认停留点变化后，服务端在同一批次里重算步行路线并写进 `plan.routes`，页面不自己连线。

**撤回**

- 用户的 `canvas.undo`：撤回最近一笔画布改动，**不论是谁画的**（包括 Agent 的涂鸦）。
- Agent 的 `canvas.undo`：只撤回 Agent 自己的画布改动。
- 撤回只影响画布对象，不连带撤销停留点和路线；服务端把实际执行的反向动作记成一条 `AppliedOp`（summary 如"撤回：圈出白川附近街区"）。

其他写接口：

| 路由 | 用途 |
|---|---|
| `POST /v1/explore/plans/:dossierId/refs`（multipart，`file` + `kind`） | 上传参考图 → `RefImage`；随后由助手读图 |
| `DELETE /v1/explore/plans/:dossierId/refs/:id` | 移除参考 |
| `POST /v1/profiles` / `PATCH /v1/profiles/:id` / `DELETE /v1/profiles/:id` | 模特、器材增改删（`PATCH` 带 `baseRevision`） |
| `PUT /v1/account/settings` `{ timezone }` | 账户时区 |
| `POST /v1/approvals/:id/decide`（已有） | 天气调整"应用"= approve，"不用"= reject |
| `POST /v1/explore/plans/:dossierId/snapshots`（multipart：`file` PNG + `key: 'overview' \| <stopId>` + `revision` + `basemap: 'vector'` + `attribution`） | 上传地图快照，按（修订, key）保存；同一修订同一 key 重传则覆盖 |
| `POST /v1/explore/plans/:dossierId/books` `{ variant: 'brief' \| 'full', revision }` | 生成 PDF → `202 { jobId }`；完成后作为档案成果出现，并推 `explore.book`。缺本修订所需快照 → `409 { code: 'NEEDS_MAP_SNAPSHOTS', keys }` |

## 4. 事件（沿用 `/v1/stream`）

| 事件 | 载荷 | 页面怎么做 |
|---|---|---|
| `explore.op` | `{ dossierId, revision, applied: AppliedOp[] }` | 本地 `revision + 1 === revision` 时直接应用到地图、候选卡、时间线；对不上就重拉 `GET /plans/:id`。每条 `summary` 在右侧对话里显示为一行操作记录（如"圈出白川附近街区"），Agent 和用户的都显示 |
| `explore.camera` | `{ dossierId, runId, viewport, basemap? }` | Agent 移动视野。**跟随**时用 ≥600 ms 的平滑动画飞过去；用户手动拖过地图就进入**不跟随**，地图角落出现"跟随助手"按钮，点了再回到跟随。这个事件不存档，刷新后不重放 |
| `explore.weather` | `{ dossierId, checkedAt, state, suggestionId? }` | 刷新天气条；有建议就在计划上挂提示 |
| `explore.book` | `{ dossierId, jobId, state: 'done' \| 'failed', artifactId?, message? }` | 计划书按钮从"生成中"变成"打开"，或照实显示失败原因 |
| `explore.snapshots_needed` | `{ dossierId, revision, keys: string[] }` | 页面开着且停在这份档案：在后台用矢量底图逐个导出 `keys` 对应的快照并上传（不打断用户当前视野，用离屏地图），传完服务端继续生成 |
| `dossier.changed`（已有） | | 头部名字、成果数刷新 |

Agent 的操作要**逐条实时**推送，不能等这一轮回答结束再一次性出现（PRD 4.3）。服务端每执行一个工具动作就推一条 `explore.op` 或 `explore.camera`。

## 5. 右侧助手

- 用现有 `AgentDock`，会话即这份探索档案的 DSH 运行（模式同研究台精读：发一句起一轮，事件流回放）。
- **候选卡由计划状态渲染，不由消息内容渲染**：工具结果里带 `stopIds`，对话里按 id 显示对应停留点的卡（名称、类型、时段、理由、"留下 / 不要"）。地图上点"留下"，对话里的卡同时变成已确认，反过来也一样。
- 计划修改卡、天气调整卡、"整份确认"都用对话里的审批卡样式（同精读里的入档卡），和收件箱是同一张。
- 参考图：对话输入框支持拖入 / 粘贴图片，先走 `POST /refs` 上传，再把 `refId` 随消息发出。"想要的感觉"卡钉在计划顶部，推测项标"推测"。

## 6. 页面状态

| 状态 | 表现 |
|---|---|
| 计划 `draft` | 候选以虚线 / 空心显示，已确认实心；顶部"确认整份计划"按钮 |
| 计划 `ready` | 显示"待执行 · 下次天气检查 hh:mm（账户时区）"；仍可编辑，编辑后保持 `ready` |
| 账户时区未设 | 第一次确认整份计划时，确认卡里带一行"天气检查按 Asia/Shanghai 的 08/16/23"（默认取浏览器时区），可以改，确认即保存。不另做设置页 |
| 天气 `out_of_range` | 时间线天气轨写"还没进入预报范围，约 MM-DD 起可查"，不画假数据 |
| 山影 `null` / 路线 `null` | 写"没有地形数据 / 路线未取得"，不画默认值 |
| 地图跟随 / 不跟随 | 见第 4 节 |
| 底图 | 矢量 / 卫星按钮切换；切换不丢停留点、路线和草图；卫星显示官方署名和"历史影像"字样 |

## 7. 计划书

- **网页**：就在计划面的"计划书"视图里（现有 `view: 'doc'`），分"精简 / 详细"两个标签，手机宽度下单栏。页面上的"打印"按钮直接调用浏览器打印（打印样式为 A4）。
- **PDF**：由 DSH 自己生成（用户决定，不走 Playwright 渲染网页）。前端不参与排版，只做两件事：
  1. 提供地图快照（矢量底图，不用卫星）：`overview` 一张全程路线图（两版都用），详细版另加每个已确认停留点一张局部图（key 为 stopId）。每张都标明修订号、底图和地图来源署名。
  2. 等 `explore.book` 事件，完成后显示"打开"。
- **用户在页面上点"生成 PDF"**：页面先导出并上传本修订缺少的快照，再调 `books`。
- **Agent 发起生成**（用户在对话里说"出一份计划书"）：服务端先查本修订的快照是否齐全。齐全就直接生成；不齐全就推 `explore.snapshots_needed`，打开着的页面补传后继续。页面没开，工具如实返回"需要打开这份计划的页面补齐地图"，Agent 照实告诉用户，**不假称已生成**。不为此新建浏览器自动化。
- 生成好的 PDF 作为档案成果（`kind: 'file'`），标题写明"精简 / 详细 · 第 N 版"。计划后来改了，旧 PDF 不动。

### 7.1 PDF 格式规范（交给 DSH）

通用：A4 竖版，页边距 15 mm；中文用思源黑体（或同类开源黑体），数字和英文用等宽体；黑白为主，强调色只用莱茵橙 `#FF6A00`；每页页脚写"计划名 · 第 N 版 · 生成时间 · 页码"。地图快照用页面上传的图，图下注地图来源署名。未知的内容（规定、备选、天气）写"未知"，不编造，也不留空白占位。

**精简版（一页）**

| 区块 | 内容 |
|---|---|
| 页头 | 计划名、地点、日期（当地）、拍法、模特（只写称呼） |
| 路线图 | 全程快照，停留点按顺序编号 |
| 时间表 | 每个已确认停留点一行：编号、名称、类型、时段、焦段、一句话要点（光线或引导词） |
| 底部 | 日出 / 日落 / 金色时刻、天气摘要（取自最近一次预报，写明获取时间）、装备清单 |

放不下时不要缩小字号硬塞：每行要点截短，并在页脚写"内容较多，详见详细版"。

**详细版**

- 第 1 页总览：同精简版，外加"想要的感觉"（观察 + 推测，推测标"推测"）。
- 之后每个已确认停留点一页：局部地图快照；类型和时段；光线（太阳方位、地形见光时段，没有数据写"未知"）；构图和朝向；焦段；引导词（有模特才有）；服饰（色板 + 文字）；真实参考图（最多 3 张，每张图下写作者 / 平台 / 原网页链接）；规定（带出处）；雨天备选。
- 最后一页：天气预案（各停留点的逐时天气摘要）、完整装备清单、全部参考来源列表。

## 8. 用量

计划面"···"菜单里的"本计划用量"：按用途列调用数和输入 / 输出 token，按模型分项，Search/Fetch 单独列次数。未知的写"未知 n 次"，不记 0（PRD 10）。

## 9. 和 PRD 对齐的结果（2026-10-31，Codex 已确认）

1. **太阳前后端各算一份**（第 2 节）：前端负责即时展示，服务端给 Agent、后台和 PDF，同一个库、同一套约定。
2. **账户时区不做设置页**（第 6 节）：PRD 说"未设置时应由用户设置"。我建议放在第一次"确认整份计划"的确认卡里，默认浏览器时区，可以改。少一个页面，且正好在需要它的时刻出现。
3. **"明确要求不重复审批"由服务端判断**（第 3 节）：Agent 带上授权消息 id，服务端核对目标、操作和范围；前端只显示结果。
4. **网上找到的参考图存一份副本**（用户已同意）：小红书、Instagram 的外链大多防盗链，页面和 PDF 都会显示不出来。入档时由服务端存一份副本供显示，同时保留原网页、作者和平台；副本只在本人档案内显示。拿不到图就只显示来源卡。
5. **PDF 由 DSH 自己生成**（用户决定）：不用 Playwright 渲染网页，也就不需要打印会话。前端只上传地图快照，格式按 7.1。
6. **现场和回顾两个面在 live 模式置灰**，不显示京都示例（PRD 1 已要求"不以示例冒充"）。

## 10. 已定的小问题

- 跨午夜的停留点：`day` 取开拍地点的当地日期，`window` 保留完整起止时间，天气取完整时段。
- 撤回：用户可撤回最近一笔画布改动（包括 Agent 的）；Agent 自主撤回只限自己的。
- 地图公开 key：由 `map-config` 下发，服务商端限制来源，不扩大到其他密钥。
