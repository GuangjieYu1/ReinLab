// 创作台 CRTV 前后端共用类型（design/prd/20-creative-contract.md §1，1A 部分）。
// 只放类型，不放运行时代码；坐标一律 WGS84 [lng, lat]，时间用 StoryTime。
// 冲突、路程、故事时间换算、出处状态、版本组合全部由服务端算，前端不推断。

import type { GeoJSON, LngLat } from './explore';

export type { GeoJSON, LngLat };

export type CreativeIso = string;
/** 金额：用量未知 → { value:null, known:false }，不记 0。 */
export type CreativeCny = { value: number | null; known: boolean };
/** 处理状态。出处性质和它分开：basis 说依据，status 说作者是否确认。 */
export type Decision = 'pending' | 'accepted' | 'rejected' | 'deferred';

export type CreativeProvenance = {
  /** 原文明写 / 推断 / 未知 / 作者手写。 */
  basis: 'explicit' | 'inferred' | 'unknown' | 'author';
  by: 'user' | 'route_ai' | 'advisor' | 'writer' | 'importer' | 'swarm';
  source?: {
    workId: string;
    textVersion: number;
    chapterId: string;
    para: number;
    sentence: number;
    quote: string;
  } | null;
  /** 推断依据（人话）；作者确认后也保留，不伪装成原文明写。 */
  why?: string;
  stale?: boolean;
};

/** 故事时间：服务端换算，前端只显示 label。t 是世界纪元起的分钟数。 */
export type StoryTime = {
  t: number | null;
  range?: [number, number] | null;
  label: string;
  original?: string;
  calendar?: string;
  relative?: {
    to: string;
    rel: 'before' | 'after' | 'meets' | 'during' | 'overlaps' | 'equals';
    offsetMin?: [number, number];
  } | null;
  certainty: 'exact' | 'range' | 'relative' | 'unknown';
  candidates?: { t: number; label: string; why: string }[];
};

export type Calendar = { id: string; name: string; kind: 'gregorian' | 'chinese_era' | 'custom'; note?: string };

export type NetworkStatus = {
  state: 'none' | 'importing' | 'ready' | 'failed';
  sources: {
    kind: 'osm' | 'azgaar' | 'manual';
    bbox?: [number, number, number, number];
    edges: number;
    importedAt: CreativeIso;
  }[];
  error?: string;
};

/** 底图：真实（复用探索台 map-config）/ 生成（Azgaar）/ 空白。 */
export type CreativeBasemap =
  | { kind: 'real'; bbox: [number, number, number, number] }
  | { kind: 'generated'; source: 'azgaar'; scaleKmPerUnit: number | null; assetId: string }
  | { kind: 'blank'; scaleKmPerUnit: number | null };

export type World = {
  id: string;
  dossierId: string;
  title: string;
  revision: number;
  version: { latest: number; draftChanges: number };
  basemap: CreativeBasemap;
  /** MVP-2：画风，同一世界观共用（出图描述由它 + 人物外貌 + 作者备注拼）。 */
  artStyle?: string | null;
  timeSpan: { from: StoryTime; to: StoryTime } | null;
  calendars: Calendar[];
  network: NetworkStatus;
};

// ── 实体 ──────────────────────────────────────────
export type EntityKind = 'person' | 'place' | 'item' | 'org';
export type PlaceLevel = 'world' | 'region' | 'city' | 'building' | 'floor' | 'room' | 'site';

