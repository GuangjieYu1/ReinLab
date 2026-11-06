// 探索台 EXPL 前后端共用类型（design/prd/07-explore-contract.md）。
// 坐标一律 WGS84 [lng, lat]；时间一律带偏移的 ISO 8601；当地日期为 YYYY-MM-DD。
// 只放类型，不放运行时代码。

/** 最小 GeoJSON 几何（RFC 7946），够本契约用。 */
export namespace GeoJSON {
  export type Position = [number, number];
  export type Point = { type: 'Point'; coordinates: Position };
  export type LineString = { type: 'LineString'; coordinates: Position[] };
  export type Polygon = { type: 'Polygon'; coordinates: Position[][] };
  export type MultiLineString = { type: 'MultiLineString'; coordinates: Position[][] };
  export type MultiPolygon = { type: 'MultiPolygon'; coordinates: Position[][][] };
  export type Geometry = Point | LineString | Polygon | MultiPolygon | MultiLineString;
}

export type LngLat = [number, number];
export type Source = { name: string; url?: string; fetchedAt?: string };   // 数据来源，页面照实展示

// ── 计划 ──────────────────────────────────────────
export type PlanState = 'draft' | 'ready' | 'finished' | 'cancelled';     // 草拟 / 待执行 / 结束 / 取消
export type ShootKind = 'portrait' | 'landscape' | 'travel' | 'street';

export type ExplorePlan = {
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

export type StopKind = 'spot' | 'area' | 'waypoint';     // 固定机位 / 一片街区 / 顺路点
export type Stop = {
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
    composition?: string; guidance?: (string | GuidanceLine)[];   // 引导词：有模特才有；第二版每句可带姿势（旧档案是字符串）
    settings?: ShotSettings; frame?: Frame;        // 第二版：参数行、构图框
    outfit?: { palette?: string[]; notes?: string };
    rules?: { text: string; source?: Source }[];
    fallback?: string;                            // 雨天 / 备选
  };
  refs: string[];                                 // 关联的 RefImage id
  source: 'agent' | 'user';
  // 第二版：独立模特站位、相机 / 受光高度、街区参考点、双位置受光
  subjectPoint?: LngLat | null; cameraHeightM?: number; subjectHeightM?: number; areaRef?: LngLat;
  light2?: StopLight2;
};

export type StopLight = {
  horizon: { azimuth: number; elevation: number }[] | null;   // 地平线曲线；null = 没数据
  lit: { start: string; end: string }[] | null;               // 地形见光时段（晴空假设）
  basis: { dem: string; radiusKm: number; resolutionM: number } | null;   // 计算依据，照实展示
};

export type RouteLeg = {
  from: string; to: string;                       // stop id
  geometry: GeoJSON.LineString | null;            // null = 没取到路线，页面写"路线未取得"
  distanceM: number | null; durationS: number | null;
  source: Source;
};
export type Conflict = { stopId: string; text: string };

// ── 画布 ──────────────────────────────────────────
export type CanvasKind = 'marker' | 'arrow' | 'line' | 'freehand' | 'area' | 'note';
export type CanvasObject = {
  id: string;
  kind: CanvasKind;
  geometry: GeoJSON.Geometry;                     // 地理坐标；字号、箭头大小由前端按屏幕渲染
  text?: string;                                  // note / marker 的文字
  links?: { stopId?: string; refId?: string; place?: string };
  author: 'agent' | 'user';
  createdAt: string;
};

export type Viewport = { center: LngLat; zoom: number; bearing: number; pitch: number };
export type Basemap = 'vector' | 'satellite';

// ── 参考与感觉 ─────────────────────────────────────
export type RefImage = {
  id: string;
  origin: 'upload' | 'web';
  kind: 'same-spot' | 'style';                    // 该机位实拍 / 风格参考
  image: { src: string; w?: number; h?: number } | null;   // 页面可显示的地址；null = 只有来源卡
  page?: { url: string; title?: string };         // 原网页
  author?: string; platform?: string; takenAt?: string;
  stopId?: string;
};
export type FeelCard = {
  refIds: string[];
  observations: { aspect: 'light' | 'tone' | 'composition' | 'pose' | 'other'; text: string }[];
  guesses: { aspect: 'time' | 'focal'; text: string }[];   // 推测，页面标"推测"
};

