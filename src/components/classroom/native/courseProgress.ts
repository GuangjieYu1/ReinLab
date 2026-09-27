/**
 * 原生课程的续读位置与进度。
 *
 * 沿用 courseState.ts / learningState.ts 的做法：一个带 version 的 JSON 存在
 * localStorage 里，读取时做一次完整校验，形状不对就当没存过。这样上一版应用
 * 留下的数据不会让新版本崩在渲染里。
 *
 * 书签存的是**场景 id** 而不是下标：OpenMAIC 侧重新生成或插入场景后，下标会
 * 整体错位，而 id 仍然指向同一个场景。下标只作为 id 找不到时的兜底。
 */

export const NATIVE_PROGRESS_KEY = 'reinlab-native-course-progress-v1';

export interface CourseBookmark {
  sceneId: string;
  /** 场景下标；sceneId 在新版本里消失时用它回到大致位置。 */
  index: number;
  visitedAt: number;
  /** 已看过的场景 id，用于进度条。 */
  seen: string[];
}

export interface CourseProgressStore {
  version: 1;
  courses: Record<string, CourseBookmark>;
}

export function freshProgress(): CourseProgressStore {
  return { version: 1, courses: {} };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function isBookmark(value: unknown): value is CourseBookmark {
  if (!isRecord(value)) return false;
  return typeof value.sceneId === 'string'
    && typeof value.index === 'number' && Number.isInteger(value.index) && value.index >= 0
    && typeof value.visitedAt === 'number' && Number.isFinite(value.visitedAt) && value.visitedAt >= 0
    && Array.isArray(value.seen) && value.seen.length <= 500 && value.seen.every(id => typeof id === 'string' && id.length > 0);
}

export function isCourseProgressStore(value: unknown): value is CourseProgressStore {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.courses)) return false;
  return Object.values(value.courses).every(isBookmark);
}

export function readProgress(): CourseProgressStore {
  try {
    const raw = JSON.parse(localStorage.getItem(NATIVE_PROGRESS_KEY) ?? 'null');
    if (isCourseProgressStore(raw)) return raw;
  } catch { /* 存储不可用时课程照常可读，只是不留书签。 */ }
  return freshProgress();
}

export function writeProgress(store: CourseProgressStore): boolean {
  try {
    localStorage.setItem(NATIVE_PROGRESS_KEY, JSON.stringify(store));
    return true;
  } catch {
    return false;
  }
}

export function bookmarkFor(store: CourseProgressStore, courseId: string): CourseBookmark | null {
  return store.courses[courseId] ?? null;
}

/** 记录一次停留。seen 只增不减，用来画「看过 N / 共 M」。 */
export function withBookmark(store: CourseProgressStore, courseId: string, sceneId: string, index: number): CourseProgressStore {
  const previous = store.courses[courseId];
  const seen = previous?.seen.includes(sceneId) ? previous.seen : [...(previous?.seen ?? []), sceneId];
  return { ...store, courses: { ...store.courses, [courseId]: { sceneId, index, visitedAt: Date.now(), seen } } };
}

/**
 * 把书签换算成实际要打开的场景下标。
 *
 * 优先按 id 找；找不到时退回记录的下标，并夹到合法范围内——课程变短时，
 * 一个越界的下标会让课程打开即空白。
 */
export function resolveStartIndex(bookmark: CourseBookmark | null, sceneIds: readonly string[]): number {
  if (sceneIds.length === 0) return 0;
  if (!bookmark) return 0;
  const byId = sceneIds.indexOf(bookmark.sceneId);
  if (byId >= 0) return byId;
  return Math.min(Math.max(0, bookmark.index), sceneIds.length - 1);
}

export function seenCount(store: CourseProgressStore, courseId: string, sceneIds: readonly string[]): number {
  const seen = store.courses[courseId]?.seen;
  if (!seen) return 0;
  const present = new Set(sceneIds);
  return seen.filter(id => present.has(id)).length;
}

/** 删除一门课时一并清掉它的书签，避免本地记录无限增长。 */
export function withoutCourse(store: CourseProgressStore, courseId: string): CourseProgressStore {
  if (!(courseId in store.courses)) return store;
  const next = { ...store.courses };
  delete next[courseId];
  return { ...store, courses: next };
}