export type Entity = {
  id: string;
  /** 1C：按作品看时，这条来自基准版本 / 逐条采用 / 本作品改写。 */
  setting?: 'base' | 'picked' | 'override';
  /** 1C：哪些作品改写了这条（世界观面「被《X》改写」）。 */
  overriddenBy?: { workId: string; workTitle: string }[];
  kind: EntityKind;
  name: string;
  aliases: string[];
  summary?: string;
  origin: CreativeProvenance;
  status: Decision;
  place?: {
    /** MVP-3：房间轮廓/层高/原点/朝向（室外场景也可以当一个没墙的房间）。 */
    room?: {
      outline: [number, number][];
      height: number;
      origin: LngLat | null;
      heading: number;
    } | null;
    level: PlaceLevel;
    parentId: string | null;
    geo: GeoJSON.Geometry | null;
    geoCertainty: 'exact' | 'area' | 'unlocated';
    connects: { to: string; passable: boolean; note?: string }[];
    osm?: { type: 'node' | 'way' | 'relation'; id: number; version?: number } | null;
  };
  /** 出生、死亡也是事件：这里存事件 id。 */
  person?: { born?: string | null; died?: string | null;
    /** MVP-2：外貌描述，设定的一部分（出图只从它读）。 */
    look?: string | null;
    /** MVP-3：人偶按它摆（身高米、体型）。 */
    body?: { heightM: number | null; build: 'slim' | 'average' | 'heavy' | null } | null;
    /** MVP-2：选用的立绘（稳定资产 ID + 可直接取的图）。地图上用它当头像；没有就用名字首字。 */
    portrait?: { assetId: string; url: string } | null };
  workRefs: { workId: string; chapterId?: string }[];
};

export type Relation = {
  id: string;
  /** 1C：按作品看时，这条来自基准版本 / 逐条采用 / 本作品改写。 */
  setting?: 'base' | 'picked' | 'override';
  /** 1C：哪些作品改写了这条（世界观面「被《X》改写」）。 */
  overriddenBy?: { workId: string; workTitle: string }[];
  a: string;
  b: string;
  label: string;
  from?: StoryTime | null;
  to?: StoryTime | null;
  origin: CreativeProvenance;
  status: Decision;
};

// ── 事件账本 ──────────────────────────────────────
export type Participation = 'actor' | 'present' | 'remote' | 'mentioned';

export type WorldEvent = {
  id: string;
  /** 1C：按作品看时，这条来自基准版本 / 逐条采用 / 本作品改写。 */
  setting?: 'base' | 'picked' | 'override';
  /** 1C：哪些作品改写了这条（世界观面「被《X》改写」）。 */
  overriddenBy?: { workId: string; workTitle: string }[];
  title: string;
  what: string;
  kind: 'stay' | 'travel' | 'interaction' | 'birth' | 'death' | 'other';
  /**
   * 导入来的事件还不知道实体 id（那些实体也在待确认里）：这时 `entityId` 留空，
   * 用 `entityName` 按名字/别名解析（服务端在应用操作时解析，解析不到就整批拒绝）。
   */
  participants: { entityId: string; entityName?: string; as: Participation }[];
  placeId: string | null;
  /** 同 entityName：地点还在待确认里时只写名字，接受提议时解析，解析不到整批拒绝。 */
  placeName?: string;
  start: StoryTime;
  end: StoryTime;
  travel?: { fromId: string | null; toId: string | null; modeId: string | null } | null;
  narrative: 'fact' | 'hearsay' | 'dream' | 'hypothetical' | 'flashback';
  origin: CreativeProvenance;
  status: Decision;
  /** 服务端写：缺什么导致检查做不了（人话）。 */
  gaps: string[];
  workRefs: { workId: string; chapterId?: string; sceneId?: string }[];
};

// ── 规则 ──────────────────────────────────────────
export type TransportMode = {
  id: string;
  /** 1C：按作品看时，这条来自基准版本 / 逐条采用 / 本作品改写。 */
  setting?: 'base' | 'picked' | 'override';
  /** 1C：哪些作品改写了这条（世界观面「被《X》改写」）。 */
  overriddenBy?: { workId: string; workTitle: string }[];
  name: string;
  kmPerHour: number;
  network: 'road' | 'water' | 'any' | 'none';
  note?: string;
};

export type WorldRule = {
  id: string;
  /** 1C：按作品看时，这条来自基准版本 / 逐条采用 / 本作品改写。 */
  setting?: 'base' | 'picked' | 'override';
  /** 1C：哪些作品改写了这条（世界观面「被《X》改写」）。 */
  overriddenBy?: { workId: string; workTitle: string }[];
  text: string;
  /** null = 程序还判不了 → 检查里显示「未覆盖」。 */
  machine: { kind: 'teleport' | 'remote_presence' | 'resurrection' | 'custom'; params: Record<string, unknown> } | null;
  origin: CreativeProvenance;
  status: Decision;
};

