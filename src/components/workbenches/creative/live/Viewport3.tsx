// MVP-3 白模视口（契约 §13.6）：Canvas 2D 软渲染（透视投影 + 背面剔除 + 画家算法），沿用示例视口的做法。
// 坐标：米；x 向右、y 向上、z 向镜头外。白模部件 c 是底面中心；box 的 s 是长宽高；cylinder / prism 的 s 是 [半径, 高, 0]。
// 人偶有头、躯干、长袍下摆、双臂双腿，有走位时走过去（摆臂迈腿）再转向（参考 Blockout：灰盒人偶要清楚、会动），高矮按 person.body，衣服颜色取立绘。部件按名字认材质上色。facing：度，0 = 朝 -z，顺时针（从上往下看）。
// 同一个 drawScene 既画屏幕上的视口，也画「录预演」的离屏画面，保证录到的就是看到的。
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { Shot, V3, WhiteboxPrim } from '../../../../../packages/contracts/src/creative';
import { furnitureOf } from './furniture';

export type Doll = { id: string; name: string; at: V3; to?: V3 | null; facing: number; heightM: number; build: 'slim' | 'average' | 'heavy' | null; ghost?: boolean; hi?: boolean; ai?: boolean;
  /** 衣服颜色（取立绘主色；没有立绘按人分一个固定色）。 */ color?: [number, number, number] };
export type Cam = Shot['camera'];
export type Mark = { ghost?: boolean; hi?: boolean; ai?: boolean };
type View = { eye: V3; target: V3; fov: number };

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const smooth = (t: number) => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x); };

/** 镜头在进度 t（0–1）时的机位：从 camera 平滑运到 end。 */
export function camAt(c: Cam, t: number): View {
  if (!c.end) return { eye: c.eye, target: c.target, fov: c.fov };
  const k = smooth(t); return { eye: lerp3(c.eye, c.end.eye, k), target: lerp3(c.target, c.end.target, k), fov: c.fov };
}

type RGB = [number, number, number];
type Face = { pts: V3[]; n: V3; col: RGB; m: Mark; alpha?: number; doll?: boolean; ground?: boolean; sub?: boolean };
function solid(c: V3, rotY: number, ring: [number, number][], h: number, col: RGB, m: Mark, o: { top?: number; doll?: boolean } = {}): Face[] {
  const r = (rotY * Math.PI) / 180, cs = Math.cos(r), sn = Math.sin(r), k = o.top ?? 1;
  const T = (x: number, y: number, z: number): V3 => [c[0] + x * cs + z * sn, c[1] + y, c[2] - x * sn + z * cs];
  const A = ring.map(([x, z]) => T(x, 0, z)), B = ring.map(([x, z]) => T(x * k, h, z * k));
  const faces: Face[] = [{ pts: A, n: [0, -1, 0], col, m, doll: o.doll }, { pts: B, n: [0, 1, 0], col, m, doll: o.doll }];
  const cen = add(c, [0, h / 2, 0]);
  for (let i = 0; i < A.length; i++) {
    const j = (i + 1) % A.length, pts = [A[i], A[j], B[j], B[i]];
    let n = norm(cross(sub(pts[1], pts[0]), sub(pts[2], pts[0])));
    const fc = mul(pts.reduce((s, v) => add(s, v), [0, 0, 0] as V3), 1 / 4); if (dot(n, sub(fc, cen)) < 0) n = mul(n, -1);
    faces.push({ pts, n, col, m, doll: o.doll });
  }
  return faces;
}
const circle = (r: number, n: number): [number, number][] => Array.from({ length: n }, (_, i) => { const a = (i / n) * Math.PI * 2; return [Math.cos(a) * r, Math.sin(a) * r]; });

