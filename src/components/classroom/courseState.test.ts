import { describe, expect, it } from 'vitest';
import { absenceDays, freshCourse, isCourseRecord, makeHandoff, submitUnitReport } from './courseState';
describe('course evidence and continuation', () => {
  it('validates persisted records without treating malformed progress as mastery', () => {
    expect(isCourseRecord(freshCourse())).toBe(true);
    expect(isCourseRecord({ ...freshCourse(), passed: true })).toBe(false);
    expect(isCourseRecord({ ...freshCourse(), answers: [true] })).toBe(false);
    expect(isCourseRecord({ ...freshCourse(), preferences: null })).toBe(false);
  });
  it('requires both demonstrations before accepting the report', () => {
    const state = freshCourse();
    expect(submitUnitReport(state)).toBe(state);
    const one = { ...state, answers: [true, false] as [boolean, boolean] };
    expect(submitUnitReport(one)).toBe(one);
    const both = { ...state, answers: [true, true] as [boolean, boolean] };
    expect(submitUnitReport(both).passed).toBe(true);
  });
  it('accepts a report only once and preserves bookmarks and branches', () => {
    const done = submitUnitReport({ ...freshCourse(), answers: [true, true] });
    expect(submitUnitReport(done)).toBe(done);
    expect(done.bookmark).toBe('direction');
  });
  it('does not invent absence data for first-time visitors', () => {
    expect(absenceDays(null)).toBeNull();
    expect(absenceDays(0, 8 * 86_400_000)).toBe(8);
    expect(absenceDays(100, 0)).toBe(0);
  });
  it('keeps uncertainty and the prototype boundary in the handoff', () => {
    expect(makeHandoff(freshCourse())).toContain('未核验');
    expect(makeHandoff(freshCourse())).toContain('不代表完整单元的真实掌握程度');
    expect(makeHandoff(freshCourse())).toContain('未调用 DeepSeek Harness');
  });
});