// ── 改造层 ────────────────────────────────────────
export type MapEdit = {
  id: string;
  /** 1C：按作品看时，这条来自基准版本 / 逐条采用 / 本作品改写。 */
  setting?: 'base' | 'picked' | 'override';
  /** 1C：哪些作品改写了这条（世界观面「被《X》改写」）。 */
  overriddenBy?: { workId: string; workTitle: string }[];
  title: string;
  effect: 'add' | 'hide' | 'rename' | 'restyle' | 'passability';
  target: {
    /**
     * 取地图瓦片上的 feature.id（OpenMapTiles 编码：floor(id/10) 就是 OSM id）。
     * 本机 OpenFreeMap 的每个要素都带这个 id，所以「隐藏/改名」能精确对准。
     */
    osm?: { type: 'node' | 'way' | 'relation'; id: number; version?: number };
    area?: GeoJSON.Polygon;
    placeId?: string;
  } | null;
  geometry?: GeoJSON.Geometry | null;
  props?: {
    name?: string;
    style?: 'wall' | 'road' | 'ancient_road' | 'water' | 'building' | 'area' | 'mark';
  };
  /** 影响路网时才有；外观和通行分开记。 */
  passable?: { open: boolean; modeIds?: string[] } | null;
  valid: { from: StoryTime | null; to: StoryTime | null };
  needsRemap?: boolean;
  origin: CreativeProvenance;
  status: Decision;
};

// ── 路线 ──────────────────────────────────────────
export type RouteKind = 'network' | 'manual' | 'inferred' | 'none';

export type CreativeRouteLeg = {
  id: string;
  entityId: string;
  fromEventId: string;
  toEventId: string;
  modeId: string | null;
  kind: RouteKind;
  /** none 时为 null；绝不给直线冒充路线。 */
  path: GeoJSON.LineString | null;
  segments?: { from: number; to: number; kind: 'network' | 'inferred' }[];
  distanceKm: number | null;
  durationMin: number | null;
  inferred?: { proposalId: string; why: string; sources: { title: string; url?: string }[] } | null;
  failure?: string | null;
};

// ── 轨迹 ──────────────────────────────────────────
export type Track = {
  entityId: string;
  spans: (
    | { kind: 'at'; t0: number; t1: number; eventId: string; placeId: string | null; at: LngLat | null }
    | { kind: 'move'; t0: number; t1: number; legId: string; routeKind: RouteKind }
    | { kind: 'unknown'; t0: number; t1: number; why: string }
    | { kind: 'dead'; t0: number }
  )[];
};

// ── 检查 ──────────────────────────────────────────
export type ConflictKind =
  | 'double_location'
  | 'travel_time'
  | 'dead_appearance'
  | 'presence'
  | 'place_hierarchy'
  /** 29 号：自然语言规则由模型判出来的「疑似」（永远 severity: suspect）。 */
  | 'rule_model';

export type Fix = {
  id: string;
  label: string;
  kind: 'move_this' | 'move_other' | 'drop_constraint' | 'other';
  ops: CreativeOp[];
  preview: { eventId?: string; field: string; before: string; after: string }[];
};

export type CreativeConflict = {
  id: string;
  kind: ConflictKind;
  /** 红 / 黄：按未确认推断路线算出来的只能是 suspect。 */
  severity: 'hard' | 'suspect';
  entityIds: string[];
  eventIds: string[];
  legIds?: string[];
  why: string;
  numbers?: { needMin?: number; haveMin?: number };
  fixes: Fix[];
};

export type CheckRun = {
  id: string;
  at: CreativeIso;
  revision: number;
  conflicts: CreativeConflict[];
  /** 信息不足（不算通过）。 */
  insufficient: { eventId: string; gaps: string[] }[];
  /** 规则程序还判不了。 */
  uncovered: { ruleId: string; why: string }[];
  /** 本次查过、未发现冲突的类型（不等于「完全没矛盾」）。 */
  clean: ConflictKind[];
};

