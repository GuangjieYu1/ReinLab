import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import NativeCourse, { SceneSurface } from './NativeCourse';
import NativeCourseLibrary, { progressText, progressWidth } from './NativeCourseLibrary';
import type { RemoteScene } from './courseApi';

/**
 * 课程数据 → 屏幕上的东西，这条链路上唯一有分支的一段。
 *
 * 与 openmaicRenderer.test.tsx 一样，这里同时充当版本漂移的哨兵：@openmaic/renderer
 * 升级后若改变渲染契约，第一个失败的就是它。
 */
const slideScene: RemoteScene = {
  id: 'scene-1',
  title: '群论 · 对称操作',
  order: 0,
  type: 'slide',
  content: {
    type: 'slide',
    canvas: {
      id: 'canvas-1',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      theme: { backgroundColor: '#faf9f5', themeColors: ['#5b8def'], fontColor: '#222222', fontName: 'sans-serif' },
      elements: [
        { type: 'text', id: 'title', left: 80, top: 70, width: 700, height: 120, rotate: 0, content: '<p style="font-size:34px;">群论 · 对称操作</p>', defaultFontName: 'sans-serif', defaultColor: '#222222' },
        { type: 'image', id: 'figure', left: 80, top: 210, width: 300, height: 200, rotate: 0, src: 'https://cdn.example.com/square.png' },
      ],
    },
  },
};

const noop = () => {};

describe('场景画面', () => {
  it('幻灯片场景真的渲染出内容，而不是空壳', () => {
    const markup = renderToStaticMarkup(<SceneSurface scene={slideScene} mediaMap={new Map()} onOpenOnline={noop} />);
    expect(markup).toContain('群论');
    expect(markup).toContain('对称操作');
    expect(markup).toMatch(/left:\s*80px/);
  });

  it('媒体地址被换成本地地址后渲染的是本地地址', () => {
    const map = new Map([['https://cdn.example.com/square.png', 'blob:local-square']]);
    const markup = renderToStaticMarkup(<SceneSurface scene={slideScene} mediaMap={map} onOpenOnline={noop} />);
    expect(markup).toContain('blob:local-square');
    expect(markup).not.toContain('https://cdn.example.com/square.png');
  });

  it('没有本地副本时保持远端地址，在线读取照常显示', () => {
    const markup = renderToStaticMarkup(<SceneSurface scene={slideScene} mediaMap={new Map()} onOpenOnline={noop} />);
    expect(markup).toContain('https://cdn.example.com/square.png');
  });

  it('测验场景以只读形式给出题目，离线也能看', () => {
    const quiz: RemoteScene = {
      id: 'q1', title: '核验与反馈', order: 1, type: 'quiz',
      content: { type: 'quiz', questions: [{ id: 'a', question: '交换律是群的必要条件吗？', options: [{ label: '是', value: 'y' }, { label: '不是', value: 'n' }] }] },
    };
    const markup = renderToStaticMarkup(<SceneSurface scene={quiz} mediaMap={new Map()} onOpenOnline={noop} />);
    expect(markup).toContain('交换律是群的必要条件吗？');
    expect(markup).toContain('不是');
    expect(markup).toContain('不记录作答');
  });

  it('交互式场景如实说明无法离线渲染，并给出在线入口', () => {
    const interactive: RemoteScene = { id: 'i1', title: '对称操作模拟', order: 2, type: 'interactive', content: { type: 'interactive' } };
    const markup = renderToStaticMarkup(<SceneSurface scene={interactive} mediaMap={new Map()} onOpenOnline={noop} />);
    expect(markup).toContain('交互页面');
    expect(markup).toContain('无法在离线状态下原生渲染');
    expect(markup).toContain('在在线课堂中打开');
  });

  it('场景类型未知时也不会崩，而是给出说明', () => {
    const unknown: RemoteScene = { id: 'u1', title: '未来的场景', order: 3, type: 'hologram' };
    const markup = renderToStaticMarkup(<SceneSurface scene={unknown} mediaMap={new Map()} onOpenOnline={noop} />);
    expect(markup).toContain('未来的场景');
    expect(markup).toContain('未知类型');
  });
});

describe('课程读取中', () => {
  it('先给出明确的加载态，而不是空白', () => {
    const markup = renderToStaticMarkup(<NativeCourse courseId="stage-1" origin="http://127.0.0.1:3000" reduced onBack={noop} onOpenOnline={noop} notify={noop} />);
    expect(markup).toContain('正在打开课程');
  });
});

describe('课程档案页', () => {
  it('未配置地址时说明去哪里填，而不是给一个空列表', () => {
    const markup = renderToStaticMarkup(<NativeCourseLibrary origin="" onOpen={noop} onOpenOnline={noop} onOpenSettings={noop} notify={noop} />);
    expect(markup).toContain('课程档案');
    expect(markup).toContain('还没有填写 OpenMAIC 地址');
    expect(markup).toContain('前往终端设置填写');
  });

  it('已配置地址时给出在线课程库入口与本机存储状态', () => {
    const markup = renderToStaticMarkup(<NativeCourseLibrary origin="http://192.168.1.10:3000" onOpen={noop} onOpenOnline={noop} onOpenSettings={noop} notify={noop} />);
    expect(markup).toContain('在线课程库');
    // node 环境没有 IndexedDB：这一行说明界面在存储不可用时是自知的。
    expect(markup).toContain('本机存储不可用');
    expect(markup).not.toContain('还没有填写 OpenMAIC 地址');
  });
});

describe('下载进度文案', () => {
  it('三个阶段的宽度单调推进', () => {
    expect(progressWidth({ phase: 'course', done: 0, total: 1, bytes: 0, failed: 0 })).toBe(2);
    expect(progressWidth({ phase: 'course', done: 1, total: 1, bytes: 0, failed: 0 })).toBe(8);
    expect(progressWidth({ phase: 'media', done: 0, total: 10, bytes: 0, failed: 0 })).toBe(8);
    expect(progressWidth({ phase: 'media', done: 5, total: 10, bytes: 0, failed: 0 })).toBe(54);
    expect(progressWidth({ phase: 'media', done: 10, total: 10, bytes: 0, failed: 0 })).toBe(99);
    expect(progressWidth({ phase: 'saving', done: 0, total: 1, bytes: 0, failed: 0 })).toBe(100);
  });

  it('媒体数为 0 时不会除零', () => {
    expect(progressWidth({ phase: 'media', done: 0, total: 0, bytes: 0, failed: 0 })).toBe(8);
  });

  it('如实报出失败数量，而不是假装下载完整', () => {
    expect(progressText({ phase: 'media', done: 3, total: 10, bytes: 2048, failed: 2 })).toContain('2 个失败');
    expect(progressText({ phase: 'saving', done: 1, total: 1, bytes: 1024 * 1024, failed: 1 })).toContain('1 个资源缺失');
    expect(progressText({ phase: 'course', done: 0, total: 1, bytes: 0, failed: 0 })).toBe('正在读取课程数据…');
  });
});
