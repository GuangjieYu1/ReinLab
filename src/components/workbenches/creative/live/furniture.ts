// 明清家具库（试做）：照 Blockout 的思路，家具用代码按参数生成——给一个外框（宽 × 高 × 深，米），拆成几块木板、腿、面。
// 比方块像，比真 3D 模型轻，天然能复用。部件局部坐标：x 宽、y 高（从地面起）、z 深，正面朝 +z。
// 按部件名认是哪件家具；认不出就照旧画成一个方块。

export type RGB = [number, number, number];
export type Part = { k: 'box' | 'cyl'; x: number; y: number; z: number; w: number; h: number; d: number; col: RGB };

const WOOD: RGB = [128, 84, 52], WOOD_L: RGB = [156, 110, 70], WOOD_D: RGB = [92, 58, 36], LACQ: RGB = [138, 46, 36];
const IRON: RGB = [64, 64, 66], BRICK: RGB = [120, 108, 98], PAPER: RGB = [232, 220, 188], CLAY: RGB = [150, 104, 72], GOLD: RGB = [190, 150, 70];
const box = (x: number, y: number, z: number, w: number, h: number, d: number, col: RGB): Part => ({ k: 'box', x, y, z, w, h, d, col });
const cyl = (x: number, y: number, z: number, r: number, h: number, col: RGB): Part => ({ k: 'cyl', x, y, z, w: r * 2, h, d: r * 2, col });

