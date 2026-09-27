import { CourseApiError, fetchCourse, fetchMediaBlob, type RemoteCourseSummary } from './courseApi';
import { cachedBytes, deleteCachedCourse, putCachedMedia, readCourseMedia, writeCachedCourse, DEFAULT_QUOTA_BYTES, type CachedCourse } from './courseCache';
import { mediaKey, orderMediaForDownload } from './mediaRewrite';

/**
 * 课程库的编排层：把「线上列表」「本地缓存」「连接状态」合成一份可以直接渲染的
 * 视图，并负责下载。
 *
 * 合成逻辑刻意写成纯函数（{@link mergeLibrary}）。离线/在线、已下载/未下载、
 * 线上有更新——这几条分支决定了界面上每一行说什么，而它们恰恰是最容易写错、
 * 又最难在真机上逐一复现的部分。做成纯函数就能用测试把它们钉死。
 */

/** 一门课在列表里的状态。 */
export type LibraryStatus =
  /** 已下载，且与线上一致（或当前离线）。 */
  | 'downloaded'
  /** 已下载，但线上有更新的版本。 */
  | 'stale'
  /** 未下载，当前在线，可以下载。 */
  | 'online'
  /** 未下载且当前离线：只能提示「需要连接」。 */
  | 'unavailable';

export interface LibraryEntry {
  id: string;
  name: string;
  description?: string;
  sceneCount: number;
  updatedAt: number;
  status: LibraryStatus;
  cached?: CachedCourse;
  remote?: RemoteCourseSummary;
}

/**
 * 合成课程列表。
 *
 * 已下载的课一定出现在列表里，即使它已经不在线上（用户可能删了服务端的课程，
 * 但本地那份仍然可看）——离线优先的产品里，把用户自己下载过的东西藏起来是最
 * 糟的一种「一致」。
 *
 * @param remote 线上列表；离线时为 null，表示「没问到」，而不是「没有」。
 */
