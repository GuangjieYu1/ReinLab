import { useEffect, useMemo, useState } from 'react';
import { SlideCanvas } from '@openmaic/renderer';
import type { PPTElement, Slide } from '@openmaic/dsl';
import { D4, LESSON } from './model';

// 课堂（OpenMAIC 讲法）：用 OpenMAIC 的 SlideCanvas 原生渲染幻灯片，下面是 AI 老师的讲解字幕。
// 幻灯片数据在本地按莱茵生命版式生成；D₄ 的示意图是精确的——每个小正方形标出「左上角（橙）」和「右上角（墨）」被操作送到哪里。

type Corner = 'TL' | 'TR' | 'BR' | 'BL';
// 左上角与右上角的去向：R 为逆时针 90°，F 为关于竖直轴的翻折，RF 表示先 F 后 R。
const MAP: Record<string, [Corner, Corner]> = { e: ['TL', 'TR'], R: ['BL', 'TL'], 'R²': ['BR', 'BL'], 'R³': ['TR', 'BR'], F: ['TR', 'TL'], RF: ['TL', 'BL'], 'R²F': ['BL', 'BR'], 'R³F': ['BR', 'TR'] };
const INK = '#141213', ACC = '#ff7a1a', PAPER = '#f0eeea';
const text = (id: string, left: number, top: number, width: number, height: number, html: string, color = INK, font = 'Archivo'): PPTElement =>
  ({ type: 'text', id, left, top, width, height, rotate: 0, content: html, defaultFontName: font, defaultColor: color } as PPTElement);
const shape = (id: string, left: number, top: number, width: number, height: number, fill: string, outline?: string, path = 'M0 0 L200 0 L200 200 L0 200 Z'): PPTElement =>
  ({ type: 'shape', id, left, top, width, height, rotate: 0, viewBox: [200, 200], path, fixedRatio: false, fill, outline: outline ? { style: 'solid', width: 2, color: outline } : undefined } as PPTElement);
function square(id: string, x: number, y: number, s: number, el: string): PPTElement[] {
  const [a, b] = MAP[el], pos = (c: Corner) => ({ TL: [x, y], TR: [x + s, y], BR: [x + s, y + s], BL: [x, y + s] }[c]);
  const d = 12, [ax, ay] = pos(a), [bx, by] = pos(b);
  return [shape(`${id}-sq`, x, y, s, s, '#fbfbf9', INK), shape(`${id}-a`, ax - d / 2, ay - d / 2, d, d, ACC), shape(`${id}-b`, bx - d / 2 + 2, by - d / 2 + 2, d - 4, d - 4, INK),
    text(`${id}-l`, x - 10, y + s + 6, s + 20, 26, `<p style="text-align:center;font-size:15px;font-family:'IBM Plex Mono'">${el}</p>`)];
}

