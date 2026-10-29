import { describe, expect, it } from 'vitest';
import { isCourseIndex, readCourseIndex } from './courseIndex';

/**
 * 离线时看到的课程列表来自这份索引。它决定「需要连接」那条提示能不能出现，
 * 因此形状校验必须严格：一份损坏的索引会让课程库显示一堆没有名字的空行。
 */
describe('上次看到的课程索引', () => {
  const summary = { id: 'stage-1', name: '群论', sceneCount: 23, createdAt: 1, updatedAt: 2 };

  it('接受完整索引', () => {
    expect(isCourseIndex({ version: 1, savedAt: 5, courses: [summary] })).toBe(true);
    expect(isCourseIndex({ version: 1, savedAt: 5, courses: [] })).toBe(true);
  });

  it('拒绝版本不符、字段缺失或课程项损坏的数据', () => {
    expect(isCourseIndex(null)).toBe(false);
    expect(isCourseIndex({ version: 2, savedAt: 5, courses: [] })).toBe(false);
    expect(isCourseIndex({ version: 1, courses: [] })).toBe(false);
    expect(isCourseIndex({ version: 1, savedAt: 5, courses: [{ id: 'a' }] })).toBe(false);
    expect(isCourseIndex({ version: 1, savedAt: 5, courses: 'nope' })).toBe(false);
  });

  it('存储不可用时返回 null，课程库回落到「只有已下载的课程」而不是报错', () => {
    expect(readCourseIndex()).toBeNull();
  });
});
