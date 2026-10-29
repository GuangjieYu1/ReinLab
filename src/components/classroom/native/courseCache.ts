import type { RemoteCourse, RemoteMediaRef } from './courseApi';

/**
 * 课程与媒体资源的本地缓存（IndexedDB）。
 *
 * 为什么是 IndexedDB 而不是 localStorage：localStorage 只能存字符串，图片和
 * 视频要先转 base64，体积膨胀约 33%，而且它是同步 API——在 iPad 上写入几十
 * MB 会把主线程卡死。IndexedDB 可以直接存 Blob，写入是异步的。
 *
 * 这个文件只负责「存取」，不负责「决定下载什么」。配额判定、下载编排和界面
 * 状态都在 courseLibrary.ts 里，那些是纯逻辑，可以脱离浏览器测试。
 */

export const COURSE_DB_NAME = 'reinlab-courses-v1';
export const COURSE_DB_VERSION = 1;

/** 默认配额 1 GB：足够存十几门含视频的课程，又明显低于 iOS 给 WebView 的常见上限。 */
export const DEFAULT_QUOTA_BYTES = 1024 * 1024 * 1024;

export interface CachedCourse {
  id: string;
  name: string;
  description?: string;
  sceneCount: number;
  /** 下载时服务端的 updatedAt，用来判断线上是否已有更新版本。 */
  updatedAt: number;
  savedAt: number;
  course: RemoteCourse;
  media: RemoteMediaRef[];
  /** 该课已缓存的媒体字节数，避免每次都去聚合 media 表。 */
  mediaBytes: number;
  /** 未能下载的媒体数量；>0 时界面要说明「部分资源缺失」。 */
  failedMedia: number;
}

export interface CachedMedia {
  key: string;
  courseId: string;
  url: string;
  kind: string;
  blob: Blob;
  bytes: number;
}

export const MEDIA_STORE = 'media';
export const COURSE_STORE = 'courses';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * 缓存记录的校验。
 *
 * 读回来的东西来自上一次会话写下的数据，可能是旧版本写的，也可能被浏览器
 * 清理到一半。校验失败时调用方会把这条记录当作「没下载过」，这比让一个缺字段
 * 的对象流进渲染层安全得多。
 */
export function isCachedCourse(value: unknown): value is CachedCourse {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string' || value.id.length === 0) return false;
  if (typeof value.name !== 'string') return false;
  if (!isFiniteNumber(value.sceneCount) || !isFiniteNumber(value.updatedAt) || !isFiniteNumber(value.savedAt)) return false;
  if (!isFiniteNumber(value.mediaBytes) || !isFiniteNumber(value.failedMedia)) return false;
  if (!Array.isArray(value.media)) return false;
  const course = value.course;
  return isRecord(course) && typeof course.id === 'string' && Array.isArray(course.scenes);
}

/** IndexedDB 是否可用。SSR、隐私模式与部分嵌入式 WebView 里它会是 undefined。 */
export function isCacheAvailable(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!isCacheAvailable()) return Promise.reject(new Error('IndexedDB 不可用'));
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(COURSE_DB_NAME, COURSE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(COURSE_STORE)) db.createObjectStore(COURSE_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(MEDIA_STORE)) {
        const store = db.createObjectStore(MEDIA_STORE, { keyPath: 'key' });
        // 按课程删除媒体时要能一次找齐，避免全表扫描。
        store.createIndex('courseId', 'courseId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('无法打开课程缓存'));
    // 另一个标签页持有旧版本连接时会一直阻塞，明确失败好过静默挂起。
    request.onblocked = () => reject(new Error('课程缓存被其他页面占用'));
  });
  // 打开失败后不要缓存这个被拒绝的 Promise，否则之后永远无法恢复。
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('课程缓存操作失败'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('课程缓存事务失败'));
    transaction.onabort = () => reject(transaction.error ?? new Error('课程缓存事务被中止'));
  });
}

