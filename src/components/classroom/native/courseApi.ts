import type { Slide } from '@openmaic/dsl';

/**
 * 与 OpenMAIC 的 /api/reinlab/* 导出端点通信。
 *
 * 这里刻意把「网络」和「形状校验」放在一起：课程 JSON 是从另一台机器、另一个
 * 版本的 OpenMAIC 取回来的跨版本数据，服务端升级后字段可能悄悄变化。若直接
 * 信任它，渲染层会在某个奇怪的地方崩掉，而报错信息与真正的原因相距甚远。
 * 因此每个入口都先做一次信封级校验，形状不对就抛 CourseApiError('malformed')，
 * 让界面能说清楚「课程数据不可用」，而不是留下一个白屏。
 */

/** 课程列表里的一项。字段与 OpenMAIC DocumentSummary 对齐。 */
export interface RemoteCourseSummary {
  id: string;
  name: string;
  description?: string;
  sceneCount: number;
  createdAt: number;
  updatedAt: number;
  folderId?: string;
}

/** 课程引用的一个媒体资源，供离线缓存逐个下载。 */
export interface RemoteMediaRef {
  url: string;
  kind: 'image' | 'audio' | 'video' | 'poster';
  count: number;
}

/**
 * 场景的宽松形状。
 *
 * 只固定渲染真正依赖的四个字段；content 保持 unknown，由 {@link slideOf}
 * 在真正要画的时候再判定。这样即便 OpenMAIC 新增了场景类型，这里也不会因为
 * 类型不匹配而整个课程打不开。
 */
export interface RemoteScene {
  id: string;
  title: string;
  order: number;
  type: string;
  content?: unknown;
  whiteboards?: unknown[];
  actions?: unknown[];
}

export interface RemoteCourse {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  sceneCount: number;
  stage: unknown;
  scenes: RemoteScene[];
  dslVersion?: string;
}

export interface RemoteCoursePayload {
  course: RemoteCourse;
  media: RemoteMediaRef[];
}

/** 失败原因分三类，界面据此给出不同的说法。 */
export type CourseApiErrorKind = 'offline' | 'http' | 'malformed';

export class CourseApiError extends Error {
  readonly kind: CourseApiErrorKind;
  readonly status?: number;

  constructor(kind: CourseApiErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'CourseApiError';
    this.kind = kind;
    this.status = status;
  }
}

export interface CourseApiOptions {
  /** 导出端点令牌；未设置 REINLAB_EXPORT_TOKEN 的服务端不需要它。 */
  token?: string;
  signal?: AbortSignal;
}

/** 去掉末尾斜杠；空串原样返回。 */
export function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, '');
}

/**
 * 拼出导出端点的 URL。令牌可以走 Authorization 头，但 blob 下载与
 * <img>/<video> 的直连场景没有自定义头可用，因此同时支持 ?token= 查询参数，
 * 两处都带上以免在某个分支上漏掉。
 */
export function exportUrl(origin: string, path: string, token?: string): string {
  const base = `${normalizeOrigin(origin)}/api/reinlab${path}`;
  const trimmed = token?.trim();
  return trimmed ? `${base}?token=${encodeURIComponent(trimmed)}` : base;
}

function requestHeaders(token?: string): HeadersInit {
  const trimmed = token?.trim();
  return trimmed ? { Authorization: `Bearer ${trimmed}` } : {};
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

function optionalString(value: unknown): string | undefined {
  return isNonEmptyString(value) ? value : undefined;
}

/** 列表项校验。宽松到只要求渲染列表真正用到的字段。 */
export function isCourseSummary(value: unknown): value is RemoteCourseSummary {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.id)
    && typeof value.name === 'string'
    && isFiniteNumber(value.sceneCount)
    && isFiniteNumber(value.createdAt)
    && isFiniteNumber(value.updatedAt);
}

const MEDIA_KINDS = ['image', 'audio', 'video', 'poster'] as const;

export function isMediaRef(value: unknown): value is RemoteMediaRef {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.url)
    && MEDIA_KINDS.includes(value.kind as RemoteMediaRef['kind'])
    && isFiniteNumber(value.count);
}

/** 场景校验：只要求渲染循环真正读的字段。 */
export function isRemoteScene(value: unknown): value is RemoteScene {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.id)
    && typeof value.title === 'string'
    && isFiniteNumber(value.order)
    && typeof value.type === 'string';
}

/**
 * 从场景里取出可渲染的幻灯片。
 *
 * 只有 content.type === 'slide' 且 canvas.elements 是数组时才认为可渲染；
 * quiz / interactive / pbl 以及形状异常的 slide 都返回 null，交给调用方
 * 显示相应的说明面板——这比抛异常更能保住「课程至少能翻页」这个底线。
 */
export function slideOf(scene: RemoteScene): Slide | null {
  if (!isRecord(scene.content) || scene.content.type !== 'slide') return null;
  const canvas = scene.content.canvas;
  if (!isRecord(canvas) || !Array.isArray(canvas.elements)) return null;
  return canvas as unknown as Slide;
}

