import { isCourseSummary, type RemoteCourseSummary } from './courseApi';

/**
 * 上一次成功取到的课程列表（只有元数据，几十 KB）。
 *
 * 为什么需要它：离线时我们问不到线上列表，如果只显示本地缓存，那么「我知道
 * 这门课存在，但还没下载」这件事就消失了——用户看到的是一个凭空变短的课程库，
 * 而不是一句「这门课需要连接」。把最后一次看到的索引留在本机，离线时就能把
 * 未下载的课程标成「需要连接」，这正是验收标准里要求的那条提示。
 *
 * 只存元数据，不存课程内容：它的作用是「记得有什么」，不是「能离线看什么」。
 */

export const COURSE_INDEX_KEY = 'reinlab-native-course-index-v1';

export interface CourseIndex {
  version: 1;
  savedAt: number;
  courses: RemoteCourseSummary[];
}

export function isCourseIndex(value: unknown): value is CourseIndex {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as CourseIndex;
  return v.version === 1
    && typeof v.savedAt === 'number' && Number.isFinite(v.savedAt)
    && Array.isArray(v.courses) && v.courses.length <= 2000 && v.courses.every(isCourseSummary);
}

export function readCourseIndex(): CourseIndex | null {
  try {
    const raw = JSON.parse(localStorage.getItem(COURSE_INDEX_KEY) ?? 'null');
    if (isCourseIndex(raw)) return raw;
  } catch { /* 存储不可用时就当没有索引，课程库仍然可用。 */ }
  return null;
}

export function writeCourseIndex(courses: RemoteCourseSummary[]): void {
  try {
    localStorage.setItem(COURSE_INDEX_KEY, JSON.stringify({ version: 1, savedAt: Date.now(), courses }));
  } catch { /* 索引只是锦上添花，写不进去不影响主流程。 */ }
}
