// MVP-3 白模视口（契约 §13.6）：Canvas 2D 软渲染（透视投影 + 背面剔除 + 画家算法），沿用示例视口的做法。
// 坐标：米；x 向右、y 向上、z 向镜头外。白模部件 c 是底面中心；box 的 s 是长宽高；cylinder / prism 的 s 是 [半径, 高, 0]。
// 人偶只画躯干和头（Seedance 经验：画四肢会僵），高矮按 person.body。facing：度，0 = 朝 -z，顺时针（从上往下看）。
// 同一个 drawScene 既画屏幕上的视口，也画「录预演」的离屏画面，保证录到的就是看到的。
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { Shot, V3, WhiteboxPrim } from '../../../../../packages/contracts/src/creative';

export type Doll = { id: string; name: string; at: V3; to?: V3 | null; facing: number; heightM: number; build: 'slim' | 'average' | 'heavy' | null; ghost?: boolean; hi?: boolean; ai?: boolean };
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

type Face = { pts: V3[]; n: V3; g: number; m: Mark; doll?: boolean };
function solid(c: V3, rotY: number, ring: [number, number][], h: number, g: number, m: Mark, doll?: boolean): Face[] {
  const r = (rotY * Math.PI) / 180, cs = Math.cos(r), sn = Math.sin(r);
  const T = (x: number, y: number, z: number): V3 => [c[0] + x * cs + z * sn, c[1] + y, c[2] - x * sn + z * cs];
  const A = ring.map(([x, z]) => T(x, 0, z)), B = ring.map(([x, z]) => T(x, h, z));
  const faces: Face[] = [{ pts: A, n: [0, -1, 0], g, m, doll }, { pts: B, n: [0, 1, 0], g, m, doll }];
  const cen = add(c, [0, h / 2, 0]);
  for (let i = 0; i < A.length; i++) {
    const j = (i + 1) % A.length, pts = [A[i], A[j], B[j], B[i]];
    let n = norm(cross(sub(pts[1], pts[0]), sub(pts[2], pts[0])));
    const fc = mul(pts.reduce((s, v) => add(s, v), [0, 0, 0] as V3), 1 / 4); if (dot(n, sub(fc, cen)) < 0) n = mul(n, -1);
    faces.push({ pts, n, g, m, doll });
  }
  return faces;
}
const circle = (r: number, n: number): [number, number][] => Array.from({ length: n }, (_, i) => { const a = (i / n) * Math.PI * 2; return [Math.cos(a) * r, Math.sin(a) * r]; });
function primFaces(p: WhiteboxPrim, m: Mark): Face[] {
  const g = p.label && /地面|地板|台阶|石阶/.test(p.label) ? .42 : .62;
  if (p.kind === 'box') { const [w, h, d] = p.s; return solid(p.c, p.rotY ?? 0, [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]], h, g, m); }
  return solid(p.c, p.rotY ?? 0, circle(p.s[0], p.kind === 'cylinder' ? 18 : Math.max(3, p.sides ?? 6)), p.s[1], g, m);
}
const RADIUS = { slim: .16, average: .2, heavy: .25 } as const;
/** 人偶：躯干（腰到肩）+ 头；不画四肢。 */
function dollFaces(d: Doll, at: V3): Face[] {
  const H = d.heightM || 1.7, r = RADIUS[d.build ?? 'average'], m: Mark = { ghost: d.ghost, hi: d.hi, ai: d.ai };
  return [...solid([at[0], H * .48, at[2]], d.facing, circle(r, 10), H * .34, .7, m, true), ...solid([at[0], H * .87, at[2]], d.facing, circle(H * .065, 10), H * .13, .78, m, true)];
}
const dollAt = (d: Doll, t: number): V3 => d.to ? lerp3(d.at, d.to, smooth(t)) : d.at;

export type Scene3 = { room: { outline: [number, number][]; height: number } | null; prims: (WhiteboxPrim & Mark)[]; dolls: Doll[] };

