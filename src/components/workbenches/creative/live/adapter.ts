// 创作台真实模式的数据边界（design/prd/20-creative-contract.md §2、22-creative-1a-frontend-brief.md）。
// 页面只认这个接口；冲突、路程、故事时间换算都由服务端算，前端不推断。
import type { CheckRun, CreativeAppliedOp, CreativeOp, CreativeRouteLeg, GenerateJob, GeoJSON, ImpactReport, ImportJob, ItemChange, NetworkStatus, Proposal, TextEdit, Track, Work, WorkOp, WorldSnapshot, WorldVersion, BoardFocus, RefEvent, ProposalPreview, PersonAsset, PersonAssetVersion, PersonView, Whitebox, Shot, SceneCut, ShotTake } from '../../../../../packages/contracts/src/creative';
import type { MapConfig } from '../../explore/live/adapter';

/** edits/geojson 返回的要素集合（geometry 可能为 null：目标对不上，待确认）。 */
export type EditFeatures = { type: 'FeatureCollection'; features: { type: 'Feature'; geometry: GeoJSON.Geometry | null; properties: Record<string, any> }[] };
export type OpsResult = { revision: number; applied: CreativeAppliedOp[]; check: CheckRun };
export type NetworkImport = { source: 'osm'; bbox: [number, number, number, number] } | { source: 'azgaar'; assetId: string };

/** 服务端推来的创作台事件（契约 §3）。 */
export type CreativeStreamEvent =
  | { seq: number; type: 'creative.work'; data: { workId: string; revision: number } }
  | { seq: number; type: 'creative.text'; data: { workId: string; sceneId: string } }
  | { seq: number; type: 'creative.import'; data: ImportJob }
  | { seq: number; type: 'creative.generate'; data: GenerateJob }
  | { seq: number; type: 'creative.op'; data: { revision: number; applied: CreativeAppliedOp[] } }
  | { seq: number; type: 'creative.check'; data: CheckRun }
  | { seq: number; type: 'creative.proposal'; data: unknown }
  | { seq: number; type: 'creative.leg'; data: CreativeRouteLeg }
  | { seq: number; type: 'creative.network'; data: NetworkStatus }
  | { seq: number; type: 'creative.version'; data: WorldVersion }
  | { seq: number; type: 'creative.impact'; data: ImpactReport['maybeScan'] }
  | { seq: number; type: 'creative.focus'; data: BoardFocus }
  | { seq: number; type: 'creative.ref'; data: RefEvent }
  | { seq: number; type: 'creative.whitebox'; data: Whitebox }
  | { seq: number; type: 'creative.take'; data: ShotTake }
  | { seq: number; type: 'creative.cut'; data: SceneCut }
  | { seq: number; type: 'creative.shot'; data: { workId: string; sceneId: string; shots: Shot[] } }
  | { seq: number; type: 'creative.asset'; data: { entityId: string; assetId: string; version: PersonAssetVersion } }
  | { seq: number; type: 'creative.usage'; data: { cost: { value: number | null; known: boolean } } };