/** 四条腿 + 面板 + 牙板：八仙桌、方凳、条案共用。 */
function tableLike(w: number, h: number, d: number, top = .05, leg = .06, col = WOOD): Part[] {
  const lx = w / 2 - leg / 2 - .02, lz = d / 2 - leg / 2 - .02, t = Math.min(top, h * .12);
  return [box(0, h - t, 0, w, t, d, col), box(0, h - t - .07, d / 2 - .03, w - .06, .06, .02, WOOD_D), box(0, h - t - .07, -d / 2 + .03, w - .06, .06, .02, WOOD_D),
    ...[[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => box(a * lx, 0, b * lz, leg, h - t, leg, WOOD_D))];
}

export const FURNITURE: { name: string; re: RegExp; make: (w: number, h: number, d: number) => Part[] }[] = [
  { name: '灯', re: /灯笼|油灯|灯/, make: (w, h, d) => [box(0, 0, 0, w * .6, .03, d * .6, IRON), box(0, .03, 0, .02, h * .6, .02, IRON), cyl(0, h * .6, 0, Math.min(w, d) * .3, h * .35, [240, 196, 120])] },
  { name: '匾额', re: /匾/, make: (w, h, d) => [box(0, 0, 0, w, h, d, WOOD_D), box(0, h * .15, d / 2, w * .9, h * .7, .01, GOLD)] },
  { name: '坛', re: /坛|缸|瓮/, make: (w, h, d) => [cyl(0, 0, 0, Math.min(w, d) * .35, h * .15, CLAY), cyl(0, h * .15, 0, Math.min(w, d) * .5, h * .6, CLAY), cyl(0, h * .75, 0, Math.min(w, d) * .25, h * .25, CLAY)] },
  { name: '货架', re: /货架|博古架|架子|柜(?!台)|橱/, make: (w, h, d) => { const n = Math.max(2, Math.round(h / .45)); return [box(-w / 2 + .03, 0, 0, .05, h, d, WOOD_D), box(w / 2 - .03, 0, 0, .05, h, d, WOOD_D), box(0, 0, -d / 2 + .015, w, h, .03, WOOD),
    ...Array.from({ length: n + 1 }, (_, i) => box(0, i * (h - .04) / n, 0, w - .06, .04, d, WOOD_D)),
    ...Array.from({ length: n }, (_, i) => [cyl(-w / 4, i * (h - .04) / n + .04, 0, Math.min(.09, d / 3), .18, CLAY), box(w / 5, i * (h - .04) / n + .04, 0, .22, .12, Math.min(.2, d * .7), PAPER)]).flat()]; } },
  { name: '碗架', re: /碗架|碗/, make: (w, h, d) => [box(-w / 2 + .03, 0, 0, .04, h, d, WOOD_D), box(w / 2 - .03, 0, 0, .04, h, d, WOOD_D),
    ...[0, 1, 2].map(i => box(0, .1 + i * (h - .14) / 2, 0, w - .06, .03, d, WOOD)), ...[0, 1, 2].flatMap(i => [-.3, 0, .3].map(f => cyl(f * w, .13 + i * (h - .14) / 2, 0, .07, .06, [196, 190, 172] as RGB)))] },
  { name: '柜台', re: /柜台/, make: (w, h, d) => [box(0, 0, 0, w, .08, d - .04, WOOD_D), box(0, .08, 0, w - .04, h - .14, d - .08, WOOD),
    ...[-1, 0, 1].map(i => box(i * w / 3, .2, d / 2 - .03, w / 3 - .12, h - .4, .02, WOOD_L)), box(0, h - .06, .02, w + .06, .06, d + .02, WOOD_D)] },
  { name: '茶炉', re: /茶炉|炉|灶/, make: (w, h, d) => [box(0, 0, 0, w, h * .75, d, BRICK), box(0, h * .75, 0, w * .9, .05, d * .9, IRON), box(0, h * .2, d / 2 - .01, w * .4, h * .25, .02, [40, 30, 28]),
    cyl(0, h * .8, 0, Math.min(w, d) * .28, h * .2, IRON), cyl(w * .3, h * .75, -d * .3, .05, h * .9, IRON)] },
  { name: '长凳', re: /长凳|条凳|板凳/, make: (w, h, d) => [box(0, h - .06, 0, w, .06, d, WOOD), ...[-1, 1].flatMap(a => [box(a * (w / 2 - .12), 0, -d / 2 + .06, .05, h - .06, .05, WOOD_D), box(a * (w / 2 - .12), 0, d / 2 - .06, .05, h - .06, .05, WOOD_D)]), box(0, h * .35, 0, w - .3, .04, .04, WOOD_D)] },
  { name: '方凳', re: /方凳|凳/, make: (w, h, d) => tableLike(w, h, d, .05, .045) },
  { name: '椅', re: /椅/, make: (w, h, d) => [...tableLike(w, h * .45, d, .05, .045), box(0, h * .45, -d / 2 + .03, w, h * .55, .04, WOOD), box(0, h * .95, -d / 2 + .03, w + .06, .05, .06, WOOD_D)] },
  { name: '条案', re: /条案|案/, make: (w, h, d) => [...tableLike(w, h, d, .06, .06, WOOD_D), box(-w / 2 - .06, h - .06, 0, .12, .1, d, WOOD_D), box(w / 2 + .06, h - .06, 0, .12, .1, d, WOOD_D)] },
  { name: '八仙桌', re: /八仙桌|方桌|桌/, make: (w, h, d) => tableLike(w, h, d) },
  { name: '屏风', re: /屏风/, make: (w, h, d) => { const n = 4, pw = w / n; return Array.from({ length: n }, (_, i) => [box(-w / 2 + pw * (i + .5), 0, 0, pw - .02, h, Math.max(.03, d), WOOD_D), box(-w / 2 + pw * (i + .5), .15, .005, pw - .1, h - .3, Math.max(.03, d) * .6, PAPER)]).flat(); } },
  { name: '门', re: /门(?!厅|外|槛|楣)|门扇/, make: (w, h, d) => [box(-w / 2 + .05, 0, 0, .1, h, d + .04, WOOD_D), box(w / 2 - .05, 0, 0, .1, h, d + .04, WOOD_D), box(0, h - .1, 0, w, .1, d + .04, WOOD_D),
    box(-w / 4 + .02, 0, 0, w / 2 - .12, h - .1, d, LACQ), box(w / 4 - .02, 0, 0, w / 2 - .12, h - .1, d, LACQ), ...[-1, 1].map(a => cyl(a * .08, h * .5, d / 2 + .01, .03, .03, GOLD))] },
  { name: '窗', re: /窗/, make: (w, h, d) => [box(0, 0, 0, w, .06, d, WOOD_D), box(0, h - .06, 0, w, .06, d, WOOD_D), box(-w / 2 + .03, 0, 0, .06, h, d, WOOD_D), box(w / 2 - .03, 0, 0, .06, h, d, WOOD_D),
    box(0, .06, 0, w - .12, h - .12, d * .3, PAPER), ...[1, 2, 3].map(i => box(-w / 2 + i * w / 4, .06, d * .2, .025, h - .12, d * .4, WOOD_D)), ...[1, 2, 3].map(i => box(0, i * h / 4, d * .2, w - .12, .025, d * .4, WOOD_D))] },
];

/** 按部件名找家具；认不出返回 null（照旧画方块）。 */
export function furnitureOf(label?: string | null) { return label ? FURNITURE.find(f => f.re.test(label)) ?? null : null; }

/** 场景模板：客栈门厅。按房间轮廓的外接矩形摆（门在南墙 +z 正中）。返回白模部件（底面中心坐标，rotY 度：0 正面朝 +z，270 正面朝 -x）。 */
export function innLobbyTemplate(outline: [number, number][], height: number) {
  const xs = outline.map(p => p[0]), zs = outline.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs), W = x1 - x0, D = z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, H = height;
  const P = (label: string, kind: 'box' | 'cylinder', c: [number, number, number], s: [number, number, number], rotY = 0, material?: string, extra: Record<string, unknown> = {}) => ({ label, kind, c, s, rotY, ...(material ? { material } : {}), ...extra });
  const door = Math.min(1.8, W * .25), seg = (W - door) / 2;
  return [
    P('青砖地面', 'box', [cx, 0, cz], [W, .02, D], 0, 'stone'),
    P('北墙', 'box', [cx, 0, z0], [W, H, .2], 0, 'plaster'), P('西墙', 'box', [x0, 0, cz], [.2, H, D], 0, 'plaster'), P('东墙', 'box', [x1, 0, cz], [.2, H, D], 0, 'plaster'),
    P('南墙西段', 'box', [x0 + seg / 2, 0, z1], [seg, H, .2], 0, 'plaster'), P('南墙东段', 'box', [x1 - seg / 2, 0, z1], [seg, H, .2], 0, 'plaster'),
    P('临街大门', 'box', [cx, 0, z1], [door, Math.min(2.6, H - .3), .12], 0, 'wood'),
    P('门外石阶', 'box', [cx, 0, z1 + .9], [door + 1.2, .12, 1.4], 0, 'stone', { outside: true }),
    P('顶棚', 'box', [cx, H - .1, cz], [W, .1, D], 0, 'tile'),
    P('西墙花窗', 'box', [x0 + .12, 1.0, cz - D * .15], [1.2, 1.1, .08], 90, 'wood'),
    P('柜台', 'box', [x1 - 1.1, 0, z0 + D * .32], [Math.min(3.2, D * .45), 1.0, .6], 270, 'wood'),
    P('柜台后货架', 'box', [x1 - .3, 0, z0 + D * .32], [Math.min(3.4, D * .48), Math.min(2.2, H - .5), .35], 270, 'wood'),
    P('柜台油灯', 'box', [x1 - 1.1, 1.0, z0 + D * .32 - .6], [.18, .4, .18], 0, 'wood'),
    P('酒坛', 'cylinder', [x1 - 1.0, 0, z0 + D * .32 + D * .26], [.22, .55, 0], 0, 'stone'),
    P('茶炉', 'box', [x0 + .6, 0, z0 + .6], [.7, .9, .7], 0, 'stone'),
    P('碗架', 'box', [x0 + 1.75, 0, z0 + .25], [1.0, 1.4, .35], 0, 'wood'),
    P('条案', 'box', [cx - W * .05, 0, z0 + .3], [Math.min(2.0, W * .22), .85, .45], 0, 'wood'),
    P('匾额', 'box', [cx - W * .05, H - .75, z0 + .12], [1.6, .45, .06], 0, 'wood'),
    ...[-1, 1].flatMap(i => { const tx = cx + i * Math.min(1.5, W * .16) - W * .05, tz = cz + D * .12; return [
      P(`八仙桌${i < 0 ? '一' : '二'}`, 'box', [tx, 0, tz], [.95, .82, .95], 0, 'wood'),
      P(`长凳${i < 0 ? '一' : '三'}`, 'box', [tx, 0, tz - .75], [1.1, .46, .28], 0, 'wood'),
      P(`长凳${i < 0 ? '二' : '四'}`, 'box', [tx, 0, tz + .75], [1.1, .46, .28], 0, 'wood')]; }),
  ];
}
