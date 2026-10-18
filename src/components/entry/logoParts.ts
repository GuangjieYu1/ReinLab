// 把工作台标识按它自身的结构拆开：外圈（圆环、弧线、刻度）与中央图形的若干部件。
// 文档展开成工作台时，外圈落进顶栏，部件分别飞向各个面板——每个工作台的标识不同，拆法也不同。

export type LogoPiece = {
  src: string;                                  // 单独的 SVG（viewBox 裁到部件范围）
  box: { x: number; y: number; w: number; h: number }; // 在 320×320 标识坐标里的范围
};
export type LogoParts = { ring: LogoPiece; pieces: LogoPiece[] };

const SVG_NS = 'http://www.w3.org/2000/svg';
const SIZE = 320;
const cache = new Map<string, Element[]>();

/** 静态版本（.still）的直接子元素：前几项是外圈，刻度组之后是中央图形的部件。 */
function stillChildren(logo: string): Element[] {
  const hit = cache.get(logo); if (hit) return hit;
  const doc = new DOMParser().parseFromString(logo, 'image/svg+xml');
  const still = doc.querySelector('g.still');
  const kids = still ? [...still.children].filter(k => k.getAttribute('opacity') !== '0') : [];
  cache.set(logo, kids);
  return kids;
}

/** 在页面里临时画出这些元素，量出它们（含线宽余量）的范围。 */
function measure(groups: Element[][]): LogoPiece['box'][] {
  const host = document.createElementNS(SVG_NS, 'svg');
  host.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);
  host.setAttribute('style', 'position:absolute;left:-9999px;top:0;width:320px;height:320px;visibility:hidden;pointer-events:none');
  const gs = groups.map(els => { const g = document.createElementNS(SVG_NS, 'g'); els.forEach(e => g.appendChild(document.importNode(e, true))); host.appendChild(g); return g; });
  document.body.appendChild(host);
  const boxes = gs.map(g => { const b = g.getBBox(), pad = 6; return { x: b.x - pad, y: b.y - pad, w: b.width + pad * 2, h: b.height + pad * 2 }; });
  host.remove();
  return boxes;
}

function toSrc(logo: string, els: Element[], box: LogoPiece['box']) {
  const vars = logo.match(/\.rhine-mark\{[^}]*\}/)?.[0] ?? '';
  const body = els.map(e => new XMLSerializer().serializeToString(e)).join('');
  const svg = `<svg xmlns="${SVG_NS}" class="rhine-mark" viewBox="${box.x} ${box.y} ${box.w} ${box.h}" width="${box.w}" height="${box.h}"><style>${vars}</style>${body}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** 拆成外圈 + 至多 count 组部件（按原顺序连续分组，相邻的部件留在一起）。 */
export function logoParts(logo: string, count: number): LogoParts | null {
  const kids = stillChildren(logo);
  const ticks = kids.findIndex(k => k.tagName === 'g' && k.children.length >= 12);
  if (ticks < 0 || kids.length - ticks - 1 < 1) return null;
  const ringEls = kids.slice(0, ticks + 1), motif = kids.slice(ticks + 1);
  const n = Math.max(1, Math.min(count, motif.length));
  const groups: Element[][] = Array.from({ length: n }, (_, i) => motif.slice(Math.floor(i * motif.length / n), Math.floor((i + 1) * motif.length / n)));
  const boxes = measure([ringEls, ...groups]);
  return {
    ring: { src: toSrc(logo, ringEls, boxes[0]), box: boxes[0] },
    pieces: groups.map((g, i) => ({ src: toSrc(logo, g, boxes[i + 1]), box: boxes[i + 1] })),
  };
}
