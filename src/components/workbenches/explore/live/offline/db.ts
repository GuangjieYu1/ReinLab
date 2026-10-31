// 探索台离线数据（IndexedDB）：离线包、计划快照、待同步现场记录、锁定标记。
// 资源文件（瓦片、字形、缩略图、页面）放 Cache Storage；这里只放业务数据（design/prd/10-explore-v2-contract.md 第 2.1、2.2 节）。
import type { FieldEvent, OfflineManifest } from '../../../../../../packages/contracts/src/explore';
import type { ExploreSnapshot } from '../adapter';

const DB = 'reinlab-explore-offline', VERSION = 1;

export type PackRecord = {
  packId: string; accountId: string; dossierId: string; title: string; day: string; planRevision: number;
  manifest: OfflineManifest; preparedAt: string;
  state: 'preparing' | 'ready' | 'incomplete';
  done: string[];                 // 已写入缓存的资源地址
  missing: string[];              // 检查时发现缺的
};
export type SnapshotRecord = { key: string; dossierId: string; revision: number; snap: ExploreSnapshot; light: unknown; weather: unknown; savedAt: string };
export type QueuedEvent = { clientId: string; accountId: string; dossierId: string; event: FieldEvent;
  state: 'pending' | 'synced' | 'attention'; server?: unknown; note?: string; updatedAt: string };

let opening: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('packs', { keyPath: 'packId' }).createIndex('dossier', 'dossierId');
      db.createObjectStore('snapshots', { keyPath: 'key' });
      db.createObjectStore('queue', { keyPath: 'clientId' }).createIndex('dossier', 'dossierId');
      db.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { opening = null; reject(req.error); };
  });
  return opening;
}
const done = <T>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
async function store(name: string, mode: IDBTransactionMode = 'readonly') { return (await open()).transaction(name, mode).objectStore(name); }

export const db = {
  async putPack(p: PackRecord) { await done((await store('packs', 'readwrite')).put(p)); },
  async getPack(id: string) { return (await done((await store('packs')).get(id))) as PackRecord | undefined; },
  async packsFor(dossierId: string) { return (await done((await store('packs')).index('dossier').getAll(dossierId))) as PackRecord[]; },
  async allPacks() { return (await done((await store('packs')).getAll())) as PackRecord[]; },
  async deletePack(id: string) { await done((await store('packs', 'readwrite')).delete(id)); },

  async putSnapshot(s: SnapshotRecord) { await done((await store('snapshots', 'readwrite')).put(s)); },
  async getSnapshot(dossierId: string, revision: number) { return (await done((await store('snapshots')).get(`${dossierId}:${revision}`))) as SnapshotRecord | undefined; },

  async enqueue(e: QueuedEvent) { await done((await store('queue', 'readwrite')).put(e)); },
  async queueFor(dossierId: string) { return ((await done((await store('queue')).index('dossier').getAll(dossierId))) as QueuedEvent[]).sort((a, b) => a.event.at.localeCompare(b.event.at)); },
  async pendingCount(dossierId: string) { return (await db.queueFor(dossierId)).filter(q => q.state !== 'synced').length; },

  /** 锁定标记：锁定后不能进离线现场（不缓存 Cookie，靠这个遮蔽离线内容）；正常登录后清掉。 */
  async setLocked(v: boolean) { await done((await store('meta', 'readwrite')).put(v, 'locked')); },
  async isLocked() { return Boolean(await done((await store('meta')).get('locked'))); },
  async setLastAccount(id: string) { await done((await store('meta', 'readwrite')).put(id, 'account')); },
  async lastAccount() { return (await done((await store('meta')).get('account'))) as string | undefined; },
};

/** 每个离线包一个 Cache Storage 分区；删包时整个分区一起删。 */
export const cacheName = (packId: string) => `reinlab-pack-${packId}`;
