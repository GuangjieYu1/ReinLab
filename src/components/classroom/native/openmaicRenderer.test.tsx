import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SlideCanvas } from '@openmaic/renderer';
import type { Slide } from '@openmaic/dsl';

/**
 * 可行性验证：ReinLab 能否原生渲染 OpenMAIC 的课堂幻灯片。
 *
 * 结论若成立，学习通道就不必跳转到外部页面，可以直接用 React 渲染课程数据。
 * 这个测试同时充当版本漂移的哨兵：@openmaic/renderer 升级后若破坏
 * React 19 / node 环境下的渲染，这里会先失败。
 *
 * 注意：必须显式传 scale，省略时 renderer 会尝试测量容器做自适应，
 * 而 node 环境没有容器可测。
 */
const slide: Slide = {
  id: 'verify-group-theory',
  viewportSize: 1000,
  viewportRatio: 0.5625,
  theme: {
    backgroundColor: '#faf9f5',
    themeColors: ['#5b8def', '#8ea773'],
    fontColor: '#222222',
    fontName: 'sans-serif',
  },
  elements: [
    {
      type: 'text',
      id: 'title',
      left: 80,
      top: 70,
      width: 700,
      height: 120,
      rotate: 0,
      content: '<p style="font-size:34px;">群论 · 对称操作</p>',
      defaultFontName: 'sans-serif',
      defaultColor: '#222222',
    },
    {
      type: 'text',
      id: 'body',
      left: 80,
      top: 210,
      width: 700,
      height: 160,
      rotate: 0,
      content: '<p style="font-size:18px;">正方形的四个顶点一起追踪，观察旋转与反射如何复合。</p>',
      defaultFontName: 'sans-serif',
      defaultColor: '#4a4a45',
    },
  ],
};

describe('@openmaic/renderer 原生渲染可行性', () => {
  it('在 React 19 + node 环境下能渲染出幻灯片内容', () => {
    const markup = renderToStaticMarkup(<SlideCanvas slide={slide} scale={1} />);
    expect(markup).toContain('群论');
    expect(markup).toContain('对称操作');
    expect(markup).toContain('四个顶点');
    expect(markup.length).toBeGreaterThan(300);
  });

  it('渲染出的是真实 DOM 结构，而不是空壳', () => {
    const markup = renderToStaticMarkup(<SlideCanvas slide={slide} scale={1} />);
    // 至少应当出现元素定位（left/top）与文本容器
    expect(markup).toMatch(/left:\s*80px/);
    expect(markup).toMatch(/<div|<span|<p/);
  });
});
