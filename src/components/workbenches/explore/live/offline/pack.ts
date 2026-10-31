// 离线包：按服务端清单把资源写进 Cache Storage、业务数据写进 IndexedDB（10-explore-v2-contract.md 第 2.1 节）。
// 规则：清单里每一项都存好才算"可离线使用"；中断后按清单续下；有未同步的现场记录时不许删包。
import type { OfflineManifest } from '../../../../../../packages/contracts/src/explore';
import type { ExploreAdapter, ExploreSnapshot } from '../adapter';
import { cacheName, db, type PackRecord } from './db';

const viaBackend = (u: string) => (u.startsWith('/v1/') ? '/backend' + u : u);

export type PackProgress = { total: number; done: number; failed: string[]; phase: 'manifest' | 'download' | 'verify' | 'ready' | 'incomplete' };

/** 清单里所有要缓存的资源地址（去重）。 */
export function packUrls(m: OfflineManifest): string[] {
  const urls = [
    ...m.tiles.map(t => t.url), ...m.glyphs.map(g => g.url), ...m.scenes.map(s => s.url),
    ...m.refs.map(r => r.thumb), m.plan, m.light, m.weather,
  ];
  return [...new Set(urls.filter(Boolean).map(viaBackend))];
}

/** 准备或续下一个离线包。超限（withinLimit=false）时不下载，交给页面让用户选。 */
export async function preparePack(opts: {
  adapter: ExploreAdapter; accountId: string; dossierId: string; title: string; day: string;
  manifest?: OfflineManifest; detail?: 'low'; onProgress: (p: PackProgress) => void; signal?: AbortSignal;
}): Promise<PackRecord | { overLimit: OfflineManifest }> {
  const { adapter, onProgress } = opts;
  onProgress({ total: 0, done: 0, failed: [], phase: 'manifest' });
  const m = opts.manifest ?? await adapter.offlinePack(opts.day, opts.detail);
  if (!m.limit.withinLimit) return { overLimit: m };

  const prev = await db.getPack(m.packId);
  const rec: PackRecord = prev ?? {
    packId: m.packId, accountId: opts.accountId, dossierId: opts.dossierId, title: opts.title, day: m.day,
    planRevision: m.planRevision, manifest: m, preparedAt: new Date().toISOString(), state: 'preparing', done: [], missing: [],
  };
  rec.state = 'preparing';
  await db.putPack(rec);
  try { await navigator.storage?.persist?.(); } catch { /* 不承诺浏览器永不清理 */ }

  const cache = await caches.open(cacheName(m.packId));
  const urls = packUrls(m), todo = urls.filter(u => !rec.done.includes(u)), failed: string[] = [];
  let i = 0;
  const report = () => onProgress({ total: urls.length, done: rec.done.length, failed: [...failed], phase: 'download' });
  report();
  const worker = async () => {
    while (i < todo.length && !opts.signal?.aborted) {
      const u = todo[i++];
      try {
        const r = await fetch(u, { credentials: 'same-origin', signal: opts.signal });
        if (!r.ok) throw Error(String(r.status));
        await cache.put(u, r);
        rec.done.push(u);
      } catch { failed.push(u); }
      if (rec.done.length % 20 === 0) await db.putPack(rec);
      report();
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);   // 并发 4（OpenFreeMap 约束）

  // 业务数据：计划快照、光线、天气进 IndexedDB（离线时页面从这里读）
  onProgress({ total: urls.length, done: rec.done.length, failed: [...failed], phase: 'verify' });
  try {
    const json = async (u: string) => (await (await cache.match(viaBackend(u)))?.json()) ?? null;
    const snap = await json(m.plan) as ExploreSnapshot | null;
    if (snap) await db.putSnapshot({ key: `${opts.dossierId}:${m.planRevision}`, dossierId: opts.dossierId, revision: m.planRevision, snap, light: await json(m.light), weather: await json(m.weather), savedAt: new Date().toISOString() });
  } catch { failed.push('plan'); }

  rec.missing = await missingIn(rec);
  rec.state = rec.missing.length === 0 && failed.length === 0 ? 'ready' : 'incomplete';
  await db.putPack(rec);
  onProgress({ total: urls.length, done: rec.done.length, failed: rec.missing, phase: rec.state === 'ready' ? 'ready' : 'incomplete' });
  await db.setLastAccount(opts.accountId);
  return rec;
}

/** 逐项核对缓存；浏览器可能清理过。 */
export async function missingIn(rec: PackRecord): Promise<string[]> {
  const cache = await caches.open(cacheName(rec.packId));
  const out: string[] = [];
  for (const u of packUrls(rec.manifest)) if (!(await cache.match(u))) out.push(u);
  if (!(await db.getSnapshot(rec.dossierId, rec.planRevision))) out.push('计划快照');
  return out;
}

export async function checkPack(packId: string) {
  const rec = await db.getPack(packId); if (!rec) return null;
  rec.missing = await missingIn(rec);
  rec.state = rec.missing.length ? 'incomplete' : 'ready';
  await db.putPack(rec);
  return rec;
}

/** 删包：有未同步的现场记录时拒绝（记录不随包静默删除）。 */
export async function deletePack(packId: string): Promise<{ ok: true } | { ok: false; pending: number }> {
  const rec = await db.getPack(packId); if (!rec) return { ok: true };
  const pending = await db.pendingCount(rec.dossierId);
  if (pending) return { ok: false, pending };
  await caches.delete(cacheName(packId));
  await db.deletePack(packId);
  return { ok: true };
}

/** 离线地图源：用清单的瓦片 / 字形模板替换在线源。 */
export const offlineMapConfig = (m: OfflineManifest) => ({
  tiles: [viaBackend(m.tileTemplate)], minzoom: m.tileZoom.min, maxzoom: m.tileZoom.max, glyphs: viaBackend(m.glyphTemplate),
});