/** 按部件名认材质上色（契约里还没有材质字段，先按名字里的字认）。 */
const MATERIALS: [RegExp, RGB][] = [
  [/河|水面|池|井/, [72, 122, 158]],
  [/城墙|垛|城楼|城门洞|墙身/, [126, 124, 118]],
  [/顶棚|屋顶|屋面|檐|瓦/, [78, 72, 70]],
  [/石|阶|街|路|地坪|巷/, [146, 146, 140]],
  [/门|窗|框|槛/, [128, 66, 46]],
  [/墙|壁|隔断/, [222, 212, 192]],
  [/柜|桌|椅|凳|床|架|案|箱|榻|台(?!阶)/, [152, 106, 66]],
  [/地面|地板|楼板/, [176, 140, 98]],
  [/树|草|花|竹|苔/, [88, 124, 72]],
  [/布|帘|幡|旗|灯笼/, [176, 62, 50]],
  [/屋|房|铺|排/, [168, 150, 128]],
];
const BY_MATERIAL: Record<NonNullable<WhiteboxPrim['material']>, RGB> = { plaster: [222, 212, 192], wood: [152, 106, 66], stone: [146, 146, 140], tile: [78, 72, 70], water: [72, 122, 158], plant: [88, 124, 72], cloth: [176, 62, 50], brick: [126, 124, 118] };
const hex = (c?: string | null): RGB | null => { const m = c && /^#?([0-9a-f]{6})$/i.exec(c.trim()); if (!m) return null; const n = parseInt(m[1], 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
/** 颜色：部件自带 color > material > 按名字认。 */
export const matOf = (label?: string | null, p?: Pick<WhiteboxPrim, 'material' | 'color'>): RGB => hex(p?.color) ?? (p?.material ? BY_MATERIAL[p.material] : null) ?? MATERIALS.find(([re]) => label && re.test(label))?.[1] ?? [194, 190, 182];
const isWall = (p: WhiteboxPrim) => !p.outside && ((p.from === 'shell' && p.s[1] > 1.5) || /墙|壁|隔断/.test(p.label ?? '') || p.material === 'plaster' || (p.kind === 'box' && p.s[1] > 2 && Math.min(p.s[0], p.s[2]) < .4));
const isRoof = (p: WhiteboxPrim) => /顶棚|屋顶|屋面|天花/.test(p.label ?? '') || (p.from === 'shell' && p.s[1] <= .3 && p.c[1] > 1.5);
const isGround = (p: WhiteboxPrim) => p.s[1] <= .06;

/** 大面切成小块再排序：整面墙按一个中心点排先后，会把站在墙前的人盖住（画家算法的老毛病）。 */
function tess(f: Face, maxLen = .7): Face[] {
  if (f.pts.length !== 4) return [f];
  const [a, b, c, d] = f.pts, nu = Math.max(1, Math.ceil(Math.hypot(...sub(b, a)) / maxLen)), nv = Math.max(1, Math.ceil(Math.hypot(...sub(d, a)) / maxLen));
  if (nu === 1 && nv === 1) return [f];
  const at = (u: number, v: number) => lerp3(lerp3(a, b, u), lerp3(d, c, u), v), out: Face[] = [];
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) out.push({ ...f, sub: true, pts: [at(i / nu, j / nv), at((i + 1) / nu, j / nv), at((i + 1) / nu, (j + 1) / nv), at(i / nu, (j + 1) / nv)] });
  return out;
}
function primFaces(p: WhiteboxPrim, m: Mark, alpha?: number): Face[] {
  // 认得出的家具：按参数拆成木板、腿、面（furniture.ts）；房间壳和认不出的照旧画方块
  const fur = p.from === 'shell' ? null : furnitureOf(p.label);
  if (fur) {
    const w = p.kind === 'box' ? p.s[0] : p.s[0] * 2, h = p.s[1], d = p.kind === 'box' ? p.s[2] : p.s[0] * 2, r = ((p.rotY ?? 0) * Math.PI) / 180, cs = Math.cos(r), sn = Math.sin(r);
    return fur.make(w, h, d).flatMap(q => {
      const c: V3 = [p.c[0] + q.x * cs + q.z * sn, p.c[1] + q.y, p.c[2] - q.x * sn + q.z * cs];
      const fs = q.k === 'cyl' ? solid(c, 0, circle(q.w / 2, 12), q.h, q.col, m) : solid(c, p.rotY ?? 0, [[-q.w / 2, -q.d / 2], [q.w / 2, -q.d / 2], [q.w / 2, q.d / 2], [-q.w / 2, q.d / 2]], q.h, q.col, m);
      return fs.map(f => ({ ...f, alpha }));
    });
  }
  const col = matOf(p.label, p);
  const fs = p.kind === 'box' ? solid(p.c, p.rotY ?? 0, [[-p.s[0] / 2, -p.s[2] / 2], [p.s[0] / 2, -p.s[2] / 2], [p.s[0] / 2, p.s[2] / 2], [-p.s[0] / 2, p.s[2] / 2]], p.s[1], col, m)
    : solid(p.c, p.rotY ?? 0, circle(p.s[0], p.kind === 'cylinder' ? 18 : Math.max(3, p.sides ?? 6)), p.s[1], col, m);
  return fs.flatMap(f => tess({ ...f, alpha, ground: isGround(p) }));
}
const RADIUS = { slim: .16, average: .2, heavy: .25 } as const;
const SKIN: RGB = [226, 192, 162], HAIR: RGB = [42, 38, 36], SHOE: RGB = [40, 36, 34];
/** 沿任意一段画一根圆柱（四肢用）。 */
function limb(a: V3, b: V3, r: number, col: RGB, m: Mark, n = 8): Face[] {
  const ax = norm(sub(b, a)); let u = cross(ax, [0, 1, 0]); if (Math.hypot(...u) < 1e-4) u = [1, 0, 0]; u = norm(u); const v = cross(ax, u);
  const ring = (c: V3) => Array.from({ length: n }, (_, i) => { const t = (i / n) * Math.PI * 2; return add(c, add(mul(u, Math.cos(t) * r), mul(v, Math.sin(t) * r))); });
  const A = ring(a), B = ring(b), mid = mul(add(a, b), .5);
  const fs: Face[] = [{ pts: [...A].reverse(), n: mul(ax, -1), col, m, doll: true }, { pts: B, n: ax, col, m, doll: true }];
  for (let i = 0; i < n; i++) { const j = (i + 1) % n, pts = [A[i], A[j], B[j], B[i]]; const fc = mul(pts.reduce((s2, x) => add(s2, x), [0, 0, 0] as V3), .25); fs.push({ pts, n: norm(sub(fc, mid)), col, m, doll: true }); }
  return fs;
}
/** 人偶在进度 t（0–1）时的姿态：有走位终点就在前 70% 走过去（摆臂迈腿），然后停下转向 facing。 */
export function dollPose(d: Doll, t: number): { at: V3; yaw: number; phase: number; walking: boolean } {
  if (!d.to) return { at: d.at, yaw: d.facing, phase: 0, walking: false };
  const p = smooth(Math.min(1, t / .7)), at = lerp3(d.at, d.to, p), dx = d.to[0] - d.at[0], dz = d.to[2] - d.at[2], dist = Math.hypot(dx, dz);
  const travel = (Math.atan2(dx, -dz) * 180) / Math.PI; // 0 = 朝 -z，顺时针
  const turn = Math.max(0, Math.min(1, (t - .7) / .15)), diff = ((d.facing - travel + 540) % 360) - 180;
  return { at, yaw: t < .7 ? travel : travel + diff * smooth(turn), phase: p * (dist / 1.3) * Math.PI * 2, walking: t < .7 && dist > .05 };
}
/** 人偶：头 + 发髻 + 躯干 + 长袍下摆 + 双臂 + 双腿（走路时摆臂迈腿）。衣服颜色取立绘。 */
function dollFaces(d: Doll, t: number): Face[] {
  const H = d.heightM || 1.7, r = RADIUS[d.build ?? 'average'], m: Mark = { ghost: d.ghost, hi: d.hi, ai: d.ai }, cloth = d.color ?? [120, 128, 120];
  const dark: RGB = [cloth[0] * .78, cloth[1] * .78, cloth[2] * .78], pants: RGB = [cloth[0] * .5, cloth[1] * .5, cloth[2] * .5];
  const { at, yaw, phase, walking } = dollPose(d, t), y = (yaw * Math.PI) / 180;
  const fwd: V3 = [Math.sin(y), 0, -Math.cos(y)], right: V3 = [Math.cos(y), 0, Math.sin(y)], up: V3 = [0, 1, 0];
  const P = (lat: number, h: number, f = 0): V3 => add(add(add(at, mul(right, lat)), mul(up, h)), mul(fwd, f));
  const sw = walking ? Math.sin(phase) : 0, leg = H * .47, arm = H * .34;
  const legEnd = (hip: V3, a: number): V3 => add(hip, add(mul(up, -leg * Math.cos(a)), mul(fwd, leg * Math.sin(a))));
  const armEnd = (sh: V3, a: number): V3 => add(sh, add(mul(up, -arm * Math.cos(a)), add(mul(fwd, arm * Math.sin(a)), mul(right, 0))));
  const hipL = P(-r * .5, H * .5), hipR = P(r * .5, H * .5), shL = P(-r * 1.1, H * .79), shR = P(r * 1.1, H * .79);
  return [
    ...limb(hipL, legEnd(hipL, .45 * sw), r * .33, pants, m), ...limb(hipR, legEnd(hipR, -.45 * sw), r * .33, pants, m),
    ...limb(legEnd(hipL, .45 * sw), add(legEnd(hipL, .45 * sw), mul(fwd, .12)), r * .3, SHOE, m), ...limb(legEnd(hipR, -.45 * sw), add(legEnd(hipR, -.45 * sw), mul(fwd, .12)), r * .3, SHOE, m),
    ...solid(P(0, H * .28), d.facing === yaw ? d.facing : yaw, circle(r * 1.25, 12), H * .24, dark, m, { top: .85, doll: true }),   // 长袍下摆
    ...solid(P(0, H * .5), yaw, circle(r, 12), H * .31, cloth, m, { top: .92, doll: true }),                                        // 躯干
    ...limb(shL, armEnd(shL, -.35 * sw), r * .28, cloth, m), ...limb(shR, armEnd(shR, .35 * sw), r * .28, cloth, m),
    ...limb(armEnd(shL, -.35 * sw), add(armEnd(shL, -.35 * sw), mul(up, -.07)), r * .26, SKIN, m), ...limb(armEnd(shR, .35 * sw), add(armEnd(shR, .35 * sw), mul(up, -.07)), r * .26, SKIN, m),
    ...solid(P(0, H * .83), yaw, circle(H * .062, 12), H * .12, SKIN, m, { doll: true }),
    ...solid(P(0, H * .94, -.01), yaw, circle(H * .066, 12), H * .05, HAIR, m, { top: .6, doll: true }),
    ...limb(P(0, H * .89, H * .055), P(0, H * .89, H * .075), .012, [200, 160, 130], m, 4),                                       // 鼻尖：看得出朝哪边
  ];
}
const dollAt = (d: Doll, t: number): V3 => dollPose(d, t).at;