// ── 待确认 ────────────────────────────────────────
export type Proposal = {
  id: string;
  batchId?: string;
  kind:
    | 'route'
    | 'entity'
    | 'event'
    | 'merge'
    | 'relation'
    | 'rule'
    | 'map_edit'
    | 'itinerary'
    | 'text_edit'
    | 'whitebox'
    | 'shots';
  title: string;
  summary: string;
  /**
   * 接受后要执行的操作。`kind:'text_edit'` 的提议把 `TextEdit` 放在 `ops[0]`
   * （契约 §5.1，多带一个 `op:'text.set'` 标记），由作品的 `text.accept` 落实，
   * 世界观账本不执行它。
   */
  ops: CreativeOp[];
  origin: CreativeProvenance;
  /** 1D：交这条提议的会话（看板卡片「改一下」续在这个会话里）。 */
  runId?: string | null;
  /** 1D：这一版替代了哪条旧提议（旧提议作废，原因「被新版替代」）。 */
  supersedes?: string | null;
  /** 「让助手改」时模型判断这段不用改：after 和原文一字不差，前端显示「这段不用改」+ 一键 dismiss。 */
  unchanged?: boolean;
  doubts: string[];
  dependsOn: string[];
  conflicts: CreativeConflict[];
  candidates?: { label: string; ops: CreativeOp[]; why: string }[];
  status: Decision;
  /**
   * 处理结果和原因：手绘路线会让同一段旧的推断提议作废（1A 遗留 1），
   * 作者拒绝、暂缓也记在这里，页面显示「已作废：你手绘了这段」而不是悄悄消失。
   */
  resolution?: { decision: Decision; reason: string; at: CreativeIso; by: 'user' | 'agent' } | null;
};

// ── 版本（1A 只保留，1C 才有界面）───────────────
export type WorldVersion = {
  n: number;
  at: CreativeIso;
  summary: string;
  changes: number;
  /** 只在单独取版本时给：这一版相对上一版改了哪些条目。 */
  items?: ItemChange[];
};

// ── 操作 ──────────────────────────────────────────
export type CreativeOp =
  | { op: 'entity.add'; entity: Omit<Entity, 'id' | 'origin' | 'status' | 'workRefs'> }
  | { op: 'entity.update'; id: string; patch: Partial<Entity> }
  | { op: 'entity.remove'; id: string }
  | { op: 'relation.add'; relation: Omit<Relation, 'id' | 'origin' | 'status'> }
  | { op: 'relation.update'; id: string; patch: Partial<Relation> }
  | { op: 'relation.remove'; id: string }
  | {
      op: 'event.add';
      event: Omit<WorldEvent, 'id' | 'origin' | 'status' | 'gaps' | 'workRefs'> & {
        start: { input: string; calendar?: string };
        end: { input: string; calendar?: string };
      };
    }
  | {
      op: 'event.update';
      id: string;
      patch: Partial<WorldEvent> & {
        start?: { input: string; calendar?: string };
        end?: { input: string; calendar?: string };
      };
    }
  | { op: 'event.remove'; id: string }
  | { op: 'mode.set'; mode: TransportMode }
  | { op: 'mode.remove'; id: string }
  | { op: 'rule.set'; rule: Omit<WorldRule, 'origin' | 'status'> }
  | { op: 'rule.remove'; id: string }
  | { op: 'edit.add'; edit: Omit<MapEdit, 'id' | 'origin' | 'status'> }
  | { op: 'edit.update'; id: string; patch: Partial<MapEdit> }
  | { op: 'edit.remove'; id: string }
  /** 作者手绘：直接成为正式路线。 */
  | { op: 'route.draw'; legId: string; path: GeoJSON.LineString }
  /** 让 AI 重画（异步，结果是新的 route 提议）。 */
  | { op: 'route.redraw'; legId: string; hint?: string }
  | {
      op: 'proposal.decide';
      id: string;
      decision: 'accepted' | 'rejected' | 'deferred';
      ops?: CreativeOp[];
      candidate?: number;
    }
  /** 删约束是明确的设定决定。 */
  | { op: 'constraint.drop'; eventId: string; field: string; reason: string }
  | { op: 'world.set'; patch: Partial<Pick<World, 'title' | 'basemap' | 'artStyle'>> }
  // ── MVP-3：白模与镜头（契约 §13.4）──
  | { op: 'whitebox.prim.add'; placeId: string; prim: Omit<WhiteboxPrim, 'id'> & { id?: string } }
  | { op: 'whitebox.prim.update'; placeId: string; id: string; patch: Partial<WhiteboxPrim> }
  | { op: 'whitebox.prim.remove'; placeId: string; id: string }
  | { op: 'shot.add'; shot: Omit<Shot, 'id' | 'stale' | 'preview'> & { id?: string } }
  | { op: 'shot.update'; id: string; patch: Partial<Shot> }
  | { op: 'shot.remove'; id: string }
  | { op: 'shot.reorder'; sceneId: string; order: string[] }
  /** 只在作品里落实：`kind:'text_edit'` 的提议用它（契约 §5.1）。世界观账本不执行。 */
  | ({ op: 'text.set' } & TextEdit);

