import { describe, expect, it } from 'vitest';
import { exportUrl, isCoursePayload, isCourseSummary, isMediaRef, isRemoteScene, normalizeOrigin, normalizeScenes, quizOf, slideOf } from './courseApi';

/**
 * 课程 JSON 是从另一台机器、另一个版本的 OpenMAIC 取回来的跨版本数据。这里的
 * 校验决定了「服务端升级后字段变了」会表现为一句清楚的提示，还是一片白屏。
 */
describe('导出端点地址', () => {
  it('去掉末尾斜杠', () => {
    expect(normalizeOrigin('http://192.168.1.10:3000/')).toBe('http://192.168.1.10:3000');
    expect(normalizeOrigin('  http://a.b//  ')).toBe('http://a.b');
    expect(normalizeOrigin('')).toBe('');
  });

  it('没有令牌时不加查询参数', () => {
    expect(exportUrl('http://a.b/', '/courses')).toBe('http://a.b/api/reinlab/courses');
    expect(exportUrl('http://a.b', '/courses', '   ')).toBe('http://a.b/api/reinlab/courses');
  });

  it('有令牌时带上并做 URL 编码：令牌可能含 + / = 等字符', () => {
    expect(exportUrl('http://a.b', '/courses', 'a b+c/d=')).toBe('http://a.b/api/reinlab/courses?token=a%20b%2Bc%2Fd%3D');
  });
});

describe('列表项校验', () => {
  it('接受服务端给出的形状', () => {
    expect(isCourseSummary({ id: 'stage-1', name: '群论', sceneCount: 23, createdAt: 1, updatedAt: 2 })).toBe(true);
  });

  it('拒绝缺字段或类型不对的项', () => {
    expect(isCourseSummary({ id: '', name: 'x', sceneCount: 1, createdAt: 1, updatedAt: 2 })).toBe(false);
    expect(isCourseSummary({ id: 'a', name: 'x', createdAt: 1, updatedAt: 2 })).toBe(false);
    expect(isCourseSummary({ id: 'a', name: 'x', sceneCount: '3', createdAt: 1, updatedAt: 2 })).toBe(false);
    expect(isCourseSummary(null)).toBe(false);
  });
});

describe('媒体清单校验', () => {
  it('只接受四种已知类型', () => {
    expect(isMediaRef({ url: 'https://x/y.png', kind: 'image', count: 1 })).toBe(true);
    expect(isMediaRef({ url: 'https://x/y.png', kind: 'audio', count: 2 })).toBe(true);
    expect(isMediaRef({ url: 'https://x/y.png', kind: 'widget', count: 1 })).toBe(false);
    expect(isMediaRef({ url: '', kind: 'image', count: 1 })).toBe(false);
  });
});

describe('场景校验与排序', () => {
  const scene = (id: string, order: number) => ({ id, title: id, order, type: 'slide' });

  it('剔除形状不对的场景，而不是让整门课打不开', () => {
    expect(normalizeScenes([scene('a', 0), { id: 'b' }, null, scene('c', 1)])).toHaveLength(2);
    expect(normalizeScenes(undefined)).toEqual([]);
  });

  it('按 order 排序，order 相同时按 id 保持稳定', () => {
    expect(normalizeScenes([scene('c', 2), scene('a', 0), scene('b', 1)]).map(item => item.id)).toEqual(['a', 'b', 'c']);
    expect(normalizeScenes([scene('b', 1), scene('a', 1)]).map(item => item.id)).toEqual(['a', 'b']);
  });

  it('isRemoteScene 只要求渲染真正依赖的字段', () => {
    expect(isRemoteScene(scene('a', 0))).toBe(true);
    expect(isRemoteScene({ id: 'a', title: 'a', order: 0 })).toBe(false);
  });
});

describe('从场景里取出可渲染的内容', () => {
  const slideScene = { id: 's', title: 's', order: 0, type: 'slide', content: { type: 'slide', canvas: { id: 'c', viewportSize: 1000, viewportRatio: 0.5625, elements: [] } } };

  it('slide 场景取出 canvas', () => {
    expect(slideOf(slideScene)?.viewportSize).toBe(1000);
  });

  it('quiz / interactive / 形状异常的 slide 都返回 null，交给说明面板', () => {
    expect(slideOf({ id: 'q', title: 'q', order: 0, type: 'quiz', content: { type: 'quiz', questions: [] } })).toBeNull();
    expect(slideOf({ id: 'i', title: 'i', order: 0, type: 'interactive', content: { type: 'interactive' } })).toBeNull();
    expect(slideOf({ id: 'x', title: 'x', order: 0, type: 'slide', content: { type: 'slide', canvas: { elements: 'nope' } } })).toBeNull();
    expect(slideOf({ id: 'y', title: 'y', order: 0, type: 'slide' })).toBeNull();
  });

  it('quiz 只读取出题干与选项，坏题目被跳过', () => {
    const quiz = quizOf({
      id: 'q', title: 'q', order: 0, type: 'quiz',
      content: { type: 'quiz', questions: [
        { id: 'q1', question: '群的定义包含哪三条？', options: [{ label: '结合律', value: 'a' }, { label: '单位元', value: 'b' }], analysis: '见讲义第 2 页。' },
        { id: 'q2', question: '交换律是必要条件吗？' },
        { question: '缺少 id 的题目' },
      ] },
    });
    expect(quiz).toHaveLength(2);
    expect(quiz[0].options).toHaveLength(2);
    expect(quiz[0].analysis).toBe('见讲义第 2 页。');
    expect(quiz[1].options).toBeUndefined();
  });
});

describe('课程信封校验', () => {
  const payload = { course: { id: 'stage-1', name: '群论', createdAt: 1, updatedAt: 2, sceneCount: 0, stage: {}, scenes: [] }, media: [] };

  it('接受完整信封', () => {
    expect(isCoursePayload(payload)).toBe(true);
  });

  it('scenes 不是数组时拒绝——这是渲染循环唯一强依赖的字段', () => {
    expect(isCoursePayload({ course: { ...payload.course, scenes: null }, media: [] })).toBe(false);
  });

  it('media 必须是数组且每一项合法', () => {
    expect(isCoursePayload({ course: payload.course, media: null })).toBe(false);
    expect(isCoursePayload({ course: payload.course, media: [{ url: 'x', kind: 'nope', count: 1 }] })).toBe(false);
  });
});
