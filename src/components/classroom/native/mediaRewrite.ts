/**
 * 课程 JSON 里的媒体地址替换。
 *
 * 为什么是「通用深走」而不是按元素类型逐个取字段：课程里的图片、音频、视频、
 * 背景图、视频封面分散在十几种元素形状里，而且 OpenMAIC 每加一种元素类型，
 * 按字段名写的替换逻辑就会静默漏掉它——课程照常打开，只有那一张图离线时是空的，
 * 这种缺陷在真机上极难发现。反过来，服务端已经给出这门课引用的全部媒体 URL
 * （导出端点的 media 清单），于是「把 JSON 里出现的这些字符串换成 Blob URL」
 * 就是一个与元素类型无关的完备做法。
 *
 * 纯函数，不碰 DOM 也不碰 IndexedDB，因此可以单独测试。
 */

/** 只替换这两类协议：data: / blob: 本来就自带内容，不需要缓存。 */
export function isCacheableMediaUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** 常见媒体扩展名。 */
const MEDIA_EXTENSION = /\.(png|jpe?g|webp|gif|svg|avif|bmp|ico|mp4|webm|mov|m4v|ogv|mp3|wav|m4a|aac|ogg|oga|flac)(\?|#|$)/i;
/** 明确不是课程媒体的资源：脚本、样式、字体、数据。 */
const NON_MEDIA_EXTENSION = /\.(css|js|mjs|cjs|map|json|html?|woff2?|ttf|otf|eot|txt|xml)(\?|#|$)/i;
/**
 * 没有扩展名但确定是媒体服务的路径。
 *
 * 课程媒体在这个部署里走 /api/classroom-media/<courseId>/<name>，文件名不带
 * 扩展名，只靠后缀判断会漏掉它们。
 */
const MEDIA_PATH = /\/(classroom-media|proxy-media|api\/storage|storage\/assets)\//i;

/**
 * 这个远端地址看起来是不是课程媒体。
 *
 * 存在的理由是真实数据：某门 23 场景的课程里，交互式场景的 html 字段引用了
 * 三个 KaTeX CDN 地址（.css / .js）。它们不是课程媒体，却被通用深走扫出来，
 * 于是「本课有 3 个资源未能缓存」这条提示会在一个根本没有媒体的课程上出现。
 * 提示一旦开始误报，用户就会学会忽略它，真正的缺失反而看不见了。
 */
export function looksLikeMediaUrl(value: string): boolean {
  if (!isCacheableMediaUrl(value)) return false;
  if (NON_MEDIA_EXTENSION.test(value)) return false;
  return MEDIA_EXTENSION.test(value) || MEDIA_PATH.test(value);
}

/**
 * 深度替换课程数据里的媒体地址。
 *
 * 返回全新结构，不修改入参：同一份课程可能在「在线」和「已下载」两种状态间
 * 来回切换，就地改写会让第二次渲染拿到已经被替换过的地址。
 *
 * 只有值**恰好等于**清单里的某个 URL 时才替换。不做子串匹配——一个 URL 是
 * 另一个 URL 的前缀是常见情况（同一目录下的两张图），子串替换会拼出坏地址。
 */
export function rewriteMediaUrls<T>(value: T, map: ReadonlyMap<string, string>): T {
  if (map.size === 0) return value;
  return walk(value, map, new WeakSet()) as T;
}

function walk(value: unknown, map: ReadonlyMap<string, string>, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return map.get(value) ?? value;
  if (value === null || typeof value !== 'object') return value;
  // 课程数据来自 JSON，本不该有环；真出现了也宁可原样返回，不要栈溢出。
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => walk(item, map, seen));
  const source = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const key of Object.keys(source)) next[key] = walk(source[key], map, seen);
  return next;
}

/**
 * 收集课程数据里仍然指向远端的媒体地址。
 *
 * 用于离线后的自检：把清单里已知的地址替换完之后，如果还剩远端地址，说明
 * 服务端的媒体清单漏掉了它们（或缓存失败）。界面据此给出「本课有 N 个资源
 * 未能缓存」的提示，而不是让用户对着一张空图猜原因。
 *
 * 只收集「看起来是媒体」的地址，理由见 {@link looksLikeMediaUrl}。
 */
export function collectRemoteMediaUrls(value: unknown): string[] {
  const found = new Set<string>();
  visit(value, found, new WeakSet());
  return [...found].sort();
}

function visit(value: unknown, found: Set<string>, seen: WeakSet<object>): void {
  if (typeof value === 'string') {
    if (looksLikeMediaUrl(value)) found.add(value);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) visit(item, found, seen);
    return;
  }
  for (const item of Object.values(value as Record<string, unknown>)) visit(item, found, seen);
}

/** 缓存键：同一门课里同一个 URL 只存一份，跨课程则互不影响。 */
export function mediaKey(courseId: string, url: string): string {
  return `${courseId}::${url}`;
}

/**
 * 媒体缓存的下载顺序。
 *
 * 图片排在前面是有意的：一门课的封面与配图决定它「看起来能不能用」，而视频
 * 往往占掉九成体积。按 image → poster → audio → video 的顺序下载，用户在网络
 * 中断或中途取消时，拿到的是一个能看的课程，而不是一堆下了一半的视频。
 */
const KIND_ORDER: Record<string, number> = { image: 0, poster: 1, audio: 2, video: 3 };

export function orderMediaForDownload(media: readonly { url: string; kind: string }[]): { url: string; kind: string }[] {
  return media
    .slice()
    .sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || a.url.localeCompare(b.url));
}

/** 人类可读的体积，用于下载进度与配额提示。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