export type CreativeAppliedOp = CreativeOp & {
  opId: string;
  actor: 'user' | 'agent';
  summary: string;
  result: {
    entity?: Entity;
    event?: WorldEvent;
    edit?: MapEdit;
    leg?: CreativeRouteLeg;
    proposal?: Proposal;
    removedId?: string;
    /** MVP-3：白模与镜头。 */
    placeId?: string;
    version?: number;
    prim?: WhiteboxPrim;
    shot?: Shot;
    sceneId?: string;
    id?: string;
  };
};

// ── 作品（1B，契约 §5.1）─────────────────────────
export type Work = {
  id: string;
  worldId: string;
  /** 1B 先做小说；影视、漫剧留到后面。 */
  kind: 'novel' | 'film' | 'comic';
  title: string;
  /** 建作品时锁定当时最新的已确认版本，以后不自动更新（逐条更新在 1C）。 */
  baseVersion: number;
  /** 作品自己的修订号：大纲、章节、正文的操作批次。 */
  revision: number;
  targetWords: number | null;
  words: number;
  outline: Outline | null;
  chapters: Chapter[];
  /** 导入来的作品。 */
  source?: { kind: 'import'; assetId: string; title: string; textVersion: number } | null;
  /** 空场景起稿是否直接落成 draft；默认关（作者接受才算写过）。 */
  autoAcceptDraft?: boolean;
  /** 这部作品实际用的设定组合（1C）。 */
  setting?: WorkSetting;
};

export type Outline = {
  state: 'draft' | 'confirmed';
  logline: string;
  pov: string;
  ending: string;
  chapters: {
    id: string;
    title: string;
    scenes: { id: string; title: string; goal: string; eventIds: string[]; targetWords: number | null }[];
  }[];
  /** 大纲里提到的新设定、新事件：仍然是提议，确认大纲不等于入账。 */
  proposalIds: string[];
};

export type Chapter = { id: string; no: number; title: string; scenes: Scene[] };

export type Scene = {
  id: string;
  title: string;
  goal: string;
  /** 本场引用的事件（双向：事件的 workRefs 也会带上它）。 */
  eventIds: string[];
  /** 正文，段落用空行分隔。 */
  text: string;
  /** 每次落笔 +1；改正文都带 baseTextVersion。 */
  textVersion: number;
  words: number;
  targetWords: number | null;
  state: 'empty' | 'generating' | 'draft' | 'written';
  /** 服务端算好的正文标注，前端只画。 */
  marks: TextMark[];
};

export type TextMark = {
  para: number;
  from: number;
  to: number;
  kind: 'entity' | 'event' | 'conflict' | 'stale_source' | 'sync';
  /** entityId / eventId / conflictId / proposalId。 */
  refId: string;
};