export type Scene3 = { room: { outline: [number, number][]; height: number } | null; prims: (WhiteboxPrim & Mark)[]; dolls: Doll[] };

/** 画一帧。overlay 只在屏幕上画（机位小部件、标注）；录预演时不画。cutaway：编辑视角把挡视线的墙和顶棚变半透明。 */
export function drawScene(ctx: CanvasRenderingContext2D, w: number, h: number, view: View, sc: Scene3, o: { labels: boolean; t: number; editCam?: Cam | null; selDoll?: string | null; frame?: boolean; cutaway?: boolean }) {
  const bg = ctx.createLinearGradient(0, 0, 0, h); bg.addColorStop(0, '#3a3d42'); bg.addColorStop(.55, '#2a2b2e'); bg.addColorStop(1, '#1e1d1c'); ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
  const f = norm(sub(view.target, view.eye)); let r = cross(f, [0, 1, 0]); if (Math.hypot(...r) < 1e-6) r = [1, 0, 0]; r = norm(r); const u = cross(r, f);
  const F = (h / 2) / Math.tan((view.fov * Math.PI / 180) / 2), cx = w / 2, cy = h / 2;
  const toCam = (p: V3): V3 => { const d = sub(p, view.eye); return [dot(d, r), dot(d, u), dot(d, f)]; };
  const proj = (q: V3) => [cx + q[0] / q[2] * F, cy - q[1] / q[2] * F] as [number, number];
  const P2 = (p: V3) => { const q = toCam(p); return q[2] > .05 ? proj(q) : null; };
  const seg = (a: V3, b: V3, style: string, width = 1) => { let A = toCam(a), B = toCam(b); const near = .05; if (A[2] < near && B[2] < near) return; if (A[2] < near) A = lerp3(A, B, (near - A[2]) / (B[2] - A[2])); if (B[2] < near) B = lerp3(B, A, (near - B[2]) / (A[2] - B[2])); const p = proj(A), q = proj(B); ctx.strokeStyle = style; ctx.lineWidth = width; ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke(); };
  // 近平面裁剪后的多边形
  const clip = (q: V3[]): V3[] => { const near = .05, out: V3[] = []; for (let i = 0; i < q.length; i++) { const A = q[i], B = q[(i + 1) % q.length]; if (A[2] >= near) out.push(A); if ((A[2] >= near) !== (B[2] >= near)) out.push(lerp3(A, B, (near - A[2]) / (B[2] - A[2]))); } return out; };
  const L = norm([-.45, .85, .4]);
  const paint = (q: V3[], col: RGB, n: V3, alpha = 1, edge = 'rgba(30,26,22,.35)', lw = 1) => {
    const c = clip(q); if (c.length < 3) return;
    const k = .5 + .5 * Math.max(0, dot(n, L)) + (n[1] > .9 ? .08 : 0);
    ctx.beginPath(); c.forEach((v, i) => { const p = proj(v); if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); }); ctx.closePath();
    ctx.globalAlpha = alpha; ctx.fillStyle = `rgb(${Math.min(255, Math.round(col[0] * k))},${Math.min(255, Math.round(col[1] * k))},${Math.min(255, Math.round(col[2] * k))})`; ctx.fill();
    ctx.globalAlpha = Math.min(1, alpha + .2); ctx.lineWidth = edge ? lw : .6; ctx.strokeStyle = edge || ctx.fillStyle; ctx.stroke(); ctx.globalAlpha = 1;
  };
  // 地面网格（淡）
  for (let i = -12; i <= 12; i++) { const s = i % 5 === 0 ? 'rgba(255,255,255,.08)' : 'rgba(255,255,255,.035)'; seg([i, 0, -12], [i, 0, 12], s); seg([-12, 0, i], [12, 0, i], s); }
  // 房间地面先铺满（木地板色），再画轮廓
  if (sc.room) {
    const ol = sc.room.outline, H = sc.room.height;
    paint(ol.map(([x, z]) => toCam([x, 0, z])), [150, 118, 84], [0, 1, 0], 1, 'rgba(0,0,0,0)');
    ol.forEach((a, i) => { const b = ol[(i + 1) % ol.length]; seg([a[0], .005, a[1]], [b[0], .005, b[1]], 'rgba(120,170,220,.8)', 1.5); seg([a[0], H, a[1]], [b[0], H, b[1]], 'rgba(120,170,220,.3)'); });
  }
  // 剖开：编辑视角下，墙心在房间中心靠镜头这一侧的墙、以及顶棚，半透明
  const ctr: V3 = sc.room ? [sc.room.outline.reduce((s, p) => s + p[0], 0) / sc.room.outline.length, 0, sc.room.outline.reduce((s, p) => s + p[1], 0) / sc.room.outline.length] : [0, 0, 0];
  const toEye = norm([view.eye[0] - ctr[0], 0, view.eye[2] - ctr[2]]);
  const see = (p: WhiteboxPrim) => !o.cutaway ? undefined : isRoof(p) ? .12 : isWall(p) && dot([p.c[0] - ctr[0], 0, p.c[2] - ctr[2]], toEye) > .5 ? .18 : undefined;
  // 贴地的薄片（地面、街面、河面）先画，免得按深度排序时盖住站在上面的东西
  const ground: Face[] = [], faces: Face[] = [];
  sc.prims.forEach(p => (isGround(p) ? ground : faces).push(...primFaces(p, { ghost: p.ghost, hi: p.hi, ai: p.ai }, see(p))));
  sc.dolls.forEach(d => faces.push(...dollFaces(d, o.t)));
  const draw = (list: Face[], sort: boolean) => {
    const vis = list.map(fc => { const q = fc.pts.map(toCam); if (q.every(v => v[2] < .05)) return null; const fcen = mul(fc.pts.reduce((s, v) => add(s, v), [0, 0, 0] as V3), 1 / fc.pts.length); if (!fc.m.ghost && dot(fc.n, sub(view.eye, fcen)) <= 0) return null; return { fc, q, z: q.reduce((s, v) => s + v[2], 0) / q.length }; }).filter(Boolean) as { fc: Face; q: V3[]; z: number }[];
    if (sort) vis.sort((a, b) => b.z - a.z);
    for (const { fc, q } of vis) {
      if (fc.m.ghost) { const c = clip(q); if (c.length < 3) continue; ctx.beginPath(); c.forEach((v, i) => { const p = proj(v); if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); }); ctx.closePath(); ctx.fillStyle = 'rgba(255,122,26,.14)'; ctx.fill(); ctx.setLineDash([5, 4]); ctx.strokeStyle = 'rgba(255,140,60,.9)'; ctx.lineWidth = 1.2; ctx.stroke(); ctx.setLineDash([]); continue; }
      const mark = fc.m.hi || fc.m.ai;
      paint(q, fc.col, fc.n, fc.alpha ?? 1, mark ? '#ff7a1a' : fc.doll ? 'rgba(20,18,16,.45)' : fc.sub ? '' : 'rgba(30,26,22,.35)', mark ? 2 : 1);
    }
  };
  draw(ground, true); draw(faces, true);
  if (o.labels) {
    ctx.font = '500 11px "IBM Plex Mono", "Noto Sans SC", monospace';
    sc.dolls.forEach(d => { const at = dollAt(d, o.t), p = P2([at[0], (d.heightM || 1.7) + .15, at[2]]);
      // 地上一道短线：朝向
      const a = (dollPose(d, o.t).yaw * Math.PI) / 180; seg([at[0], .01, at[2]], [at[0] + Math.sin(a) * .5, .01, at[2] - Math.cos(a) * .5], 'rgba(255,214,150,.9)', 2);
      if (d.to) { ctx.setLineDash([3, 3]); seg([d.at[0], .02, d.at[2]], [d.to[0], .02, d.to[2]], 'rgba(255,122,26,.8)'); ctx.setLineDash([]); }
      if (!p) return; ctx.fillStyle = d.id === o.selDoll || d.hi || d.ai ? '#ff7a1a' : d.ghost ? 'rgba(255,160,90,.95)' : '#f4f1ea'; ctx.fillText(d.name + (d.ghost ? ' · 提议' : ''), p[0] + 6, p[1]); });
    sc.prims.filter(p => p.label).forEach(p => { const q = P2([p.c[0], p.c[1] + p.s[1], p.c[2]]); if (!q) return; ctx.fillStyle = p.ghost ? 'rgba(255,160,90,.85)' : p.hi ? '#ff7a1a' : 'rgba(236,232,224,.7)'; ctx.fillText(p.label!, q[0] + 4, q[1] - 3); });
  }
  if (o.editCam) {
    const e = o.editCam, ff = norm(sub(e.target, e.eye)); let rr = cross(ff, [0, 1, 0]); rr = norm(Math.hypot(...rr) < 1e-6 ? [1, 0, 0] : rr); const uu = cross(rr, ff);
    const t = Math.tan((e.fov * Math.PI / 180) / 2) * 1.2, dd = 1.2;
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => add(add(e.eye, mul(ff, dd)), add(mul(rr, a * t * 16 / 9), mul(uu, b * t))));
    corners.forEach(cn => seg(e.eye, cn, 'rgba(255,122,26,.8)')); corners.forEach((cn, i) => seg(cn, corners[(i + 1) % 4], 'rgba(255,122,26,.8)'));
    seg(e.eye, e.target, 'rgba(255,122,26,.3)');
    ctx.font = '500 11px "IBM Plex Mono", "Noto Sans SC", monospace';
    const dot2 = (p: V3, label: string, filled: boolean) => { const q = P2(p); if (!q) return; ctx.fillStyle = '#ff7a1a'; ctx.strokeStyle = '#ff7a1a'; ctx.beginPath(); ctx.arc(q[0], q[1], 6, 0, Math.PI * 2); filled ? ctx.fill() : ctx.stroke(); ctx.fillText(label, q[0] + 9, q[1] + 4); };
    dot2(e.eye, '机位', true); dot2(e.target, '看向', false);
    if (e.end) { ctx.setLineDash([4, 4]); seg(e.eye, e.end.eye, '#ff7a1a'); seg(e.end.eye, e.end.target, 'rgba(255,122,26,.3)'); ctx.setLineDash([]); dot2(e.end.eye, '终点', false); }
  }
  if (o.frame) {
    const fw = Math.min(w - 24, (h - 24) * 16 / 9), fh = fw * 9 / 16, x0 = (w - fw) / 2, y0 = (h - fh) / 2;
    ctx.fillStyle = 'rgba(13,11,14,.72)'; ctx.fillRect(0, 0, w, y0); ctx.fillRect(0, y0 + fh, w, h - y0 - fh); ctx.fillRect(0, y0, x0, fh); ctx.fillRect(x0 + fw, y0, w - x0 - fw, fh);
    ctx.strokeStyle = 'rgba(236,235,231,.55)'; ctx.lineWidth = 1; ctx.strokeRect(x0 + .5, y0 + .5, fw, fh);
  }
}