export async function listCachedCourses(): Promise<CachedCourse[]> {
  const db = await openDb();
  const rows = await promisify(db.transaction(COURSE_STORE, 'readonly').objectStore(COURSE_STORE).getAll());
  return (rows as unknown[]).filter(isCachedCourse);
}

export async function readCachedCourse(id: string): Promise<CachedCourse | null> {
  const db = await openDb();
  const row = await promisify(db.transaction(COURSE_STORE, 'readonly').objectStore(COURSE_STORE).get(id));
  return isCachedCourse(row) ? row : null;
}

export async function writeCachedCourse(entry: CachedCourse): Promise<void> {
  const db = await openDb();
  const transaction = db.transaction(COURSE_STORE, 'readwrite');
  transaction.objectStore(COURSE_STORE).put(entry);
  await transactionDone(transaction);
}

/** 删除一门课及其全部媒体。两件事在同一个事务里，不会留下孤儿媒体占着配额。 */
export async function deleteCachedCourse(id: string): Promise<void> {
  const db = await openDb();
  const transaction = db.transaction([COURSE_STORE, MEDIA_STORE], 'readwrite');
  transaction.objectStore(COURSE_STORE).delete(id);
  const mediaStore = transaction.objectStore(MEDIA_STORE);
  const keys = await promisify(mediaStore.index('courseId').getAllKeys(IDBKeyRange.only(id)));
  for (const key of keys) mediaStore.delete(key);
  await transactionDone(transaction);
}

export async function putCachedMedia(entry: CachedMedia): Promise<void> {
  const db = await openDb();
  const transaction = db.transaction(MEDIA_STORE, 'readwrite');
  transaction.objectStore(MEDIA_STORE).put(entry);
  await transactionDone(transaction);
}

export async function readMediaBlob(courseId: string, url: string): Promise<Blob | null> {
  const db = await openDb();
  const row = await promisify(db.transaction(MEDIA_STORE, 'readonly').objectStore(MEDIA_STORE).get(`${courseId}::${url}`)) as unknown;
  if (!isRecord(row) || !(row.blob instanceof Blob)) return null;
  return row.blob;
}

/**
 * 一次性取出整门课的媒体。
 *
 * 逐张图去查会为每个元素开一个事务，在 iPad 上翻一页就要几十次异步往返。
 * 这里一次读完，渲染时全部命中内存。
 */
export async function readCourseMedia(courseId: string): Promise<Map<string, Blob>> {
  const db = await openDb();
  const store = db.transaction(MEDIA_STORE, 'readonly').objectStore(MEDIA_STORE);
  const rows = await promisify(store.index('courseId').getAll(IDBKeyRange.only(courseId)));
  const map = new Map<string, Blob>();
  for (const row of rows as unknown[]) {
    if (isRecord(row) && typeof row.url === 'string' && row.blob instanceof Blob) map.set(row.url, row.blob);
  }
  return map;
}

/** 当前缓存占用的总字节数（课程文档 + 媒体）。 */
export async function cachedBytes(): Promise<number> {
  const db = await openDb();
  const transaction = db.transaction([COURSE_STORE, MEDIA_STORE], 'readonly');
  const courses = await promisify(transaction.objectStore(COURSE_STORE).getAll()) as unknown[];
  const media = await promisify(transaction.objectStore(MEDIA_STORE).getAll()) as unknown[];
  const mediaBytes = media.reduce<number>((sum, row) => sum + (isRecord(row) && isFiniteNumber(row.bytes) ? row.bytes : 0), 0);
  const courseBytes = courses.reduce<number>((sum, row) => sum + (isCachedCourse(row) ? JSON.stringify(row.course).length : 0), 0);
  return mediaBytes + courseBytes;
}

/** 测试用：清空整库。 */
export async function clearCourseCache(): Promise<void> {
  const db = await openDb();
  const transaction = db.transaction([COURSE_STORE, MEDIA_STORE], 'readwrite');
  transaction.objectStore(COURSE_STORE).clear();
  transaction.objectStore(MEDIA_STORE).clear();
  await transactionDone(transaction);
}