/** `Proposal.kind = 'text_edit'` 的 payload，放在 `proposal.ops[0]`（契约 §5.1）。 */
export type TextEdit = {
  workId: string;
  sceneId: string;
  baseTextVersion: number;
  mode: 'draft' | 'continue' | 'complete' | 'rewrite';
  /** rewrite 替换的范围；continue 为 null（接在末尾）。 */
  range: { para: number; from: number; to: number } | null;
  before: string;
  after: string;
};

export type ImportJob = {
  id: string;
  workId: string;
  state: 'queued' | 'running' | 'paused' | 'done' | 'failed';
  chapters: { total: number; done: number };
  proposals: number;
  current?: { chapterId: string; title: string } | null;
  error?: string | null;
  cost: CreativeCny;
};

export type GenerateJob = {
  id: string;
  workId: string;
  sceneIds: string[];
  done: string[];
  state: 'running' | 'stopped' | 'done' | 'failed';
  error?: string | null;
  cost: CreativeCny;
};

export type WorkOp =
  | { op: 'work.set'; patch: Partial<Pick<Work, 'title' | 'targetWords'>> & { autoAcceptDraft?: boolean } }
  | { op: 'outline.set'; outline: Omit<Outline, 'state' | 'proposalIds'> }
  | { op: 'outline.confirm' }
  | { op: 'chapter.add'; title: string; at?: number }
  | { op: 'chapter.update'; id: string; title: string }
  | { op: 'chapter.remove'; id: string }
  | { op: 'chapter.move'; id: string; to: number }
  | { op: 'scene.add'; chapterId: string; title: string; at?: number }
  | {
      op: 'scene.update';
      id: string;
      patch: Partial<Pick<Scene, 'title' | 'goal' | 'eventIds' | 'targetWords'>>;
    }
  | { op: 'scene.remove'; id: string }
  | { op: 'scene.move'; id: string; chapterId: string; to: number }
  /** 作者直接写：直接落笔。 */
  | { op: 'text.set'; sceneId: string; baseTextVersion: number; text: string }
  /** 接受 AI 的改动；带 text 就是「改后接受」。 */
  | { op: 'text.accept'; proposalId: string; text?: string }
  // ── 1C：设定组合与待同步（契约 §6.3）──
  | { op: 'setting.follow'; itemId: string; toVersion: number }
  | { op: 'setting.keep'; itemId: string; toVersion: number }
  | { op: 'setting.follow_version'; toVersion: number }
  | { op: 'override.set'; itemId: string; kind: ItemKind; patch: unknown; note: string }
  | { op: 'override.remove'; itemId: string }
  | { op: 'override.promote'; itemId: string }
  | { op: 'sync.suggest'; itemId: string; sceneIds: string[] }
  | { op: 'sync.dismiss'; itemId: string; sceneId: string; reason: string };

// ── 设定条目与版本差异（1C，契约 §6.2）──────────
export type ItemKind = 'entity' | 'relation' | 'event' | 'mode' | 'rule' | 'edit' | 'prim' | 'shot';

/** 一条设定条目在两个版本之间的变化。 */
export type ItemChange = {
  itemId: string;
  kind: ItemKind;
  /** 给人看的：「阊门（地点）」「出阊门（事件）」。 */
  title: string;
  change: 'add' | 'update' | 'remove';
  /** 该条目在两个版本里的完整内容；删除时 after 为 null。 */
  before: unknown | null;
  after: unknown | null;
  /** 改了哪些字段（人话）。 */
  fields: string[];
};

/** 作品的设定组合：基准版本 + 逐条采用 + 本作品改写 + 作者决定。 */
export type WorkSetting = {
  baseVersion: number;
  /** 这条条目改用 fromVersion 的内容。 */
  picks: { itemId: string; fromVersion: number; at: CreativeIso }[];
  /** 本作品局部改写（只对这部作品生效）。 */
  overrides: { itemId: string; kind: ItemKind; patch: unknown; note: string; at: CreativeIso }[];
  /** 作者对每条更新的决定（含「保留旧版」）。 */
  decisions: { itemId: string; toVersion: number; decision: 'follow' | 'keep'; at: CreativeIso }[];
  /** 还有多少处正文标着「待同步」。 */
  pendingSync: number;
};