/** 录预演：离屏 1280×720 按镜头机位从起点运到终点，录成和镜头一样长的片段。 */
export async function recordShot(sc: Scene3, cam: Cam, durationSec: number, onTick?: (t: number) => void): Promise<{ video: Blob; poster: Blob | null }> {
  const W = 1280, H = 720, c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d')!;
  const frame = (t: number) => drawScene(ctx, W, H, camAt(cam, t), sc, { labels: false, t });
  frame(0);
  const poster = await new Promise<Blob | null>(res => c.toBlob(res, 'image/png'));
  const stream = c.captureStream(24);
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find(m => MediaRecorder.isTypeSupported(m)) ?? '';
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 2_500_000 } : undefined);
  const chunks: Blob[] = []; rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise<void>(res => { rec.onstop = () => res(); });
  rec.start(250);
  const t0 = performance.now(), ms = durationSec * 1000;
  await new Promise<void>(res => { const tick = () => { const t = Math.min(1, (performance.now() - t0) / ms); frame(t); onTick?.(t); if (t < 1) requestAnimationFrame(tick); else res(); }; requestAnimationFrame(tick); });
  rec.stop(); await done; stream.getTracks().forEach(tr => tr.stop());
  return { video: new Blob(chunks, { type: (mime || 'video/webm').split(';')[0] }), poster };
}

