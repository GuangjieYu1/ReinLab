export const COURSE_KEY = 'reinlab-course-linear-algebra-v1';
export const courseUnits = [
  { title: '向量与空间', subtitle: '建立空间的语言', summary: '向量描述方向与长度；基决定我们如何为它写下坐标。' },
  { title: '线性变换', subtitle: '让空间发生变化', summary: '先看基向量去了哪里，再理解整个空间怎样变形。' },
  { title: '特征值与特征向量', subtitle: '寻找变换中的不变方向', summary: '有一些方向，在变换之后仍然留在原来的直线上。' },
  { title: '正交与投影', subtitle: '把一个向量放进另一个空间', summary: '下一步，我们会用投影连接几何直觉与最小二乘问题。' },
  { title: '矩阵分解', subtitle: '把复杂变换拆开来看', summary: '将一个复杂的变换，拆成几步更容易理解的动作。' },
  { title: '综合应用', subtitle: '从理解走向使用', summary: '在一个小项目中串联变换、特征方向与投影。' },
] as const;
export type ReadingMode = 'cards' | 'document';
export type CoursePreferences = { mode: ReadingMode; largeType: boolean };
export type CourseBranch = { id: string; parent: string; question: string };
export type CourseRecord = {
  version: 1; lastVisit: number | null; passed: boolean; answers: [boolean, boolean];
  bookmark: string; branches: CourseBranch[]; preferences: CoursePreferences;
};
export const freshCourse = (): CourseRecord => ({
  version: 1, lastVisit: null, passed: false, answers: [false, false], bookmark: 'direction',
  branches: [], preferences: { mode: 'cards', largeType: false },
});
export function isCourseRecord(value: unknown): value is CourseRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as CourseRecord;
  return v.version === 1 && (v.lastVisit === null || typeof v.lastVisit === 'number' && Number.isFinite(v.lastVisit) && v.lastVisit >= 0)
    && typeof v.passed === 'boolean' && Array.isArray(v.answers) && v.answers.length === 2 && v.answers.every(a => typeof a === 'boolean')
    && typeof v.bookmark === 'string' && ['intro', 'direction', 'review', 'check'].includes(v.bookmark)
    && Array.isArray(v.branches) && v.branches.length <= 40 && v.branches.every(b => b && typeof b.id === 'string' && typeof b.parent === 'string' && typeof b.question === 'string' && b.question.length <= 1000)
    && !!v.preferences && ['cards', 'document'].includes(v.preferences.mode) && typeof v.preferences.largeType === 'boolean'
    && (!v.passed || v.answers.every(Boolean));
}
export function submitUnitReport(record: CourseRecord): CourseRecord {
  if (!record.answers.every(Boolean) || record.passed) return record;
  return { ...record, passed: true };
}
export function absenceDays(lastVisit: number | null, now = Date.now()) {
  return lastVisit === null ? null : Math.max(0, Math.floor((now - lastVisit) / 86_400_000));
}
export function makeHandoff(record: CourseRecord) {
  return [
    '# 线性代数 / 单元 03 / 本地演示交接记录',
    '',
    '范围：仅核验本设计原型的两个示例目标，不代表完整单元的真实掌握程度。',
    `- 目标一：辨认特征方向 — ${record.answers[0] ? '示例核验通过' : '未核验'}`,
    `- 目标二：区分特征向量与特征值 — ${record.answers[1] ? '示例核验通过' : '未核验'}`,
    '- 待核验：特征多项式推导、独立解题、间隔后的回忆表现。',
    '- 建议：后续由教授补充推导与迁移核验，主任不据此推断整体熟练度。',
    `- 当前书签：${record.bookmark}`,
    `- 保留追问分支：${record.branches.length}`,
    '',
    '本文件由前端演示生成，未调用 DeepSeek Harness 或真实 Agent。',
  ].join('\n');
}