// ── 影响清单（1C，契约 §6.2）──────────────────────
export type ImpactRef =
  | { kind: 'scene'; workId: string; chapterId: string; sceneId: string; para?: number; quote?: string }
  | { kind: 'event'; eventId: string }
  | { kind: 'leg'; legId: string };

export type ImpactItem = {
  change: ItemChange;
  /** 同一原因的成组（比如「阊门挪了位置」牵出的所有路线和场景同一组）。 */
  group: string;
  /** 程序沿引用和依赖找到的，确定受影响。 */
  sure: (ImpactRef & { why: string })[];
  /** AI 在没有明确引用的正文里找到的，附原句和理由。 */
  maybe: (ImpactRef & { why: string; quote: string })[];
  works: {
    workId: string;
    uses: 'old' | 'new' | 'override';
    decision: 'follow' | 'keep' | null;
    checkAfter: CheckRun | null;
  }[];
};

export type ImpactReport = {
  fromVersion: number;
  toVersion: number;
  items: ImpactItem[];
  maybeScan: { state: 'none' | 'running' | 'done' | 'failed'; cost: CreativeCny; error?: string | null };
};

// ── 提议在看板上的虚影（1D，契约 §11.2）──────────
/** 提议采纳以后看板上的样子：只算，不落库。按作品看时按作品的实际设定算。 */
export type ProposalPreview = {
  proposalId: string;
  baseRevision: number;
  workId?: string | null;
  /** 新加的条目；id 是预览用临时 id（`pv:` 开头，同一提议同一修订下稳定）。 */
  added: {
    entities: Entity[];
    events: WorldEvent[];
    relations: Relation[];
    rules: WorldRule[];
    /** MVP-3：白模部件与镜头。 */
    prims?: WhiteboxPrim[];
    shots?: Shot[];
  };
  /** 改已有条目：复用 1C 的 ItemChange（前后对照）。 */
  changed: ItemChange[];
  removed: { kind: ItemChange['kind']; id: string; title: string }[];
  /** 新事件带出来的行程，按路网算；算不出来 path 为 null，绝不画直线。 */
  legs: CreativeRouteLeg[];
  /** 受影响人物采纳后的轨迹（含新人物），时间轴和播放用。 */
  tracks: Track[];
  /** 只列采纳后新出现的冲突，和消失的冲突 id。 */
  conflictsNew: CreativeConflict[];
  conflictsGone: string[];
  /** 名字解析不到的（entityName / placeName），人话。 */
  unresolved: string[];
  /** 这一版替代了旧版时：和旧版比变了什么（条目级）。 */
  vsPrevious?: ItemChange[] | null;
};

/** 看板上的一处东西。 */
export type BoardRef =
  | { kind: 'entity' | 'event' | 'relation' | 'rule' | 'leg'; id: string }
  | { kind: 'scene'; workId: string; sceneId: string; para?: number };

/** AI 正在看 / 正在做什么（事件流 creative.focus）。 */
export type BoardFocus = {
  runId: string;
  mode: 'creative_advisor' | 'creative_writer' | 'creative_director';
  /** 人话，20 字以内。 */
  step: string;
  refs: BoardRef[];
  /** 交了提议时带上，前端据此取预览。 */
  proposalId?: string | null;
  done?: boolean;
};

// ── 人物形象（MVP-2，契约 §12.2）──────────────────
export type PersonView = 'portrait' | 'front' | 'side' | 'back';

/** 一格图的状态。 */
export type AssetImage = {
  state: 'queued' | 'generating' | 'unsaved' | 'saved' | 'failed';
  /** 只在 saved 时有：走 ReinLab 自己的地址。 */
  url?: string | null;
  width?: number | null;
  height?: number | null;
  /** 平台任务号：待保存重试取回用。 */
  taskId?: string | null;
  /** 人话原因。 */
  failure?: string | null;
};