function build(i: number): Slide {
  const l = LESSON[i];
  const els: PPTElement[] = [
    shape('bar', 0, 0, 10, 562, ACC),
    text('meta', 50, 26, 600, 24, `<p style="font-size:12px;letter-spacing:2px;font-family:'IBM Plex Mono'">U1 · 对称与群 · ${String(i + 1).padStart(2, '0')} / ${String(LESSON.length).padStart(2, '0')}</p>`, '#6b6865'),
    text('title', 50, 58, 520, 70, `<p style="font-size:34px;font-weight:800">${l.title}</p>`),
    text('sub', 50, 118, 520, 30, `<p style="font-size:17px">${l.sub}</p>`, '#3a3837', 'Noto Serif SC'),
  ];
  if (l.src) els.push(text('src', 50, 520, 600, 22, `<p style="font-size:12px;font-family:'IBM Plex Mono'">出处 · ${l.src}</p>`, '#9a9792'));
  if (i === 0) els.push(...square('s0', 640, 150, 220, 'e'), text('t0', 610, 420, 300, 60, '<p style="font-size:15px">哪些动作做完之后，正方形看起来没变？</p>', '#3a3837', 'Noto Serif SC'));
  if (i === 1) D4.forEach((el, k) => els.push(...square(`d${k}`, 80 + (k % 4) * 140, 200 + Math.floor(k / 4) * 150, 92, el)));
  if (i === 1) els.push(text('key', 640, 160, 320, 60, '<p style="font-size:13px">橙点：左上角去哪了　墨点：右上角去哪了</p>', '#6b6865'));
  if (i === 2) els.push(...square('a', 120, 220, 130, 'F'), text('op', 290, 260, 60, 50, '<p style="font-size:36px">∘</p>'), ...square('b', 360, 220, 130, 'R'), text('eq', 530, 260, 60, 50, '<p style="font-size:36px">=</p>'), ...square('c', 600, 220, 130, 'RF'),
    text('n2', 120, 420, 700, 40, '<p style="font-size:15px">RF：先做 F，再做 R。结果是一次翻折（沿过左上角的对角线）。</p>', '#3a3837', 'Noto Serif SC'));
  if (i === 3) ['封闭', '结合', '单位元', '逆元'].forEach((k, n) => els.push(shape(`ax${n}`, 60 + n * 220, 220, 196, 150, n === 1 ? '#fbfbf9' : '#fbfbf9', INK), text(`axt${n}`, 76 + n * 220, 236, 170, 120,
    `<p style="font-size:24px;font-weight:800">${k}</p><p style="font-size:13px;font-family:'IBM Plex Mono'">${['a·b ∈ G', '(a·b)·c = a·(b·c)', 'e·a = a·e = a', 'a·a⁻¹ = e'][n]}</p>`)));
  if (i === 3) els.push(text('nt', 60, 400, 860, 30, '<p style="font-size:15px">没有第五条：交换律 a·b = b·a 不是公理。</p>', ACC, 'Noto Serif SC'));
  if (i === 4) els.push(...square('rf', 160, 220, 150, 'RF'), text('ne', 360, 250, 120, 80, '<p style="font-size:48px;font-weight:800">≠</p>', ACC), ...square('fr', 520, 220, 150, 'R³F'),
    text('frl', 500, 410, 220, 28, '<p style="font-size:13px;font-family:\'IBM Plex Mono\'">F·R = R³F</p>', '#6b6865'));
  if (i === 5) ['用例子理解，用定义判断', '定义只要求四条公理', 'D₄ 有 8 个元素，而且不交换', '下一步：练习 E1–E3，再做单元考核'].forEach((t, n) => els.push(text(`sm${n}`, 60, 200 + n * 62, 820, 50, `<p style="font-size:22px"><span style="color:${ACC}">■ </span>${t}</p>`, INK, 'Noto Serif SC')));
  return { id: `u1-${i}`, viewportSize: 1000, viewportRatio: .5625, theme: { backgroundColor: PAPER, themeColors: [INK, ACC], fontColor: INK, fontName: 'Archivo' }, background: { type: 'solid', color: PAPER }, elements: els };
}

export default function Classroom({ page, onPage, onAsk, reduced }: { page: number; onPage: (n: number) => void; onAsk: (context: string) => void; reduced: boolean }) {
  const slide = useMemo(() => build(page), [page]);
  const say = LESSON[page].say;
  const [n, setN] = useState(0);
  useEffect(() => {
    setN(reduced ? say.length : 0); if (reduced) return;
    const id = window.setInterval(() => setN(v => { if (v >= say.length) { clearInterval(id); return v; } return v + 1; }), 38);
    return () => clearInterval(id);
  }, [page, say, reduced]);
  return <div className="cu-class">
    <div className="cu-slide"><SlideCanvas slide={slide} chrome={false} canvasPercentage={96} /></div>
    <div className="cu-teacher">
      <span className="cu-avatar">AI<i data-talk={n < say.length || undefined} /></span>
      <p>{say.slice(0, n)}{n < say.length && <i className="cu-caret" />}</p>
      <div className="cu-teacher-act">
        <button onClick={() => onPage(Math.max(0, page - 1))} disabled={page === 0} aria-label="上一页">◀</button>
        <b>{String(page + 1).padStart(2, '0')} / {String(LESSON.length).padStart(2, '0')}</b>
        <button onClick={() => onPage(Math.min(LESSON.length - 1, page + 1))} disabled={page === LESSON.length - 1} aria-label="下一页">▶</button>
        <button className="rh-btn" onClick={() => onAsk(`课堂 · 第 ${page + 1} 页「${LESSON[page].title}」`)}>就这页提问</button>
      </div>
    </div>
  </div>;
}
