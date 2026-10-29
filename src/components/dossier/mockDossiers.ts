// 示例档案：每个台用原来入口上的 4 份 File 作种子，所以 mock 模式下看起来和以前一样。
// 增删改都在内存里，用来走通界面和交互；不连后端。
import { entryWorkbenches } from '../cinematic/entryWorkbenches';
import { fileBriefs } from '../entry/fileBriefs';
import type { Artifact, BenchId, Confirmation, Dossier, DossierSummary, ResumePoint, StreamEvent } from './adapter';
import { DossierError, type DossierAdapter } from './adapter';

const now = () => new Date().toISOString();
const KIND = (bench: BenchId) => (bench === 'research' ? 'topic' : bench === 'curriculum' ? 'learning' : 'workspace') as Dossier['kind'];

type Row = Dossier & { position: ResumePoint | null; arts: Artifact[] };

function seed(): Map<string, Row> {
  const rows = new Map<string, Row>();
  entryWorkbenches.forEach(w => w.files.forEach((title, i) => {
    const b = fileBriefs[w.id]?.[i];
    const id = `mock-${w.id}-${i}`;
    const t = new Date(Date.now() - (i + 1) * 36e5 * (i + 1)).toISOString();
    rows.set(id, {
      id, bench: w.id as BenchId, kind: KIND(w.id as BenchId), title, nameSource: 'user', intent: b?.desc ?? null,
      lifecycle: 'active', deletion: 'none', createdAt: t, updatedAt: t, lastActivityAt: t,
      progress: b?.last.label ?? null, work: { state: 'idle' }, pending: 0,
      artifacts: { total: 0, byKind: {} }, version: 1, resume: null, runs: [], position: null, arts: [],
    });
  }));
  return rows;
}

export function mockDossierAdapter(): DossierAdapter {
  const rows = seed();
  const subs = new Set<(e: StreamEvent) => void>();
  const pendingConfirm = new Map<string, Confirmation>();
  const lastOpened = new Map<BenchId, string>();
  const emit = (e: StreamEvent) => subs.forEach(f => f(e));
  const summary = (r: Row): DossierSummary => { const { position: _p, arts: _a, resume: _r, runs: _u, ...s } = r; return s; };
  const live = (id: string) => {
    const r = rows.get(id);
    if (!r) throw new DossierError('DOSSIER_NOT_FOUND', '找不到这份档案');
    if (r.deletion === 'deleted') throw new DossierError('DOSSIER_DELETED', `这份档案已删除`, { id, kind: 'dossier', state: 'deleted', title: r.title, at: r.updatedAt });
    return r;
  };
  const touch = (r: Row, activity = true) => { r.version += 1; r.updatedAt = now(); if (activity) r.lastActivityAt = r.updatedAt; emit({ type: 'dossier.changed', id: r.id, version: r.version, change: 'rename' }); };
  const detail = (r: Row): Dossier => ({ ...summary(r), resume: r.position, runs: r.runs });

  return {
    kind: 'mock',
    async list(bench, opts = {}) {
      const q = opts.q?.trim().toLowerCase();
      return [...rows.values()]
        .filter(r => r.bench === bench && r.deletion !== 'deleted' && (opts.view === 'archived' ? r.lifecycle === 'archived' : r.lifecycle !== 'archived'))
        .filter(r => !q || `${r.title} ${r.intent ?? ''}`.toLowerCase().includes(q))
        .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
        .map(summary);
    },
    async get(id) { return detail(live(id)); },
    async open(id) { const r = live(id); lastOpened.set(r.bench, id); return detail(r); },
    async resume(bench) { const id = lastOpened.get(bench); const r = id ? rows.get(id) : undefined; return r && r.deletion === 'none' && r.lifecycle !== 'archived' ? detail(r) : null; },
    async savePosition(id, p) { const r = rows.get(id); if (r) r.position = p; },
    async create({ bench, kind, title, intent }) {
      const id = `mock-${bench}-${Date.now()}`, t = now();
      const d = new Date();
      const r: Row = {
        id, bench, kind: kind ?? KIND(bench), title: title?.trim() || `未命名${bench === 'research' ? '研究' : '档案'} · ${d.getMonth() + 1}月${d.getDate()}日`,
        nameSource: title?.trim() ? 'user' : 'placeholder', intent: intent?.trim() || null, lifecycle: 'active', deletion: 'none',
        createdAt: t, updatedAt: t, lastActivityAt: t, progress: null, work: { state: 'idle' }, pending: 0, artifacts: { total: 0, byKind: {} }, version: 1, resume: null, runs: [], position: null, arts: [],
      };
      rows.set(id, r); emit({ type: 'dossier.changed', id, version: 1, change: 'create' });
      return detail(r);
    },
    async update(id, patch) {
      const r = live(id);
      if (patch.baseVersion !== r.version) throw new DossierError('VERSION_CONFLICT', '别处刚改过这份档案', detail(r));
      if (patch.title !== undefined) { r.title = patch.title.trim() || r.title; r.nameSource = 'user'; }
      if (patch.intent !== undefined) r.intent = patch.intent.trim() || null;
      if (patch.lifecycle) r.lifecycle = patch.lifecycle;
      touch(r); return detail(r);
    },
    async archive(id) { const r = live(id); r.lifecycle = 'archived'; touch(r, false); return { done: detail(r) }; },
    async unarchive(id) { const r = live(id); r.lifecycle = 'active'; touch(r, false); return detail(r); },
    async remove(id) {
      const r = live(id);
      const existing = [...pendingConfirm.values()].find(c => c.target.id === id && c.state === 'pending');
      if (existing) return { confirmation: existing };
      const c: Confirmation = {
        id: `confirm-${Date.now()}`, kind: 'dossier.delete', target: { id, title: r.title, bench: r.bench },
        impact: { activeRuns: 0, pendingRequests: r.pending, artifacts: r.arts.length, note: '删除后列表、搜索和续上次都看不到这份档案；原始文件和外部课程不会被删除。不是永久擦除。' },
        state: 'pending',
      };
      pendingConfirm.set(c.id, c); emit({ type: 'confirmation.created', confirmation: c });
      return { confirmation: c };
    },
    async decide(cid, approve) {
      const c = pendingConfirm.get(cid); if (!c || c.state !== 'pending') throw new DossierError('CONFIRMATION_PENDING', '这张确认已经处理过了');
      c.state = approve ? 'approved' : 'rejected'; emit({ type: 'confirmation.decided', confirmation: c });
      if (approve) { const r = rows.get(c.target.id)!; r.deletion = 'deleted'; r.updatedAt = now(); emit({ type: 'dossier.deleted', id: r.id, tombstone: { id: r.id, kind: 'dossier', state: 'deleted', title: r.title, at: r.updatedAt } }); }
    },
    async artifacts(id) { return live(id).arts; },
    async courses() { return []; },
    async attachCourse() { throw new DossierError('COURSE_UNAVAILABLE', '示例模式下没有真实课程'); },
    async detach(id, artifactId) { const r = live(id); r.arts = r.arts.filter(a => a.id !== artifactId); touch(r); },
    subscribe(_bench, on) { subs.add(on); return () => { subs.delete(on); }; },
  };
}