export interface CreativeAdapter {
  kind: 'live';
  works(): Promise<Work[]>;
  work(id: string): Promise<Work>;
  createWork(title: string, targetWords?: number): Promise<Work>;
  workOps(id: string, baseRevision: number, ops: WorkOp[]): Promise<{ revision: number; work: Work }>;
  proposals(filters: Record<string, string>): Promise<{ proposals: Proposal[]; nextCursor: string | null }>;
  generate(id: string, req: { sceneIds: string[]; mode: TextEdit['mode']; hint?: string; range?: TextEdit['range'] }): Promise<GenerateJob>;
  generation(workId: string, jobId: string, stop?: boolean): Promise<GenerateJob>;
  importText(workId: string, text: string, title?: string): Promise<ImportJob>;
  /** 只分章、不落库：导入向导第二步给作者看分章结果。 */
  importPreview(workId: string, text: string): Promise<{ chapters: { index: number; title: string; chars: number; paragraphs: number; preview: string }[] }>;
  importJob(id: string, action?: 'pause' | 'resume'): Promise<ImportJob>;
  exportWork(id: string, format: 'md' | 'docx'): Promise<void>;
  startAssistant(query: string, mode: 'creative_advisor' | 'creative_writer' | 'creative_director', workId?: string, sceneId?: string, placeId?: string): Promise<{ id: string }>;
  /** 29：在已有会话里续一句（202）。 */
  sayAssistant(runId: string, query: string, about?: { proposalId: string }): Promise<{ id: string; state: string }>;
  /** 1D：提议采纳后看板的样子（只算不落库）。 */
  preview(proposalId: string, workId?: string | null): Promise<ProposalPreview>;
  /** 29：让模型判自然语言规则；结果并进 check（kind rule_model，黄色疑似）。 */
  judgeRules(): Promise<{ judged: number; skipped: number; cost: { value: number | null; known: boolean }; check: CheckRun }>;
  /** §14.8 素材浏览器：作者自己登录视频网站，下载器读专用配置。 */
  browserOpen(url: string): Promise<unknown>;
  browserSites(): Promise<{ sites: { domain: string; lastUsed?: string | null; lastUsedAt?: string | null }[] }>;
  browserClear(domain?: string): Promise<unknown>;
  /** MVP-3 白模、镜头、预演（契约 §13.4）。 */
  whitebox(placeId: string, version?: number): Promise<Whitebox>;
  shots(workId: string, sceneId: string): Promise<{ shots: Shot[]; cut: SceneCut; takes?: ShotTake[] }>;
  /** 3B 出片（契约 §13.4 / §13.9）。 */
  drawTake(shotId: string, req: { resolution?: '480p' | '720p'; durationSec?: number; draftTakeId?: string }): Promise<ShotTake>;
  retryTake(takeId: string): Promise<unknown>;
  selectTake(shotId: string, takeId: string | null): Promise<unknown>;
  cutScene(sceneId: string): Promise<SceneCut>;
  uploadPreview(shotId: string, video: Blob, poster: Blob | null): Promise<{ previewId: string; url: string; posterUrl: string | null }>;
  /** MVP-2 人物形象（契约 §12.3）。 */
  asset(entityId: string): Promise<PersonAsset>;
  drawAsset(entityId: string, req: { views?: PersonView[]; note?: string; from?: string }): Promise<{ asset: PersonAsset; version: PersonAssetVersion }>;
  assetVersion(entityId: string, versionId: string, action: 'retry' | 'stop'): Promise<unknown>;
  selectAsset(entityId: string, versionId: string | null): Promise<unknown>;
  runs(): Promise<{ runs: { id: string; mode?: string; state: string }[] }>;
  runEvents(id: string, after: number): Promise<{ events: { seq: number; action: string; payload: Record<string, any> }[]; hasMore?: boolean }>;
  runState(id: string): Promise<{ state: string }>;

  load(version?: number): Promise<WorldSnapshot>;
  ops(baseRevision: number, ops: CreativeOp[]): Promise<OpsResult>;
  tracks(from: number, to: number, entityIds?: string[]): Promise<{ tracks: Track[]; legs: CreativeRouteLeg[] }>;
  editsAt(t: number): Promise<EditFeatures>;
  /** 路网几何（只读），架空世界画路用。 */
  networkGeo(bbox?: [number, number, number, number]): Promise<unknown>;
  check(): Promise<CheckRun>;
  importNetwork(req: NetworkImport): Promise<{ jobId: string }>;
  uploadAsset(name: string, content: string): Promise<{ assetId: string }>;
  saveVersion(summary: string): Promise<WorldVersion>;
  /** 1C：版本差异、草稿差异、影响清单、扫正文、作品实际设定。 */
  version(n: number): Promise<WorldVersion>;
  draftDiff(): Promise<{ items: ItemChange[] }>;
  impact(from: number, to: number): Promise<ImpactReport>;
  impactScan(from: number, to: number): Promise<ImpactReport['maybeScan']>;
  effective(workId: string): Promise<WorldSnapshot>;
  mapConfig(): Promise<MapConfig>;
  /** 从 after 起订阅；seq 跳号或断线由页面重取快照兜底。 */
  subscribe(after: number, on: (e: CreativeStreamEvent) => void, onGap: () => void): () => void;
}

/** 带 code 的错误：页面按 code 分支（REVISION_STALE、TIME_UNPARSED、IN_USE……）。 */
export class CreativeError extends Error {
  constructor(message: string, readonly code: string, readonly detail?: any) { super(message); }
}