// ── 天气 ──────────────────────────────────────────
// 单位固定，页面和模型一致：云量 %、降水概率 %、降水量 mm/h、风速与阵风 m/s、温度 °C
export type WeatherHour = { at: string; cloud: number | null; precipProb: number | null; precipMm: number | null; wind: number | null; gust: number | null; temp: number | null };
export type StopWeather = {
  stopId: string; at: LngLat;                     // 取预报用的位置（area 取中心，写明）
  hours: WeatherHour[];                           // 覆盖该停留点完整时段（跨午夜不截断），前后各多给 2 小时
  state?: 'ok' | 'out_of_range' | 'failed';       // 这个停留点自己的状态（不同日期可能不同）
  fromDate?: string;                              // out_of_range 时：预计哪天起能查到
};
export type WeatherView = {
  state: 'ok' | 'out_of_range' | 'failed';        // out_of_range = 日期还不在预报范围内
  byStop: StopWeather[];                          // 按停留点分组；同一天不同地点各自一组
  destination: { at: LngLat; hours: WeatherHour[] } | null;   // 还没有停留点时，按目的地给全天
  fetchedAt: string | null; source: Source;
  nextCheckAt: string | null;                     // 下一次后台检查（账户时区 08/16/23）
};
export type WeatherSuggestion = {
  id: string;                                     // 同时是收件箱审批 id
  forRevision: number;
  summary: string;
  changes: { stopId: string; stopName?: string; before: Partial<Stop>; after: Partial<Stop>; why: string }[];
  state: 'pending' | 'applied' | 'dismissed' | 'stale';   // stale = 计划已被改过，不再适用
};

// ── 账户级资料 ─────────────────────────────────────
export type Profile =
  | { id: string; type: 'model'; revision: number; name: string; height?: number; style?: string; experience?: string; wardrobe?: string; notes?: string[] }
  | { id: string; type: 'gear'; revision: number; name: string; kind: 'body' | 'lens'; focal?: [number, number]; aperture?: number; notes?: string; sensor?: { wMm: number; hMm: number } | null }
  | { id: string; type: 'place'; revision: number; name: string; at: LngLat; radiusM: number; standpoint?: string;
      observedOn: string; season?: string; timeOfDay?: string; text: string;
      evidence: { photoIds?: string[]; eventIds?: string[]; dossierId: string }; confirmedBy: 'user' };
export type ProfileSnapshot = { profileId: string; revision: number; data: Profile; deleted?: boolean };   // 资料删了，快照还在

// ── 用量 ──────────────────────────────────────────
export type PlanUsage = {
  byPurpose: { purpose: 'planning' | 'vision' | 'weather_judge' | 'weather_adjust'; calls: number; input: number | null; output: number | null; cache: number | null }[];
  byModel: { model: string; input: number | null; output: number | null }[];
  tools: { name: string; calls: number; costCny: number | null }[];   // Search/Fetch 等按次的
  unknownCalls: number;                                                 // 用量缺失的调用数，不记 0
};

export type AppliedOp = Op & {
  opId: string; actor: 'agent' | 'user';
  summary: string;                           // 右侧操作记录那一行
  result: {                                  // 生效后的权威结果，页面按它更新，不自己推算（新对象的 id 由服务端分配）
    stop?: Stop; removedStopId?: string;
    object?: CanvasObject; removedObjectId?: string;
    plan?: Partial<Pick<ExplorePlan, 'state' | 'destination' | 'days' | 'kinds' | 'feel' | 'people' | 'gear'>>;
    stops?: Stop[];                          // 批量确认等一次改多个停留点时
    routes?: RouteLeg[]; conflicts?: Conflict[];   // 路线重算了就带上（整份替换）
  };
};
export type PendingChange = {                       // 需要用户批准、尚未生效的修改
  approvalId: string;                        // 复用地基第 2 项的审批（收件箱、对话里同一张卡）
  ops: Op[];                                 // 批准后会执行的修改
  summary: string;
  changes: { stopId: string; before: Partial<Stop> | null; after: Partial<Stop> | null }[];   // 前后对照
  forRevision: number;
};

export type Op =
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

