// 探索台真实模式的数据边界（design/prd/07-explore-contract.md）。页面只认这个接口：
// live 接控制面，memory 是本地内存版（没有后端时看界面用，不调模型）。
import type {
  AppliedOp, Basemap, CanvasObject, ExplorePlan, LngLat, Op, PendingChange, PlanUsage, Profile,
  RefImage, Source, Viewport, WeatherSuggestion, WeatherView,
} from '../../../../../packages/contracts/src/explore';

export type ExploreSnapshot = {
  plan: ExplorePlan; canvas: CanvasObject[]; refs: RefImage[];
  lastViewport: Viewport | null; basemap: Basemap;
};
export type OpsResult = { revision: number; applied: AppliedOp[]; pending: PendingChange | null };
export type Place = { name: string; address?: string; at: LngLat; source: Source };
export type MapConfig = {
  vector: { tilejson: string; glyphs: string; attribution: string };   // OpenMapTiles 结构的矢量源；样式由前端画
  satellite: { tilejson: string; attribution: string } | null;
  contours: { tilejson: string } | null;
  publicKey: string | null;
  basemaps?: { vector: boolean; satellite: boolean; contours: boolean };
  outOfScope?: string[];                                      // 第一版不做的（卫星、等高线）：页面直接不显示
};

/** 服务端推来的探索事件（契约第 4 节）。 */
export type ExploreEvent =
  | { type: 'explore.op'; dossierId: string; revision: number; applied: AppliedOp[] }
  | { type: 'explore.camera'; dossierId: string; runId: string; viewport: Viewport; basemap?: Basemap }
  | { type: 'explore.weather'; dossierId: string; checkedAt: string; state: WeatherView['state']; suggestionId?: string }
  | { type: 'explore.book'; dossierId: string; jobId: string; state: 'done' | 'failed'; artifactId?: string; message?: string }
  | { type: 'explore.snapshots_needed'; dossierId: string; revision: number; keys: string[] };

/** 右侧对话里的一条。卡片按 id 引用计划里的对象，不在消息里复制一份。 */
export type ChatItem =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'agent'; text: string }
  | { id: string; kind: 'tool'; name: string; label: string; state: 'running' | 'done' | 'failed' }
  | { id: string; kind: 'stops'; stopIds: string[] }
  | { id: string; kind: 'pending'; change: PendingChange }
  | { id: string; kind: 'refs'; refIds: string[] }
  | { id: string; kind: 'note'; text: string }
  /** 模型这一轮吐了非法的工具参数，什么都没发生：显示一行提示 + 重试（重发同一句）。 */
  | { id: string; kind: 'malformed' };

export type ChatSession = {
  load(): Promise<void>;
  send(text: string, refIds?: string[]): Promise<void>;
  stop(): void;
};

export class ExploreError extends Error {
  constructor(message: string, readonly code: string, readonly detail?: unknown) { super(message); }
}

export interface ExploreAdapter {
  kind: 'live' | 'memory';
  load(): Promise<ExploreSnapshot>;
  /** 页面和 Agent 共用的修改入口。409 抛 ExploreError('REVISION_CONFLICT')。 */
  ops(baseRevision: number, ops: Op[]): Promise<OpsResult>;
  saveView(viewport: Viewport, basemap: Basemap): void;
  weather(stopId?: string): Promise<WeatherView>;
  suggestions(): Promise<WeatherSuggestion[]>;
  usage(): Promise<PlanUsage>;
  places(q: string, near?: LngLat): Promise<Place[]>;
  mapConfig(): Promise<MapConfig>;
  profiles(): Promise<Profile[]>;
  saveProfile(p: Omit<Profile, 'id' | 'revision'> & { id?: string; revision?: number }): Promise<Profile>;
  deleteProfile(id: string): Promise<void>;
  uploadRef(file: File, kind: RefImage['kind']): Promise<RefImage>;
  removeRef(id: string): Promise<void>;
  uploadSnapshot(key: string, revision: number, png: Blob, attribution: string): Promise<void>;
  /** 生成 PDF。缺快照抛 ExploreError('NEEDS_MAP_SNAPSHOTS', { keys })。 */
  book(variant: 'brief' | 'full', revision: number): Promise<{ jobId: string }>;
  timezone(): Promise<string | null>;
  setTimezone(tz: string): Promise<void>;
  decide(approvalId: string, approve: boolean): Promise<void>;
  subscribe(on: (e: ExploreEvent) => void): () => void;
  chat(on: (items: ChatItem[], busy: boolean) => void): ChatSession;
}