export type ViewportHandle = { fit: () => void };
export const Viewport3 = forwardRef<ViewportHandle, {
  scene: Scene3; cam: Cam | null; mode: 'editor' | 'camera'; t: number; selDoll: string | null; editable: boolean;
  onSelDoll: (id: string | null) => void; onMoveDoll: (id: string, p: V3, which?: 'at' | 'to') => void; onMoveCam: (which: 'eye' | 'target' | 'end', p: V3) => void;
  /** 拖家具（房间壳、虚影不能拖）。 */ onMovePrim?: (id: string, c: V3) => void;
  /** 松手时：拖过人偶或机位就提交一次。 */ onCommit: () => void;
}>(function Viewport3(props, ref) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const orbit = useRef({ yaw: .55, pitch: .62, dist: 13, target: [0, .8, 0] as V3 });
  const last = useRef<{ view: View; F: number; cx: number; cy: number } | null>(null);
  const drag = useRef<{ kind: 'orbit' | 'pan' | 'doll' | 'cam' | 'prim'; to?: boolean; id?: string; which?: 'eye' | 'target' | 'end'; x: number; y: number; plane?: number; moved?: boolean } | null>(null);
  const P = useRef(props); P.current = props;
  const raf = useRef(0);
  const viewOf = (): View => { const p = P.current, o = orbit.current; return p.mode === 'camera' && p.cam ? camAt(p.cam, p.t) : { eye: add(o.target, [Math.cos(o.pitch) * Math.sin(o.yaw) * o.dist, Math.sin(o.pitch) * o.dist, Math.cos(o.pitch) * Math.cos(o.yaw) * o.dist]), target: o.target, fov: 45 }; };
  const draw = () => {
    const c = canvas.current; if (!c) return; const p = P.current, dpr = Math.min(1.5, window.devicePixelRatio || 1), w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const ctx = c.getContext('2d')!; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const view = viewOf(); last.current = { view, F: (h / 2) / Math.tan((view.fov * Math.PI / 180) / 2), cx: w / 2, cy: h / 2 };
    drawScene(ctx, w, h, view, p.scene, { labels: true, t: p.t, editCam: p.mode === 'editor' ? p.cam : null, selDoll: p.selDoll, frame: p.mode === 'camera', cutaway: p.mode === 'editor' });
  };
  const request = () => { cancelAnimationFrame(raf.current); raf.current = requestAnimationFrame(draw); };
  useEffect(request);
  useEffect(() => { const c = canvas.current!; const ro = new ResizeObserver(request); ro.observe(c); return () => { ro.disconnect(); cancelAnimationFrame(raf.current); }; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // 看全部：按房间、部件、人偶的范围摆编辑视角
  useImperativeHandle(ref, () => ({ fit: () => {
    const sc = P.current.scene, pts: V3[] = [...(sc.room?.outline.map(([x, z]) => [x, 0, z] as V3) ?? []), ...sc.prims.flatMap(p => [[p.c[0] - p.s[0] / 2, p.c[1], p.c[2] - (p.kind === 'box' ? p.s[2] : p.s[0]) / 2], [p.c[0] + p.s[0] / 2, p.c[1] + p.s[1], p.c[2] + (p.kind === 'box' ? p.s[2] : p.s[0]) / 2]] as V3[]), ...sc.dolls.map(d => d.at)];
    if (!pts.length) { orbit.current = { yaw: .55, pitch: .62, dist: 13, target: [0, .8, 0] }; request(); return; }
    const lo = [0, 1, 2].map(i => Math.min(...pts.map(p => p[i]))), hi = [0, 1, 2].map(i => Math.max(...pts.map(p => p[i])));
    const size = Math.max(hi[0] - lo[0], hi[2] - lo[2], 4);
    orbit.current = { yaw: .55, pitch: .62, dist: size * 1.25, target: [(lo[0] + hi[0]) / 2, Math.min(1.2, (lo[1] + hi[1]) / 2), (lo[2] + hi[2]) / 2] }; request();
  } }));

  const basis = () => { const L = last.current!; const f = norm(sub(L.view.target, L.view.eye)); let r = cross(f, [0, 1, 0]); r = norm(Math.hypot(...r) < 1e-6 ? [1, 0, 0] : r); return { L, f, r, u: cross(r, f) }; };
  const onPlane = (x: number, y: number, h: number): V3 | null => { const { L, f, r, u } = basis(); const d = norm(add(f, add(mul(r, (x - L.cx) / L.F), mul(u, -(y - L.cy) / L.F)))); if (Math.abs(d[1]) < 1e-4) return null; const t = (h - L.view.eye[1]) / d[1]; return t > 0 ? add(L.view.eye, mul(d, t)) : null; };
  const screen = (p: V3) => { const { L, f, r, u } = basis(); const d = sub(p, L.view.eye), z = dot(d, f); return z > .05 ? [L.cx + dot(d, r) / z * L.F, L.cy - dot(d, u) / z * L.F] : null; };
  const round = (p: V3): V3 => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100, Math.round(p[2] * 100) / 100];
  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top; try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 合成事件没有真指针 */ }
    const p = P.current;
    if (p.mode === 'editor' && p.editable && p.cam) for (const which of ['end', 'eye', 'target'] as const) { const q = which === 'eye' ? p.cam.eye : which === 'target' ? p.cam.target : p.cam.end?.eye; if (!q) continue; const s = screen(q); if (s && Math.hypot(s[0] - x, s[1] - y) < 12) { drag.current = { kind: 'cam', which, x, y, plane: q[1] }; return; } }
    if (p.mode === 'editor') { let best: { id: string; d: number } | null = null; for (const d of p.scene.dolls) { if (d.ghost) continue; const s = screen([d.at[0], (d.heightM || 1.7) * .65, d.at[2]]); if (!s) continue; const dd = Math.hypot(s[0] - x, s[1] - y); if (dd < 28 && (!best || dd < best.d)) best = { id: d.id, d: dd }; } if (best) { p.onSelDoll(best.id); drag.current = { kind: 'doll', id: best.id, x, y, to: e.shiftKey }; return; } }
    // 家具：按顶面中心找最近的一件（房间壳、虚影、贴地薄片不能拖）
    if (p.mode === 'editor' && p.onMovePrim) { let best: { id: string; d: number; y: number } | null = null; for (const q of p.scene.prims) { if (q.ghost || q.from === 'shell' || q.s[1] <= .06) continue; const s = screen([q.c[0], q.c[1] + q.s[1], q.c[2]]); if (!s) continue; const dd = Math.hypot(s[0] - x, s[1] - y); if (dd < 24 && (!best || dd < best.d)) best = { id: q.id, d: dd, y: q.c[1] }; } if (best) { drag.current = { kind: 'prim', id: best.id, x, y, plane: best.y }; return; } }
    drag.current = { kind: e.shiftKey || e.button === 2 ? 'pan' : 'orbit', x, y };
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current; if (!d) return; const rect = e.currentTarget.getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top, o = orbit.current, p = P.current;
    if (p.mode !== 'editor') return;
    if (d.kind === 'orbit') { o.yaw -= (x - d.x) * .008; o.pitch = Math.max(.08, Math.min(1.5, o.pitch + (y - d.y) * .006)); request(); }
    else if (d.kind === 'pan') { const { L, f } = basis(); const r = norm(cross(f, [0, 1, 0])); const k = o.dist / L.F; o.target = add(o.target, add(mul(r, -(x - d.x) * k), [0, (y - d.y) * k, 0])); request(); }
    else if (d.kind === 'doll' && d.id && p.editable) { const q = onPlane(x, y, 0); if (q) { d.moved = true; p.onMoveDoll(d.id, round([q[0], 0, q[2]]), d.to ? 'to' : 'at'); } }
    else if (d.kind === 'prim' && d.id) { const q = onPlane(x, y, d.plane ?? 0); if (q) { d.moved = true; p.onMovePrim?.(d.id, round([q[0], d.plane ?? 0, q[2]])); } }
    else if (d.kind === 'cam' && d.which) { const q = onPlane(x, y, d.plane ?? 1.5); if (q) { d.moved = true; p.onMoveCam(d.which, round(q)); } }
    d.x = x; d.y = y;
  };
  const up = () => { const d = drag.current; drag.current = null; if (d?.moved && (d.kind === 'doll' || d.kind === 'cam' || d.kind === 'prim')) P.current.onCommit(); };
  const wheel = (e: React.WheelEvent) => { if (P.current.mode !== 'editor') return; const o = orbit.current; o.dist = Math.max(3, Math.min(40, o.dist * (1 + e.deltaY * .001))); request(); };
  return <canvas ref={canvas} className="lv-canvas" data-mode={props.mode} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onWheel={wheel} onContextMenu={e => e.preventDefault()} aria-label="白模视口" />;
});
