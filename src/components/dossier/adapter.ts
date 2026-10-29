// 档案数据适配器：界面只通过它取数。mock = 本地示例；live = /v1/dossiers（design/prd/03-dossier-contract.md）。
import type { Artifact, BenchId, Confirmation, Dossier, DossierKind, DossierSummary, Lifecycle, ResumePoint, StreamEvent } from '../../../packages/contracts/src/dossier';

export type { Artifact, BenchId, Confirmation, Dossier, DossierSummary, ResumePoint, StreamEvent };

/** 删除 / 归档活跃档案时返回确认卡；其余直接生效。 */
export type MaybeConfirm<T> = { done: T } | { confirmation: Confirmation };

export class DossierError extends Error {
  constructor(public code: string, message: string, public detail?: unknown) { super(message); }
}

export interface DossierAdapter {
  readonly kind: 'mock' | 'live';
  /** via='user'：用户主动打开 Files / 点搜索（服务端记一条轻量操作）；后台刷新不传。 */
  list(bench: BenchId, opts?: { q?: string; view?: 'active' | 'archived'; via?: 'user' }): Promise<DossierSummary[]>;
  get(id: string): Promise<Dossier>;
  open(id: string): Promise<Dossier>;
  resume(bench: BenchId): Promise<Dossier | null>;
  savePosition(id: string, p: ResumePoint): Promise<void>;
  create(input: { bench: BenchId; kind?: DossierKind; title?: string; intent?: string }): Promise<Dossier>;
  update(id: string, patch: { baseVersion: number; title?: string; intent?: string; lifecycle?: Exclude<Lifecycle, 'archived'> }): Promise<Dossier>;
  archive(id: string): Promise<MaybeConfirm<Dossier>>;
  unarchive(id: string): Promise<Dossier>;
  remove(id: string): Promise<{ confirmation: Confirmation }>;
  decide(confirmationId: string, approve: boolean): Promise<void>;
  artifacts(id: string): Promise<Artifact[]>;
  courses(q?: string): Promise<{ courseId: string; title: string; source: string; sceneCount: number; progress: number | null }[]>;
  attachCourse(id: string, courseId: string): Promise<Artifact>;
  detach(id: string, artifactId: string): Promise<void>;
  /** 变化通知（SSE）；返回取消函数。 */
  subscribe(bench: BenchId, on: (e: StreamEvent) => void): () => void;
}
