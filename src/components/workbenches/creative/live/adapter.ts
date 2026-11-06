// 创作台真实模式的数据边界（design/prd/20-creative-contract.md §2、22-creative-1a-frontend-brief.md）。
// 页面只认这个接口；冲突、路程、故事时间换算都由服务端算，前端不推断。
import type {
  CheckRun, CreativeAppliedOp, CreativeOp, CreativeRouteLeg, GeoJSON, NetworkStatus, Track, WorldSnapshot, WorldVersion,
} from '../../../../../packages/contracts/src/creative';
import type { MapConfig } from '../../explore/live/adapter';

/** edits/geojson 返回的要素集合（geometry 可能为 null：目标对不上，待确认）。 */
export type EditFeatures = { type: 'FeatureCollection'; features: { type: 'Feature'; geometry: GeoJSON.Geometry | null; properties: Record<string, any> }[] };
export type OpsResult = { revision: number; applied: CreativeAppliedOp[]; check: CheckRun };
export type NetworkImport = { source: 'osm'; bbox: [number, number, number, number] } | { source: 'azgaar'; assetId: string };

/** 服务端推来的创作台事件（契约 §3）。 */
export type CreativeStreamEvent =
  | { seq: number; type: 'creative.op'; data: { revision: number; applied: CreativeAppliedOp[] } }
  | { seq: number; type: 'creative.check'; data: CheckRun }
  | { seq: number; type: 'creative.proposal'; data: unknown }
  | { seq: number; type: 'creative.leg'; data: CreativeRouteLeg }
  | { seq: number; type: 'creative.network'; data: NetworkStatus }
  | { seq: number; type: 'creative.usage'; data: { cost: { value: number | null; known: boolean } } };

export interface CreativeAdapter {
  kind: 'live';
  load(version?: number): Promise<WorldSnapshot>;
  ops(baseRevision: number, ops: CreativeOp[]): Promise<OpsResult>;
  tracks(from: number, to: number, entityIds?: string[]): Promise<{ tracks: Track[]; legs: CreativeRouteLeg[] }>;
  editsAt(t: number): Promise<EditFeatures>;
  check(): Promise<CheckRun>;
  importNetwork(req: NetworkImport): Promise<{ jobId: string }>;
  uploadAsset(name: string, content: string): Promise<{ assetId: string }>;
  saveVersion(summary: string): Promise<WorldVersion>;
  mapConfig(): Promise<MapConfig>;
  /** 从 after 起订阅；seq 跳号或断线由页面重取快照兜底。 */
  subscribe(after: number, on: (e: CreativeStreamEvent) => void, onGap: () => void): () => void;
}

/** 带 code 的错误：页面按 code 分支（REVISION_STALE、TIME_UNPARSED、IN_USE……）。 */
export class CreativeError extends Error {
  constructor(message: string, readonly code: string, readonly detail?: any) { super(message); }
}
