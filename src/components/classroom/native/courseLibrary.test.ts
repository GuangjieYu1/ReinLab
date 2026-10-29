import { describe, expect, it } from 'vitest';
import type { RemoteCourseSummary } from './courseApi';
import type { CachedCourse } from './courseCache';
import { describeQuota, hasQuota, mapWithConcurrency, mergeLibrary, statusLabel } from './courseLibrary';
import { DEFAULT_QUOTA_BYTES } from './courseCache';

const remote = (id: string, updatedAt: number, extra: Partial<RemoteCourseSummary> = {}): RemoteCourseSummary =>
  ({ id, name: `课程 ${id}`, sceneCount: 3, createdAt: 1, updatedAt, ...extra });

const cached = (id: string, updatedAt: number, extra: Partial<CachedCourse> = {}): CachedCourse => ({
  id,
  name: `课程 ${id}`,
  sceneCount: 3,
  updatedAt,
  savedAt: 100,
  course: { id, name: `课程 ${id}`, createdAt: 1, updatedAt, sceneCount: 3, stage: {}, scenes: [] },
  media: [],
  mediaBytes: 1024,
  failedMedia: 0,
  ...extra,
});

/**
 * 列表状态是这一层最核心的产品逻辑：同一门课在「在线/离线」与「已下载/未下载」
 * 的四种组合下分别说什么，直接决定了离线时用户能不能看懂眼前发生了什么。
 */
describe('课程库状态合成', () => {
  it('已下载且线上有更新时标记「有更新」', () => {
    const entries = mergeLibrary([remote('a', 200)], [cached('a', 100)], true);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe('stale');
    expect(entries[0].updatedAt).toBe(200);
  });

  it('已下载且线上一致时就是「已下载」', () => {
    expect(mergeLibrary([remote('a', 100)], [cached('a', 100)], true)[0].status).toBe('downloaded');
  });

  it('离线时不凭旧数据猜「有更新」——那会给出一个无法处理的提示', () => {
    const entries = mergeLibrary([remote('a', 999)], [cached('a', 100)], false);
    expect(entries[0].status).toBe('downloaded');
  });

  it('在线但未下载时是「在线」，可以下载', () => {
    const entries = mergeLibrary([remote('a', 100)], [], true);
    expect(entries[0].status).toBe('online');
    expect(entries[0].cached).toBeUndefined();
  });

  it('离线且未下载时是「需要连接」，而不是从列表里消失', () => {
    const entries = mergeLibrary([remote('a', 100)], [], false);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe('unavailable');
    expect(statusLabel[entries[0].status]).toBe('需要连接');
  });

  it('线上已删除、但本机下载过的课程仍然保留：离线优先不能把用户下载的东西藏起来', () => {
    const entries = mergeLibrary([], [cached('gone', 100)], true);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe('downloaded');
  });

  it('已下载的排在未下载之前，离线时能用的那些在最上面', () => {
    const entries = mergeLibrary([remote('a', 500), remote('b', 400)], [cached('b', 400)], true);
    expect(entries.map(entry => entry.id)).toEqual(['b', 'a']);
  });

  it('同一门课不会因为两边都有而重复出现', () => {
    expect(mergeLibrary([remote('a', 100)], [cached('a', 100)], true)).toHaveLength(1);
  });

  it('描述优先取线上，缺失时回落到本地副本', () => {
    const withLocal = mergeLibrary([remote('a', 100)], [cached('a', 100, { description: '本机上的说明' })], true);
    expect(withLocal[0].description).toBe('本机上的说明');
    const withRemote = mergeLibrary([remote('a', 100, { description: '线上的说明' })], [cached('a', 100, { description: '本机上的说明' })], true);
    expect(withRemote[0].description).toBe('线上的说明');
  });

  it('离线且没有任何来源时给出空列表，而不是抛错', () => {
    expect(mergeLibrary(null, [], false)).toEqual([]);
  });
});

describe('缓存配额', () => {
  it('留出 5% 余量，写满后浏览器回收会失败', () => {
    expect(hasQuota(DEFAULT_QUOTA_BYTES * 0.5)).toBe(true);
    expect(hasQuota(DEFAULT_QUOTA_BYTES * 0.96)).toBe(false);
  });

  it('配额文案给出已用、上限与百分比', () => {
    expect(describeQuota(256 * 1024 * 1024, 1024 * 1024 * 1024)).toBe('已用 256.0 MB / 1024 MB（25%）');
  });
});

describe('固定并发', () => {
  it('空列表直接返回', async () => {
    await expect(mapWithConcurrency([], 4, async () => {})).resolves.toBeUndefined();
  });

  it('并发数不超过上限', async () => {
    let active = 0;
    let peak = 0;
    const seen: number[] = [];
    await mapWithConcurrency([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 3, async item => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 1));
      seen.push(item);
      active -= 1;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(seen.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('上限大于任务数时按任务数开', async () => {
    let peak = 0;
    let active = 0;
    await mapWithConcurrency([0, 1], 8, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 1));
      active -= 1;
    });
    expect(peak).toBeLessThanOrEqual(2);
  });
});
