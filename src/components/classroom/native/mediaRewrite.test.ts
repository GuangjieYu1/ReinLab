import { describe, expect, it } from 'vitest';
import { collectRemoteMediaUrls, formatBytes, isCacheableMediaUrl, looksLikeMediaUrl, mediaKey, orderMediaForDownload, rewriteMediaUrls } from './mediaRewrite';

/**
 * 媒体地址替换是离线能力的地基：替换漏一个，课程离线时那个位置就是空白，
 * 而这类缺陷在真机上很难一眼看出来。所以这里把「精确匹配」「不改原数据」
 * 「按类型排序」这几条逐个钉死。
 */
describe('课程媒体地址替换', () => {
  const map = new Map([
    ['https://cdn.example.com/a.png', 'blob:local-a'],
    ['https://cdn.example.com/a.png?v=2', 'blob:local-a2'],
  ]);

  it('精确匹配才替换，前缀相同不会被误伤', () => {
    const course = { src: 'https://cdn.example.com/a.png', other: 'https://cdn.example.com/a.png?v=2', untouched: 'https://cdn.example.com/a.png?v=3' };
    const next = rewriteMediaUrls(course, map);
    expect(next.src).toBe('blob:local-a');
    expect(next.other).toBe('blob:local-a2');
    // 清单里没有这个地址：保持原样，绝不因为「前缀一样」就替换成 blob:local-a。
    expect(next.untouched).toBe('https://cdn.example.com/a.png?v=3');
  });

  it('递归到嵌套数组与对象，并保留非字符串字段', () => {
    const scenes = [{ id: 's1', content: { type: 'slide', canvas: { elements: [{ type: 'image', src: 'https://cdn.example.com/a.png', left: 10, rotate: 0 }] } } }];
    const next = rewriteMediaUrls(scenes, map);
    const element = next[0].content.canvas.elements[0];
    expect(element.src).toBe('blob:local-a');
    expect(element.left).toBe(10);
    expect(element.rotate).toBe(0);
    expect(element.type).toBe('image');
  });

  it('不修改入参：同一份课程要在「在线」和「已下载」之间来回切换', () => {
    const course = { src: 'https://cdn.example.com/a.png' };
    const next = rewriteMediaUrls(course, map);
    expect(course.src).toBe('https://cdn.example.com/a.png');
    expect(next).not.toBe(course);
  });

  it('空映射直接返回原引用，避免每次渲染都白克隆一遍课程', () => {
    const course = { src: 'https://cdn.example.com/a.png' };
    expect(rewriteMediaUrls(course, new Map())).toBe(course);
  });

  it('替换后仍然指向远端的地址会被收集出来，供界面如实提示', () => {
    const course = { a: 'https://cdn.example.com/a.png', b: 'https://cdn.example.com/missing.mp4', c: 'blob:already-local', d: 'data:image/png;base64,AAA' };
    const next = rewriteMediaUrls(course, map);
    expect(collectRemoteMediaUrls(next)).toEqual(['https://cdn.example.com/missing.mp4']);
  });

  it('只有 http/https 需要缓存；data: 与 blob: 自带内容', () => {
    expect(isCacheableMediaUrl('https://x/y.png')).toBe(true);
    expect(isCacheableMediaUrl('HTTP://x/y.png')).toBe(true);
    expect(isCacheableMediaUrl('blob:https://x/abc')).toBe(false);
    expect(isCacheableMediaUrl('data:image/png;base64,AAA')).toBe(false);
    expect(isCacheableMediaUrl('placeholder:task-1')).toBe(false);
  });

  it('CDN 上的脚本与样式不算课程媒体：真实课程里交互场景引用了 KaTeX CDN', () => {
    // 这组地址取自本机真实课程 stage-8iCl_d9LOw 的 23 个场景。
    const course = {
      html: '<link href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css"><script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>',
      image: 'https://cdn.example.com/roman-forum.jpg',
    };
    expect(collectRemoteMediaUrls(course)).toEqual(['https://cdn.example.com/roman-forum.jpg']);
  });

  it('没有扩展名的课程媒体地址靠路径识别', () => {
    expect(looksLikeMediaUrl('http://192.168.1.10:3000/api/classroom-media/stage-abc/9f3a2b1c')).toBe(true);
    expect(looksLikeMediaUrl('https://cdn.example.com/pic.png?v=2')).toBe(true);
    expect(looksLikeMediaUrl('https://cdn.example.com/clip.webm')).toBe(true);
    expect(looksLikeMediaUrl('https://cdn.example.com/track.m4a')).toBe(true);
  });

  it('脚本、样式、字体与数据文件一律不算媒体', () => {
    for (const url of [
      'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css',
      'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/auto-render.min.js',
      'https://fonts.example.com/noto.woff2',
      'https://api.example.com/course.json',
      'blob:https://x/abc',
    ]) expect(looksLikeMediaUrl(url)).toBe(false);
  });

  it('缓存键把课程与地址绑在一起，两门课引用同一张图不会互相覆盖', () => {
    expect(mediaKey('c1', 'https://x/y.png')).toBe('c1::https://x/y.png');
    expect(mediaKey('c1', 'https://x/y.png')).not.toBe(mediaKey('c2', 'https://x/y.png'));
  });

  it('下载顺序把图片排在视频前面：中途取消时课程至少是「能看的」', () => {
    const ordered = orderMediaForDownload([
      { url: 'v1', kind: 'video' },
      { url: 'a1', kind: 'audio' },
      { url: 'p1', kind: 'poster' },
      { url: 'i1', kind: 'image' },
      { url: 'i2', kind: 'image' },
    ]);
    expect(ordered.map(item => item.url)).toEqual(['i1', 'i2', 'p1', 'a1', 'v1']);
  });

  it('体积文案覆盖 KB / MB / GB 三档', () => {
    expect(formatBytes(0)).toBe('0 MB');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2.00 GB');
  });
});