// ───────── 第二版（design/prd/10-explore-v2-contract.md）─────────
// ── 停留点细节扩展（旧数据兼容：guidance 允许旧的 string[]，前端读到 string 当 { id, text, pose: null }）──
export type Pose = 'walk' | 'look-back' | 'lean' | 'touch' | 'pockets' | 'scarf' | 'step' | 'stand' | 'sit' | 'squat';
export type GuidanceLine = { id: string; text: string; pose: Pose | null };
export type ShotSettings = {
  bodyId?: string; lensId?: string; snapshot?: { body?: string; lens?: string };   // 资料引用 + 当时名称
  focalMm: number | null; aperture: number | null; shutterS: number | null; iso: number | null;   // 建议起点，未知为 null
};
export type Frame = {                                   // 构图意图（0–1 归一化，原点左上）
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
export type LightState = 'night' | 'terrain' | 'building' | 'maybe_lit' | 'unknown';
export type LightSegment = { start: string; end: string; state: LightState; cause?: { buildingIds?: string[]; note?: string } };
export type PositionLight = {
  point: LngLat; heightM: number; heightAssumed: boolean;
  segments: LightSegment[];                      // 覆盖当天，按时间连续
  litWindows: { start: string; end: string }[];  // 已知数据下预计见光（maybe_lit 的合并）
  missing: string[];                             // 缺项说明，如 "西侧 1 km 外楼高未知"
};
export type StopLight2 = { version: number; computedAt: string; sceneId: string | null; radiusM: number;
  camera: PositionLight; subject: PositionLight | null; dem: string };
// Stop 新增 light2?: StopLight2（服务端算，异步；变化时推 explore.light）

// ── 建筑场景（白模与楼影同源）──
export type Building = {
  id: string; osm: string;                       // 如 'way/123'
  footprint: [number, number][];                 // 局部米制坐标（以 scene.origin 为原点，x 东 y 北），闭合环
  holes?: [number, number][][];
  baseM: number | null;                          // 基底海拔（相对 origin 地面），未知 null
  heightM: number | null; minHeightM: number;    // 未知高度 null：只画轮廓 + 未知标记
  heightSource: 'tag' | 'levels' | 'unknown'; basis: string;   // 如 "building:levels=6 × 3 m"
};
export type BuildingScene = {
  id: string; version: number; origin: LngLat; radiusM: number; fetchedAt: string; source: string;
  buildings: Building[];
  coverage: { status: 'ok' | 'partial' | 'empty' | 'failed'; note: string };   // empty 不代表没有楼
};

// ── 现场记录（独立于计划 revision）──
export type FieldEventKind = 'arrived' | 'shot' | 'note' | 'situation' | 'correction';
export type FieldEvent = {
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
export type FieldEventRecord = FieldEvent & {
  serverId: string; receivedAt: string;
  status: 'ok' | 'orphan' | 'retracted';         // orphan = 点已不在当前计划，待重新关联
  effectiveText?: string;                        // 叠加更正后的内容
};

// ── 照片 ──
export type PhotoStatus = 'uploading' | 'processing' | 'ready' | 'failed';
export type Photo = {
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
export type UploadBatch = { id: string; createdAt: string; files: number; bytes: number;
  uploaded: number; processed: number; failed: number; unsupported: { fileName: string; reason: string }[] };
export type CameraGroup = {
  id: string; label: string;                     // 机身型号；序列号不展示
  photos: number; timezone: string | null; timezoneBasis: 'offset_tag' | 'plan' | 'user' | null;
  offsetSec: number | null; residualSec: number | null;
  status: 'auto' | 'needs_anchor' | 'inconsistent' | 'confirmed';
  anchors: { photoId: string; eventClientId?: string; time?: string; deltaSec: number }[];
  suggestion?: { photoId: string; eventClientId: string; note: string };   // 推荐让用户确认的锚点
};

// ── 回顾成果 ──
export type Comparison = { revisionUsed: number; items: {
  stopId: string; stopName: string;
  evidence: 'shot' | 'arrived_only' | 'none_found';   // none_found ≠ 没去
  plannedStart: string | null; actualStart: string | null; lateMin: number | null;   // 对时不准则 null
  light: string | null; notes: string[]; photoIds: string[];
}[]; unplannedPhotoIds: string[] };
export type Travelogue = { id: string; revision: number; markdown: string; photoIds: string[]; sources: Source[]; updatedAt: string };

// ── 地点经验（账户级资料新类型，与模特 / 器材同一套 /v1/profiles）──
// Profile 增加 | { id; type: 'place'; revision; name; at: LngLat; radiusM: number; standpoint?: string;
//                 observedOn: string; season?: string; timeOfDay?: string; text: string;
//                 evidence: { photoIds?: string[]; eventIds?: string[]; dossierId: string }; confirmedBy: 'user' }
export type ExperienceProposal = { approvalId: string; target: 'model' | 'place'; profileId?: string; title: string;
  text: string; evidence: { photoIds?: string[]; eventIds?: string[]; dossierId: string }; summary: string };

export type OfflineManifest = {
  packId: string; day: string; planRevision: number; createdAt: string;
  area: { corridorM: 500; stopRadiusM: 1000; bounds: [[number, number], [number, number]] };
  tiles: { z: number; x: number; y: number; url: string }[];     // url 为 /v1/explore/offline-tiles/...
  tileTemplate: string;                          // 如 /v1/explore/offline-tiles/<packId>/{z}/{x}/{y}
  tileZoom: { min: number; max: number };
  glyphTemplate: string;                         // 如 /v1/explore/offline-glyphs/{fontstack}/{range}.pbf
  tileBytes: number; limit: { maxTiles: 3000; maxBytes: 52428800; withinLimit: boolean; note?: string };
  style: { vectorTilejson: string };             // 前端改写为离线源
  glyphs: { url: string }[];                     // 只含拉丁 / 标点区段；中文用设备本地字体渲染（第一版已如此）
  scenes: { stopId: string; url: string }[];     // BuildingScene
  plan: string;                                  // GET 计划快照的地址（固定修订）
  light: string; weather: string; refs: { id: string; thumb: string }[];
  unknowns: string[];                            // 如 "D 点楼高缺失"、"天气是 10/31 01:17 的快照"
};
