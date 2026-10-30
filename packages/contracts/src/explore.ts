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
  export type Geometry = Point | LineString | Polygon | MultiLineString;
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
    composition?: string; guidance?: string[];    // 引导词：有模特才有
    outfit?: { palette?: string[]; notes?: string };
    rules?: { text: string; source?: Source }[];
    fallback?: string;                            // 雨天 / 备选
  };
  refs: string[];                                 // 关联的 RefImage id
  source: 'agent' | 'user';
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
  | { id: string; type: 'gear'; revision: number; name: string; kind: 'body' | 'lens'; focal?: [number, number]; aperture?: number; notes?: string };
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