export type PersonAssetVersion = {
  id: string;
  n: number;
  createdAt: string;
  /** 出图依据：那时的世界修订、look、artStyle、作者备注。 */
  basis: { revision: number; look: string; artStyle: string | null; note?: string | null };
  /** 这一版从哪一版改来（只重出某格 / 拿旧版当参考）。 */
  from?: string | null;
  views: Partial<Record<PersonView, AssetImage>>;
  provider: string;
  model: string;
  /** 未知就是 null，不记 0。 */
  cost: CreativeCny | null;
};

export type PersonAsset = {
  id: string;
  entityId: string;
  selectedVersionId: string | null;
  /** 新的在前。 */
  versions: PersonAssetVersion[];
};

// ── 白模与镜头（MVP-3，契约 §13.3）──────────────
export type V3 = [number, number, number];

export type WhiteboxPrim = {
  id: string;
  kind: 'box' | 'cylinder' | 'prism';
  /** 底面中心（米）：y 通常是 0；box 的 s 是长宽高，cylinder/prism 的 s 是 [半径, 高, 0]。 */
  c: V3;
  s: V3;
  sides?: number;
  rotY?: number;
  label?: string;
  entityId?: string | null;
  /** 材质（前端按它上色；没有就按名字猜）。 */
  material?: 'plaster' | 'wood' | 'stone' | 'tile' | 'water' | 'plant' | 'cloth' | 'brick' | null;
  color?: string | null;
  /** 本来就在房间外面（门外街面这类），不按轮廓校验。 */
  outside?: boolean;
};

export type Whitebox = { placeId: string; version: number; prims: WhiteboxPrim[]; updatedAt: string };

export type Shot = {
  id: string;
  n: number;
  workId: string;
  sceneId: string;
  para?: number | null;
  durationSec: number;
  placeId: string;
  whiteboxVersion: number;
  cast: {
    entityId: string;
    assetVersionId: string | null;
    at: V3;
    facing: number;
    pose: 'stand' | 'sit' | 'walk';
    to?: V3 | null;
  }[];
  camera: { eye: V3; target: V3; fov: number; end?: { eye: V3; target: V3 } | null };
  action: string;
  dialogue?: string | null;
  light?: string | null;
  /** 出这条镜头时那一场的第 para 段原文（正文改过就标旧）。 */
  basisText?: string | null;
  /** 预演片段（前端录，后端只存）：预览 id、视频地址、首帧地址。 */
  preview?: { previewId: string; url: string; posterUrl: string | null; at: CreativeIso; mime: string } | null;
  /** 依据旧了：白模/立绘出新版、正文改过。 */
  stale?: string[];
};

export type ShotTake = {
  id: string;
  shotId: string;
  n: number;
  createdAt: string;
  state: 'queued' | 'generating' | 'unsaved' | 'saved' | 'failed';
  url?: string | null;
  posterUrl?: string | null;
  durationSec: number;
  resolution: '480p' | '720p';
  basis: {
    shotHash: string;
    whiteboxVersion: number;
    refImages: { assetVersionId: string; view: PersonView }[];
    previewId: string | null;
    mode: 'reference_video' | 'reference_image_only';
    prompt: string;
  };
  provider: string;
  model: string;
  taskId?: string | null;
  failure?: string | null;
  cost: CreativeCny | null;
};

export type SceneCut = {
  workId: string;
  sceneId: string;
  shots: { shotId: string; takeId: string | null }[];
  file?: { state: 'building' | 'saved' | 'failed'; url?: string | null; durationSec?: number; failure?: string | null } | null;
};

// ── 快照 ──────────────────────────────────────────
export type WorldSnapshot = {
  world: World;
  entities: Entity[];
  relations: Relation[];
  events: WorldEvent[];
  modes: TransportMode[];
  rules: WorldRule[];
  edits: MapEdit[];
  legs: CreativeRouteLeg[];
  /** 只含 pending / deferred。 */
  proposals: Proposal[];
  check: CheckRun | null;
  versions: WorldVersion[];
  /** 事件流 seq。 */
  cursor: number;
};

// ── 事件流 ────────────────────────────────────────
export type CreativeEvent = { seq: number; at: CreativeIso; dossierId: string; type: string; data: unknown };
