// 现场记录：先进本地队列（IndexedDB），能连上 ReinLab 时按批上传（10-explore-v2-contract.md 第 2.2 节）。
// 记录独立于计划修订；服务器确认后才标已同步；同一条重复上传只存一份；更正一律追加新记录。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FieldEvent } from '../../../../../../packages/contracts/src/explore';
import type { ExploreAdapter } from '../adapter';
import { db, type QueuedEvent } from '../offline/db';

const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const nowIso = () => {
  const d = new Date(), off = -d.getTimezoneOffset(), sign = off >= 0 ? '+' : '-', p = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(off / 60)}:${p(off % 60)}`;
};

export function useFieldLog({ adapter, accountId, dossierId, planRevision, reachable }: {
  adapter: ExploreAdapter | null; accountId: string; dossierId: string; planRevision: number; reachable: boolean;
}) {
  const [items, setItems] = useState<QueuedEvent[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const reload = useCallback(async () => setItems(await db.queueFor(dossierId)), [dossierId]);
  useEffect(() => { void reload(); }, [reload]);

  const add = useCallback(async (e: Omit<FieldEvent, 'clientId' | 'planRevision' | 'at' | 'tz'>) => {
    const event: FieldEvent = { ...e, clientId: crypto.randomUUID(), planRevision, at: nowIso(), tz: tz() };
    await db.enqueue({ clientId: event.clientId, accountId, dossierId, event, state: 'pending', updatedAt: new Date().toISOString() });
    await reload();
    return event;
  }, [accountId, dossierId, planRevision, reload]);

  /** 能连上就同步：成功的标 synced；点被删的标 attention（可重新关联）；冲突的保留两份等用户选。 */
  const sync = useCallback(async () => {
    if (!adapter || busy.current) return null;
    const pending = (await db.queueFor(dossierId)).filter(q => q.state === 'pending');
    if (!pending.length) return null;
    busy.current = true; setSyncing(true); setError(null);
    try {
      const r = await adapter.postFieldEvents(pending.map(q => q.event));
      for (const res of r.results) {
        const q = pending.find(p => p.clientId === res.clientId); if (!q) continue;
        q.state = res.status === 'ok' || res.status === 'duplicate' ? 'synced' : 'attention';
        q.server = res.server;
        q.note = res.status === 'orphan' ? '原来的点已不在当前计划里，请重新关联' : res.status === 'conflict' ? '服务端也改过这条，请选保留哪一份' : undefined;
        q.updatedAt = new Date().toISOString();
        await db.enqueue(q);
      }
      await reload();
      return r.planRevision;     // 调用方据此拉最新计划；旧离线快照不覆盖服务端
    } catch (e) { setError(e instanceof Error ? e.message : '同步没完成'); return null; }
    finally { busy.current = false; setSyncing(false); }
  }, [adapter, dossierId, reload]);

  // 能连上时自动同步；页面重新打开时也试一次
  useEffect(() => { if (reachable) void sync(); }, [reachable, items.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const pending = items.filter(q => q.state === 'pending').length, attention = items.filter(q => q.state === 'attention');
  return { items, add, sync, syncing, error, pending, attention };
}