export function mergeLibrary(remote: RemoteCourseSummary[] | null, cached: CachedCourse[], online: boolean): LibraryEntry[] {
  const cachedById = new Map(cached.map(item => [item.id, item]));
  const remoteById = new Map((remote ?? []).map(item => [item.id, item]));
  const ids = new Set<string>([...cachedById.keys(), ...remoteById.keys()]);
  const entries: LibraryEntry[] = [];
  for (const id of ids) {
    const local = cachedById.get(id);
    const remoteItem = remoteById.get(id);
    const source = remoteItem ?? local;
    if (!source) continue;
    entries.push({
      id,
      name: source.name,
      description: source.description ?? local?.description,
      sceneCount: remoteItem?.sceneCount ?? local?.sceneCount ?? 0,
      updatedAt: Math.max(remoteItem?.updatedAt ?? 0, local?.updatedAt ?? 0),
      status: statusOf(local, remoteItem, online),
      cached: local,
      remote: remoteItem,
    });
  }
  // 已下载的排在前面：离线时它们才是能用的那些。
  return entries.sort((a, b) => rank(a.status) - rank(b.status) || b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
}

function statusOf(local: CachedCourse | undefined, remote: RemoteCourseSummary | undefined, online: boolean): LibraryStatus {
  if (!local) return online && remote ? 'online' : 'unavailable';
  // 只在真的问到线上列表、且线上确实更新了时才标 stale。离线时不能凭旧数据
  // 猜测「有更新」，那会让用户在飞机上看到一条无法处理的提示。
  if (online && remote && remote.updatedAt > local.updatedAt) return 'stale';
  return 'downloaded';
}

function rank(status: LibraryStatus): number {
  return status === 'downloaded' ? 0 : status === 'stale' ? 1 : status === 'online' ? 2 : 3;
}

export const statusLabel: Record<LibraryStatus, string> = {
  downloaded: '已下载',
  stale: '有更新',
  online: '在线',
  unavailable: '需要连接',
};

/** 配额是否还放得下。预留 5% 余量，避免刚好写满后浏览器清理失败。 */
export function hasQuota(usedBytes: number, quotaBytes = DEFAULT_QUOTA_BYTES): boolean {
  return usedBytes < quotaBytes * 0.95;
}

export function describeQuota(usedBytes: number, quotaBytes = DEFAULT_QUOTA_BYTES): string {
  const percent = quotaBytes > 0 ? Math.min(100, Math.round((usedBytes / quotaBytes) * 100)) : 0;
  return `已用 ${(usedBytes / 1024 / 1024).toFixed(1)} MB / ${(quotaBytes / 1024 / 1024).toFixed(0)} MB（${percent}%）`;
}

export class QuotaExceededError extends Error {
  readonly usedBytes: number;
  readonly quotaBytes: number;

  constructor(usedBytes: number, quotaBytes: number) {
    super(`缓存空间不足：${describeQuota(usedBytes, quotaBytes)}。请先删除一些已下载的课程。`);
    this.name = 'QuotaExceededError';
    this.usedBytes = usedBytes;
    this.quotaBytes = quotaBytes;
  }
}

export interface DownloadProgress {
  /** course=取课程 JSON；media=下载资源；saving=写入本地。 */
  phase: 'course' | 'media' | 'saving';
  done: number;
  total: number;
  bytes: number;
  /** 已确认失败的资源数；下载不会因为它们中止。 */
  failed: number;
}

export interface DownloadOptions {
  token?: string;
  quotaBytes?: number;
  signal?: AbortSignal;
  onProgress?: (progress: DownloadProgress) => void;
}

/** 并发上限。iPad 上再高只会让带宽更碎、进度条更卡。 */
const MEDIA_CONCURRENCY = 4;

/**
 * 下载一门课：先取 JSON，再按「图片 → 封面 → 音频 → 视频」的顺序拉资源。
 *
 * 顺序是有意的（见 orderMediaForDownload）：用户中途取消或断网时，拿到的应该是
 * 一门「图都在、视频缺几个」的课，而不是一门视频下了一半、图片一张没有的课。
 *
 * 单个资源失败不计入整体失败：一门 23 个场景的课里挂掉一张配图，不应该让用户
 * 失去整门课。失败数量记进记录，界面照实说明。
 */
export async function downloadCourse(summary: RemoteCourseSummary, origin: string, options: DownloadOptions = {}): Promise<CachedCourse> {
  const quotaBytes = options.quotaBytes ?? DEFAULT_QUOTA_BYTES;
  const usedBefore = await cachedBytes().catch(() => 0);
  if (!hasQuota(usedBefore, quotaBytes)) throw new QuotaExceededError(usedBefore, quotaBytes);

  options.onProgress?.({ phase: 'course', done: 0, total: 1, bytes: 0, failed: 0 });
  const payload = await fetchCourse(origin, summary.id, { token: options.token, signal: options.signal });
  options.onProgress?.({ phase: 'course', done: 1, total: 1, bytes: 0, failed: 0 });

  const media = orderMediaForDownload(payload.media);
  let bytes = 0;
  let failed = 0;
  let done = 0;
  let exceeded = false;

  await mapWithConcurrency(media, MEDIA_CONCURRENCY, async item => {
    if (options.signal?.aborted || exceeded) return;
    const blob = await fetchMediaBlob(item.url, { signal: options.signal });
    if (!blob) {
      failed += 1;
    } else {
      bytes += blob.size;
      // 边下边记账：下载前无法知道总大小，只有累计写入时才能发现越界。
      if (usedBefore + bytes > quotaBytes) {
        exceeded = true;
        return;
      }
      await putCachedMedia({ key: mediaKey(summary.id, item.url), courseId: summary.id, url: item.url, kind: item.kind, blob, bytes: blob.size });
    }
    done += 1;
    options.onProgress?.({ phase: 'media', done, total: media.length, bytes, failed });
  });

  if (exceeded) {
    // 已经写进去的部分要清掉，否则配额被一门「没下载成功」的课占着。
    await deleteCachedCourse(summary.id).catch(() => undefined);
    throw new QuotaExceededError(usedBefore + bytes, quotaBytes);
  }

  options.onProgress?.({ phase: 'saving', done: 0, total: 1, bytes, failed });
  const entry: CachedCourse = {
    id: payload.course.id,
    name: payload.course.name,
    description: payload.course.description,
    sceneCount: payload.course.scenes.length,
    updatedAt: payload.course.updatedAt,
    savedAt: Date.now(),
    course: payload.course,
    media: payload.media,
    mediaBytes: bytes,
    failedMedia: failed,
  };
  await writeCachedCourse(entry);
  options.onProgress?.({ phase: 'saving', done: 1, total: 1, bytes, failed });
  return entry;
}

/**
 * 固定并发地跑完一批任务。
 *
 * 不用 Promise.all(items.map(...))：那会在同一瞬间发起全部请求，一门 23 场景
 * 的课可能有上百个资源，iPad 上会直接把连接池打满，表现为进度条长时间不动。
 */
export async function mapWithConcurrency<T>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  const width = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  await Promise.all(Array.from({ length: width }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  }));
}

/**
 * 为已下载的课程建立「原始 URL → 本地 Blob URL」映射。
 *
 * 调用方负责在离开课程时 revoke：Blob URL 会一直把整份数据钉在内存里，
 * 反复打开同一门课而不释放，是 iPad 上最容易被忽略的内存泄漏。
 */
export async function buildLocalMediaMap(courseId: string): Promise<{ map: Map<string, string>; revoke: () => void }> {
  const blobs = await readCourseMedia(courseId).catch(() => new Map<string, Blob>());
  const map = new Map<string, string>();
  const created: string[] = [];
  for (const [url, blob] of blobs) {
    const objectUrl = URL.createObjectURL(blob);
    map.set(url, objectUrl);
    created.push(objectUrl);
  }
  return {
    map,
    revoke: () => { for (const objectUrl of created) URL.revokeObjectURL(objectUrl); },
  };
}

export { CourseApiError };