/** 画一帧。overlay 只在屏幕上画（机位小部件、标注）；录预演时不画。 */
export function drawScene(ctx: CanvasRenderingContext2D, w: number, h: number, view: View, sc: Scene3, o: { labels: boolean; t: number; editCam?: Cam | null; selDoll?: string | null; frame?: boolean }) {
  const bg = ctx.createLinearGradient(0, 0, 0, h); bg.addColorStop(0, '#1c1a1b'); bg.addColorStop(1, '#0d0b0e'); ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
  const f = norm(sub(view.target, view.eye)); let r = cross(f, [0, 1, 0]); if (Math.hypot(...r) < 1e-6) r = [1, 0, 0]; r = norm(r); const u = cross(r, f);
  const F = (h / 2) / Math.tan((view.fov * Math.PI / 180) / 2), cx = w / 2, cy = h / 2;
  const toCam = (p: V3): V3 => { const d = sub(p, view.eye); return [dot(d, r), dot(d, u), dot(d, f)]; };
  const proj = (q: V3) => [cx + q[0] / q[2] * F, cy - q[1] / q[2] * F] as [number, number];
  const P2 = (p: V3) => { const q = toCam(p); return q[2] > .05 ? proj(q) : null; };
  const seg = (a: V3, b: V3, style: string, width = 1) => { let A = toCam(a), B = toCam(b); const near = .05; if (A[2] < near && B[2] < near) return; if (A[2] < near) A = lerp3(A, B, (near - A[2]) / (B[2] - A[2])); if (B[2] < near) B = lerp3(B, A, (near - B[2]) / (A[2] - B[2])); const p = proj(A), q = proj(B); ctx.strokeStyle = style; ctx.lineWidth = width; ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke(); };
  // 地面网格
  for (let i = -12; i <= 12; i++) { const s = i % 5 === 0 ? '#34312f' : '#221f20'; seg([i, 0, -12], [i, 0, 12], s); seg([-12, 0, i], [12, 0, i], s); }
  // 房间轮廓：地面和顶上两圈线 + 竖边（不画墙面，好看见里面）
  if (sc.room) {
    const ol = sc.room.outline, H = sc.room.height;
    ol.forEach((a, i) => { const b = ol[(i + 1) % ol.length]; seg([a[0], 0, a[1]], [b[0], 0, b[1]], 'rgba(120,170,220,.75)', 1.5); seg([a[0], H, a[1]], [b[0], H, b[1]], 'rgba(120,170,220,.35)'); seg([a[0], 0, a[1]], [a[0], H, a[1]], 'rgba(120,170,220,.3)'); });
  }
  const faces: Face[] = [];
  sc.prims.forEach(p => faces.push(...primFaces(p, { ghost: p.ghost, hi: p.hi, ai: p.ai })));
  sc.dolls.forEach(d => faces.push(...dollFaces(d, dollAt(d, o.t))));
  const L = norm([-.5, .8, .45]);
  const vis = faces.map(fc => { const q = fc.pts.map(toCam); if (q.some(v => v[2] < .05)) return null; const fcen = mul(fc.pts.reduce((s, v) => add(s, v), [0, 0, 0] as V3), 1 / fc.pts.length); if (!fc.m.ghost && dot(fc.n, sub(view.eye, fcen)) <= 0) return null; return { fc, q, z: q.reduce((s, v) => s + v[2], 0) / q.length }; }).filter(Boolean) as { fc: Face; q: V3[]; z: number }[];
  vis.sort((a, b) => b.z - a.z);
  for (const { fc, q } of vis) {
    const shade = .35 + .65 * Math.max(0, dot(fc.n, L)), lum = fc.g * shade;
    ctx.beginPath(); q.forEach((v, i) => { const p = proj(v); if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); }); ctx.closePath();
    if (fc.m.ghost) { ctx.fillStyle = 'rgba(255,122,26,.14)'; ctx.fill(); ctx.setLineDash([5, 4]); ctx.strokeStyle = 'rgba(255,140,60,.9)'; ctx.lineWidth = 1.2; ctx.stroke(); ctx.setLineDash([]); continue; }
    ctx.fillStyle = fc.doll ? `rgb(${Math.round(60 + lum * 170)},${Math.round(58 + lum * 160)},${Math.round(56 + lum * 150)})` : `rgb(${Math.round(30 + lum * 205)},${Math.round(28 + lum * 200)},${Math.round(28 + lum * 192)})`;
    ctx.fill(); ctx.lineWidth = fc.m.hi || fc.m.ai ? 1.8 : 1; ctx.strokeStyle = fc.m.hi || fc.m.ai ? '#ff7a1a' : 'rgba(236,235,231,.2)'; ctx.stroke();
  }
  if (o.labels) {
    ctx.font = '500 11px "IBM Plex Mono", "Noto Sans SC", monospace';
    sc.dolls.forEach(d => { const at = dollAt(d, o.t), p = P2([at[0], (d.heightM || 1.7) + .15, at[2]]); if (!p) return; ctx.fillStyle = d.id === o.selDoll || d.hi || d.ai ? '#ff7a1a' : d.ghost ? 'rgba(255,160,90,.95)' : '#ecebe7'; ctx.fillText(d.name + (d.ghost ? ' · 提议' : ''), p[0] + 6, p[1]);
      if (d.to) { ctx.setLineDash([3, 3]); seg([d.at[0], .02, d.at[2]], [d.to[0], .02, d.to[2]], 'rgba(255,122,26,.7)'); ctx.setLineDash([]); } });
    sc.prims.filter(p => p.label).forEach(p => { const q = P2([p.c[0], p.c[1] + (p.kind === 'box' ? p.s[1] : p.s[1]), p.c[2]]); if (!q) return; ctx.fillStyle = p.ghost ? 'rgba(255,160,90,.85)' : p.hi ? '#ff7a1a' : 'rgba(154,151,146,.85)'; ctx.fillText(p.label!, q[0] + 4, q[1] - 3); });
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
  onSelDoll: (id: string | null) => void; onMoveDoll: (id: string, p: V3) => void; onMoveCam: (which: 'eye' | 'target' | 'end', p: V3) => void;
  /** 松手时：拖过人偶或机位就提交一次。 */ onCommit: () => void;
}>(function Viewport3(props, ref) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const orbit = useRef({ yaw: .55, pitch: .62, dist: 13, target: [0, .8, 0] as V3 });
  const last = useRef<{ view: View; F: number; cx: number; cy: number } | null>(null);
  const drag = useRef<{ kind: 'orbit' | 'pan' | 'doll' | 'cam'; id?: string; which?: 'eye' | 'target' | 'end'; x: number; y: number; plane?: number; moved?: boolean } | null>(null);
  const P = useRef(props); P.current = props;
  const raf = useRef(0);
  const viewOf = (): View => { const p = P.current, o = orbit.current; return p.mode === 'camera' && p.cam ? camAt(p.cam, p.t) : { eye: add(o.target, [Math.cos(o.pitch) * Math.sin(o.yaw) * o.dist, Math.sin(o.pitch) * o.dist, Math.cos(o.pitch) * Math.cos(o.yaw) * o.dist]), target: o.target, fov: 45 }; };
  const draw = () => {
    const c = canvas.current; if (!c) return; const p = P.current, dpr = Math.min(1.5, window.devicePixelRatio || 1), w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const ctx = c.getContext('2d')!; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const view = viewOf(); last.current = { view, F: (h / 2) / Math.tan((view.fov * Math.PI / 180) / 2), cx: w / 2, cy: h / 2 };
    drawScene(ctx, w, h, view, p.scene, { labels: true, t: p.t, editCam: p.mode === 'editor' ? p.cam : null, selDoll: p.selDoll, frame: p.mode === 'camera' });
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
    if (p.mode === 'editor') { let best: { id: string; d: number } | null = null; for (const d of p.scene.dolls) { if (d.ghost) continue; const s = screen([d.at[0], (d.heightM || 1.7) * .65, d.at[2]]); if (!s) continue; const dd = Math.hypot(s[0] - x, s[1] - y); if (dd < 28 && (!best || dd < best.d)) best = { id: d.id, d: dd }; } if (best) { p.onSelDoll(best.id); drag.current = { kind: 'doll', id: best.id, x, y }; return; } }
    drag.current = { kind: e.shiftKey || e.button === 2 ? 'pan' : 'orbit', x, y };
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current; if (!d) return; const rect = e.currentTarget.getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top, o = orbit.current, p = P.current;
    if (p.mode !== 'editor') return;
    if (d.kind === 'orbit') { o.yaw -= (x - d.x) * .008; o.pitch = Math.max(.08, Math.min(1.5, o.pitch + (y - d.y) * .006)); request(); }
    else if (d.kind === 'pan') { const { L, f } = basis(); const r = norm(cross(f, [0, 1, 0])); const k = o.dist / L.F; o.target = add(o.target, add(mul(r, -(x - d.x) * k), [0, (y - d.y) * k, 0])); request(); }
    else if (d.kind === 'doll' && d.id && p.editable) { const q = onPlane(x, y, 0); if (q) { d.moved = true; p.onMoveDoll(d.id, round([q[0], 0, q[2]])); } }
    else if (d.kind === 'cam' && d.which) { const q = onPlane(x, y, d.plane ?? 1.5); if (q) { d.moved = true; p.onMoveCam(d.which, round(q)); } }
    d.x = x; d.y = y;
  };
  const up = () => { const d = drag.current; drag.current = null; if (d?.moved && (d.kind === 'doll' || d.kind === 'cam')) P.current.onCommit(); };
  const wheel = (e: React.WheelEvent) => { if (P.current.mode !== 'editor') return; const o = orbit.current; o.dist = Math.max(3, Math.min(40, o.dist * (1 + e.deltaY * .001))); request(); };
  return <canvas ref={canvas} className="lv-canvas" data-mode={props.mode} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onWheel={wheel} onContextMenu={e => e.preventDefault()} aria-label="白模视口" />;
});