/** 场景里携带的测验题（只读展示用）。形状不对时返回空数组。 */
export function quizOf(scene: RemoteScene): { id: string; question: string; options?: { label: string; value: string }[]; analysis?: string }[] {
  if (!isRecord(scene.content) || scene.content.type !== 'quiz') return [];
  const questions = scene.content.questions;
  if (!Array.isArray(questions)) return [];
  return questions.flatMap(item => {
    if (!isRecord(item) || !isNonEmptyString(item.id) || typeof item.question !== 'string') return [];
    const options = Array.isArray(item.options)
      ? item.options.flatMap(option => isRecord(option) && typeof option.label === 'string' && typeof option.value === 'string'
        ? [{ label: option.label, value: option.value }]
        : [])
      : undefined;
    return [{ id: item.id, question: item.question, options, analysis: optionalString(item.analysis) }];
  });
}

/** 按 order 排序并剔除形状不对的场景。排序在这里做一次，渲染层就不必再关心。 */
export function normalizeScenes(scenes: unknown): RemoteScene[] {
  if (!Array.isArray(scenes)) return [];
  return scenes
    .filter(isRemoteScene)
    .slice()
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function isCoursePayload(value: unknown): value is RemoteCoursePayload {
  if (!isRecord(value)) return false;
  const course = value.course;
  if (!isRecord(course)) return false;
  if (!isNonEmptyString(course.id) || typeof course.name !== 'string') return false;
  if (!Array.isArray(course.scenes)) return false;
  return Array.isArray(value.media) && value.media.every(isMediaRef);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new CourseApiError('malformed', '服务返回的不是 JSON');
  }
}

/** 把 fetch 抛出的网络层异常归一成 'offline'，供界面统一判定。 */
function asOffline(error: unknown): CourseApiError {
  if (error instanceof CourseApiError) return error;
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new CourseApiError('offline', '请求已取消');
  }
  return new CourseApiError('offline', error instanceof Error ? error.message : '无法连接 OpenMAIC');
}

/** 探测结果。persistence 为 false 表示服务在跑，但没有配置课程库。 */
export interface ExportStatus {
  reachable: boolean;
  persistence: boolean;
}

/**
 * 探测导出端点。
 *
 * 刻意不复用 fetchCourseList：离线判定要能区分「服务不在」和「服务在但没有
 * 课程」，用一个轻量且不需要数据库的端点来回答前者，才不会把后者的空列表
 * 误判成离线。
 *
 * 同时读回 persistence：服务端在没有 DATABASE_URL 时会让课程路由返回 404。
 * 若只报「可达」，用户看到的是一句「课程列表请求失败（HTTP 404）」，而真正
 * 的原因——服务端根本没接课程库——不会出现在界面上。
 */
export async function probeExport(origin: string, options: CourseApiOptions = {}): Promise<ExportStatus> {
  if (!normalizeOrigin(origin)) return { reachable: false, persistence: false };
  try {
    const response = await fetch(exportUrl(origin, '/health', options.token), {
      headers: requestHeaders(options.token),
      signal: options.signal,
    });
    if (!response.ok) return { reachable: false, persistence: false };
    const body = await response.json();
    if (!isRecord(body) || body.ok !== true) return { reachable: false, persistence: false };
    return { reachable: true, persistence: body.persistence === true };
  } catch {
    return { reachable: false, persistence: false };
  }
}

export async function fetchCourseList(origin: string, options: CourseApiOptions = {}): Promise<RemoteCourseSummary[]> {
  let response: Response;
  try {
    response = await fetch(exportUrl(origin, '/courses', options.token), {
      headers: requestHeaders(options.token),
      signal: options.signal,
    });
  } catch (error) {
    throw asOffline(error);
  }
  if (!response.ok) {
    throw new CourseApiError('http', `课程列表请求失败（HTTP ${response.status}）`, response.status);
  }
  const body = await readJson(response);
  if (!isRecord(body) || !Array.isArray(body.courses) || !body.courses.every(isCourseSummary)) {
    throw new CourseApiError('malformed', '课程列表的形状与预期不符');
  }
  return body.courses.slice().sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function fetchCourse(origin: string, id: string, options: CourseApiOptions = {}): Promise<RemoteCoursePayload> {
  let response: Response;
  try {
    response = await fetch(exportUrl(origin, `/courses/${encodeURIComponent(id)}`, options.token), {
      headers: requestHeaders(options.token),
      signal: options.signal,
    });
  } catch (error) {
    throw asOffline(error);
  }
  if (response.status === 404) {
    throw new CourseApiError('http', '这门课程在 OpenMAIC 上已不存在', 404);
  }
  if (!response.ok) {
    throw new CourseApiError('http', `课程请求失败（HTTP ${response.status}）`, response.status);
  }
  const body = await readJson(response);
  if (!isCoursePayload(body)) {
    throw new CourseApiError('malformed', '课程数据的形状与预期不符');
  }
  return {
    course: { ...body.course, scenes: normalizeScenes(body.course.scenes) },
    media: body.media,
  };
}

/**
 * 下载一个媒体资源为 Blob。
 *
 * 失败返回 null 而不是抛异常：单课可能有几十个资源，一个 404 的配图不应该
 * 让整门课的下载失败。调用方按返回值统计失败数量并在界面上说明。
 */
export async function fetchMediaBlob(url: string, options: CourseApiOptions = {}): Promise<Blob | null> {
  try {
    const response = await fetch(url, { signal: options.signal });
    if (!response.ok) return null;
    return await response.blob();
  } catch {
    return null;
  }
}
