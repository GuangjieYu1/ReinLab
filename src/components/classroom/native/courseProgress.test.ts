import { describe, expect, it } from 'vitest';
import { bookmarkFor, freshProgress, isCourseProgressStore, readProgress, resolveStartIndex, seenCount, withBookmark, withoutCourse, writeProgress } from './courseProgress';

describe('续读位置', () => {
  it('记录停留位置，seen 只增不减', () => {
    let store = freshProgress();
    store = withBookmark(store, 'c1', 's3', 2);
    store = withBookmark(store, 'c1', 's5', 4);
    store = withBookmark(store, 'c1', 's3', 2);
    expect(store.courses.c1.sceneId).toBe('s3');
    expect(store.courses.c1.index).toBe(2);
    expect(store.courses.c1.seen).toEqual(['s3', 's5']);
  });

  it('不修改入参：书签更新要走 React 状态，就地改写不会触发重渲染', () => {
    const store = freshProgress();
    const next = withBookmark(store, 'c1', 's1', 0);
    expect(store.courses.c1).toBeUndefined();
    expect(next).not.toBe(store);
  });

  it('课程之间互不影响', () => {
    let store = withBookmark(freshProgress(), 'c1', 's1', 0);
    store = withBookmark(store, 'c2', 't9', 7);
    expect(bookmarkFor(store, 'c1')?.sceneId).toBe('s1');
    expect(bookmarkFor(store, 'c2')?.sceneId).toBe('t9');
    expect(bookmarkFor(store, 'c3')).toBeNull();
  });

  it('删除课程时一并清掉书签，避免「下载—删除」循环把本地记录撑大', () => {
    const store = withBookmark(freshProgress(), 'c1', 's1', 0);
    expect(withoutCourse(store, 'c1').courses.c1).toBeUndefined();
    expect(withoutCourse(store, 'missing')).toBe(store);
  });
});

describe('书签换算成场景下标', () => {
  const ids = ['s1', 's2', 's3'];

  it('优先按场景 id 定位：重新生成课程后下标会错位，id 不会', () => {
    expect(resolveStartIndex({ sceneId: 's3', index: 0, visitedAt: 1, seen: [] }, ids)).toBe(2);
  });

  it('id 已不存在时退回下标', () => {
    expect(resolveStartIndex({ sceneId: 'gone', index: 1, visitedAt: 1, seen: [] }, ids)).toBe(1);
  });

  it('课程变短时把越界下标夹回范围内，否则打开即空白', () => {
    expect(resolveStartIndex({ sceneId: 'gone', index: 99, visitedAt: 1, seen: [] }, ids)).toBe(2);
    expect(resolveStartIndex({ sceneId: 'gone', index: -5, visitedAt: 1, seen: [] }, ids)).toBe(0);
  });

  it('打开 → 翻页 → 关闭 → 重新打开，回到上次那一页而不是第一页', () => {
    const ids = ['s1', 's2', 's3'];
    // 第一次打开：书签为空，落在第一页，并把这次停留写回去。
    let store = withBookmark(freshProgress(), 'c1', ids[resolveStartIndex(null, ids)], 0);
    // 翻到第三页。
    store = withBookmark(store, 'c1', 's3', 2);
    // 重新打开：解析出来的下标必须与写回的值一致，否则打开课程本身就会把书签冲掉。
    const start = resolveStartIndex(bookmarkFor(store, 'c1'), ids);
    expect(start).toBe(2);
    expect(store.courses.c1.seen).toEqual(['s1', 's3']);
  });

  it('没有书签或没有场景时从头开始', () => {
    expect(resolveStartIndex(null, ids)).toBe(0);
    expect(resolveStartIndex({ sceneId: 's1', index: 0, visitedAt: 1, seen: [] }, [])).toBe(0);
  });
});

describe('进度统计', () => {
  it('只统计当前课程里仍然存在的场景', () => {
    let store = withBookmark(freshProgress(), 'c1', 's1', 0);
    store = withBookmark(store, 'c1', 's2', 1);
    store = withBookmark(store, 'c1', 'removed', 2);
    expect(seenCount(store, 'c1', ['s1', 's2', 's3'])).toBe(2);
    expect(seenCount(store, 'c1', ['s9'])).toBe(0);
    expect(seenCount(store, 'unknown', ['s1'])).toBe(0);
  });
});

describe('本地记录的形状校验', () => {
  it('接受完整记录', () => {
    expect(isCourseProgressStore({ version: 1, courses: { c1: { sceneId: 's1', index: 0, visitedAt: 5, seen: ['s1'] } } })).toBe(true);
    expect(isCourseProgressStore({ version: 1, courses: {} })).toBe(true);
  });

  it('拒绝上一版留下的或损坏的数据，而不是让它流进渲染层', () => {
    expect(isCourseProgressStore(null)).toBe(false);
    expect(isCourseProgressStore({ version: 2, courses: {} })).toBe(false);
    expect(isCourseProgressStore({ version: 1, courses: { c1: { sceneId: 's1', index: 0.5, visitedAt: 5, seen: [] } } })).toBe(false);
    expect(isCourseProgressStore({ version: 1, courses: { c1: { sceneId: 's1', index: 0, visitedAt: 5 } } })).toBe(false);
    expect(isCourseProgressStore({ version: 1, courses: { c1: { sceneId: 's1', index: -1, visitedAt: 5, seen: [] } } })).toBe(false);
  });
});

describe('存储不可用时', () => {
  it('读取回落到空记录，课程照常可看', () => {
    expect(readProgress()).toEqual(freshProgress());
  });

  it('写入如实返回 false，界面据此提示「只在本次会话保留」', () => {
    expect(writeProgress(freshProgress())).toBe(false);
  });
});
