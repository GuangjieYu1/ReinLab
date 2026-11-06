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
  timeSpan: { from: StoryTime; to: StoryTime } | null;
  calendars: Calendar[];
  network: NetworkStatus;
};

// ── 实体 ──────────────────────────────────────────
export type EntityKind = 'person' | 'place' | 'item' | 'org';
export type PlaceLevel = 'world' | 'region' | 'city' | 'building' | 'floor' | 'room' | 'site';

export type Entity = {
  id: string;
  kind: EntityKind;
  name: string;
  aliases: string[];
  summary?: string;
  origin: CreativeProvenance;
  status: Decision;
  place?: {
    level: PlaceLevel;
    parentId: string | null;
    geo: GeoJSON.Geometry | null;
    geoCertainty: 'exact' | 'area' | 'unlocated';
    connects: { to: string; passable: boolean; note?: string }[];
    osm?: { type: 'node' | 'way' | 'relation'; id: number; version?: number } | null;
  };
  /** 出生、死亡也是事件：这里存事件 id。 */
  person?: { born?: string | null; died?: string | null };
  workRefs: { workId: string; chapterId?: string }[];
};

export type Relation = {
  id: string;
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
  title: string;
  what: string;
  kind: 'stay' | 'travel' | 'interaction' | 'birth' | 'death' | 'other';
  /**
   * 导入来的事件还不知道实体 id（那些实体也在待确认里）：这时 `entityId` 留空，
   * 用 `entityName` 按名字/别名解析（服务端在应用操作时解析，解析不到就整批拒绝）。
   */
  participants: { entityId: string; entityName?: string; as: Participation }[];
  placeId: string | null;
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
  name: string;
  kmPerHour: number;
  network: 'road' | 'water' | 'any' | 'none';
  note?: string;
};

export type WorldRule = {
  id: string;
  text: string;
  /** null = 程序还判不了 → 检查里显示「未覆盖」。 */
  machine: { kind: 'teleport' | 'remote_presence' | 'resurrection' | 'custom'; params: Record<string, unknown> } | null;
  origin: CreativeProvenance;
  status: Decision;
};

// ── 改造层 ────────────────────────────────────────
export type MapEdit = {
  id: string;
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
export type ConflictKind = 'double_location' | 'travel_time' | 'dead_appearance' | 'presence' | 'place_hierarchy';

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
    | 'text_edit';
  title: string;
  summary: string;
  /**
   * 接受后要执行的操作。`kind:'text_edit'` 的提议把 `TextEdit` 放在 `ops[0]`
   * （契约 §5.1，多带一个 `op:'text.set'` 标记），由作品的 `text.accept` 落实，
   * 世界观账本不执行它。
   */
  ops: CreativeOp[];
  origin: CreativeProvenance;
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
export type WorldVersion = { n: number; at: CreativeIso; summary: string; changes: number };

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
  | { op: 'world.set'; patch: Partial<Pick<World, 'title' | 'basemap'>> }
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
  kind: 'entity' | 'event' | 'conflict' | 'stale_source';
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
  | { op: 'text.accept'; proposalId: string; text?: string };

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
