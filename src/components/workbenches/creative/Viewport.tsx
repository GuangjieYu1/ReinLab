import { useEffect, useRef } from 'react';
import type { Cam, Char, Light, Prim, V3 } from './videoModel';

// 白模视口：Canvas 2D 软渲染（不用 WebGL）。自写透视投影 + 背面剔除 + 画家算法排序，几百个面每帧约 1ms。
// 编辑视角：拖空白处环绕、Shift / 右键平移、滚轮缩放；拖人物在地面上移动；拖机位（起点 / 终点）。
// 机位视角：用镜头的机位渲染，叠加 16:9 安全框与三分线。

type View = { eye: V3; target: V3; fov: number };
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const ease = (t: number) => 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3);

type Face = { pts: V3[]; n: V3; g: number; accent?: boolean; char?: boolean; sel?: boolean };
function primFaces(p: Prim, k: number): Face[] {
  if (k <= 0) return [];
  const rot = p.rot ?? 0, cs = Math.cos(rot), sn = Math.sin(rot);
  const T = (x: number, y: number, z: number): V3 => [p.c[0] + x * cs - z * sn, p.c[1] + y, p.c[2] + x * sn + z * cs];
  let rings: V3[][] = [];
  if (p.kind === 'box') {
    const [sx, sy, sz] = [p.s[0] * k, p.s[1] * k, p.s[2] * k];
    const b = [T(-sx / 2, 0, -sz / 2), T(sx / 2, 0, -sz / 2), T(sx / 2, 0, sz / 2), T(-sx / 2, 0, sz / 2)];
    const t = b.map(v => [v[0], v[1] + sy, v[2]] as V3);
    rings = [b, t];
  } else {
    const n = p.n ?? 8, r = p.s[0] * k, h = p.s[1] * k, ring = (off: number) => Array.from({ length: n }, (_, i) => { const a = (i / n) * Math.PI * 2; return p.axis === 'z' ? T(Math.cos(a) * r, r + Math.sin(a) * r, off) : T(Math.cos(a) * r, off, Math.sin(a) * r); });
    rings = p.axis === 'z' ? [ring(-h / 2), ring(h / 2)] : [ring(0), ring(h)];
  }
  const [A, B] = rings, faces: Face[] = [{ pts: A, n: [0, 0, 0], g: p.g }, { pts: B, n: [0, 0, 0], g: p.g }];
  for (let i = 0; i < A.length; i++) { const j = (i + 1) % A.length; faces.push({ pts: [A[i], A[j], B[j], B[i]], n: [0, 0, 0], g: p.g }); }
  // 法线朝外：按基本体的中心定向，避免绕序问题。
  const all = [...A, ...B], cen = mul(all.reduce((s, v) => add(s, v), [0, 0, 0] as V3), 1 / all.length);
  faces.forEach(f => { let nn = norm(cross(sub(f.pts[1], f.pts[0]), sub(f.pts[2], f.pts[0]))); const fc = mul(f.pts.reduce((s, v) => add(s, v), [0, 0, 0] as V3), 1 / f.pts.length); if (dot(nn, sub(fc, cen)) < 0) nn = mul(nn, -1); f.n = nn; f.accent = p.accent; });
  return faces;
}
function charFaces(c: Char, sel: boolean): Face[] {
  const body: Prim = { id: c.id, kind: 'prism', c: c.p, s: [c.r, c.h * .76, 0], n: 8, g: .66 };
  const head: Prim = { id: c.id + 'h', kind: 'prism', c: [c.p[0], c.h * .8, c.p[2]], s: [c.r * .72, c.h * .2, 0], n: 8, g: .74 };
  return [...primFaces(body, 1), ...primFaces(head, 1)].map(f => ({ ...f, char: true, sel }));
}

export type ViewportApi = { orbit: { yaw: number; pitch: number; dist: number; target: V3 } };
export default function Viewport({ prims, chars, buildAt, mode, cam, editCam, light, selChar, onSelChar, onMoveChar, onMoveCam, dim = 0, labels = true }: {
  prims: Prim[]; chars: Char[]; buildAt: number | null; mode: 'editor' | 'camera'; cam: View | null; editCam: Cam | null; light: Light;
  selChar: string | null; onSelChar: (id: string | null) => void; onMoveChar: (id: string, p: V3) => void; onMoveCam: (which: 'eye' | 'end', p: V3) => void; dim?: number; labels?: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const orbit = useRef({ yaw: .62, pitch: .42, dist: 17, target: [-1, .6, -2] as V3 });
  const last = useRef<{ view: View; F: number; cx: number; cy: number; w: number; h: number } | null>(null);
  const drag = useRef<{ kind: 'orbit' | 'pan' | 'char' | 'cam'; id?: string; which?: 'eye' | 'end'; x: number; y: number; plane?: number } | null>(null);
  const props = useRef({ prims, chars, buildAt, mode, cam, editCam, light, selChar, dim, labels });
  props.current = { prims, chars, buildAt, mode, cam, editCam, light, selChar, dim, labels };
  const raf = useRef(0);

  const draw = () => {
    const c = canvas.current; if (!c) return;
    const P = props.current, dpr = Math.min(1.5, window.devicePixelRatio || 1), w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const ctx = c.getContext('2d')!; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // 暗室背景
    const bg = ctx.createLinearGradient(0, 0, 0, h); bg.addColorStop(0, '#1c1a1b'); bg.addColorStop(1, '#0d0b0e'); ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    const o = orbit.current;
    const view: View = P.mode === 'camera' && P.cam ? P.cam : { eye: add(o.target, [Math.cos(o.pitch) * Math.sin(o.yaw) * o.dist, Math.sin(o.pitch) * o.dist, Math.cos(o.pitch) * Math.cos(o.yaw) * o.dist]), target: o.target, fov: 45 };
    const f = norm(sub(view.target, view.eye)); let r = cross(f, [0, 1, 0]); if (Math.hypot(...r) < 1e-6) r = [1, 0, 0]; r = norm(r); const u = cross(r, f);
    const F = (h / 2) / Math.tan((view.fov * Math.PI / 180) / 2), cx = w / 2, cy = h / 2;
    last.current = { view, F, cx, cy, w, h };
    const toCam = (p: V3): V3 => { const d = sub(p, view.eye); return [dot(d, r), dot(d, u), dot(d, f)]; };
    const proj = (q: V3) => [cx + q[0] / q[2] * F, cy - q[1] / q[2] * F] as [number, number];
    const P2 = (p: V3) => { const q = toCam(p); return q[2] > .05 ? proj(q) : null; };
    ctx.globalAlpha = 1 - P.dim;
    // 地面网格（逐段按近平面裁切）
    ctx.lineWidth = 1;
    const seg = (a: V3, b: V3, style: string) => { let A = toCam(a), B = toCam(b); const near = .05; if (A[2] < near && B[2] < near) return; if (A[2] < near) A = lerp3(A, B, (near - A[2]) / (B[2] - A[2])); if (B[2] < near) B = lerp3(B, A, (near - B[2]) / (A[2] - B[2])); const p = proj(A), q = proj(B); ctx.strokeStyle = style; ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke(); };
    for (let i = -20; i <= 20; i++) { const s = i % 5 === 0 ? '#34312f' : '#221f20'; seg([i, 0, -24], [i, 0, 14], s); seg([-20, 0, i - 5], [20, 0, i - 5], s); }
    // 白模：逐个基本体按 buildAt 依次「落」进来
    const now = performance.now(); let animating = false;
    const faces: Face[] = [];
    if (P.buildAt !== null) P.prims.forEach((p, i) => { const k = ease((now - P.buildAt! - i * 90) / 420); if (k < 1) animating = true; faces.push(...primFaces(p, k)); });
    if (P.buildAt !== null) P.chars.forEach(ch => faces.push(...charFaces(ch, ch.id === P.selChar)));
    const L = norm(P.light === '黄昏' ? [-.85, .32, .42] : [.2, .95, .25]);
    const vis = faces.map(fc => { const q = fc.pts.map(toCam); if (q.some(v => v[2] < .05)) return null; const fcen = mul(fc.pts.reduce((s, v) => add(s, v), [0, 0, 0] as V3), 1 / fc.pts.length); if (dot(fc.n, sub(view.eye, fcen)) <= 0) return null; return { fc, q, z: q.reduce((s, v) => s + v[2], 0) / q.length }; }).filter(Boolean) as { fc: Face; q: V3[]; z: number }[];
    vis.sort((a, b) => b.z - a.z);
    for (const { fc, q } of vis) {
      const shade = .3 + .7 * Math.max(0, dot(fc.n, L)), dusk = P.light === '黄昏';
      const lum = fc.g * shade;
      ctx.fillStyle = fc.accent ? `rgb(${Math.round(150 + 105 * shade)},${Math.round(70 + 52 * shade)},${Math.round(20 + 10 * shade)})`
        : fc.sel ? `rgb(${Math.round(120 + 120 * shade)},${Math.round(70 + 60 * shade)},${Math.round(30 + 20 * shade)})`
        : `rgb(${Math.round(28 + lum * (dusk ? 215 : 200))},${Math.round(26 + lum * (dusk ? 196 : 200))},${Math.round(27 + lum * (dusk ? 180 : 198))})`;
      ctx.strokeStyle = fc.sel ? '#ff7a1a' : 'rgba(236,235,231,.22)';
      ctx.beginPath(); q.forEach((v, i) => { const p = proj(v); if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); }); ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    // 标注：人物名、物件名（引线标注风格）
    ctx.font = '500 11px "IBM Plex Mono", monospace';
    if (P.labels && P.buildAt !== null) {
      P.chars.forEach(ch => { const p = P2([ch.p[0], ch.h + .25, ch.p[2]]); if (!p) return; ctx.fillStyle = ch.id === P.selChar ? '#ff7a1a' : '#ecebe7'; ctx.fillRect(p[0] - 3, p[1] - 3, 6, 6); ctx.strokeStyle = ctx.fillStyle; ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(p[0] + 10, p[1] - 12); ctx.lineTo(p[0] + 18 + ctx.measureText(ch.name).width, p[1] - 12); ctx.stroke(); ctx.fillText(ch.name, p[0] + 14, p[1] - 16); });
      if (P.mode === 'editor') P.prims.filter(p => p.label && ease((now - P.buildAt! - P.prims.indexOf(p) * 90) / 420) >= 1).forEach(p => { const top = p.kind === 'box' ? p.c[1] + p.s[1] : p.axis === 'z' ? p.c[1] + p.s[0] * 2 : p.c[1] + p.s[1]; const q = P2([p.c[0], top, p.c[2]]); if (!q) return; ctx.fillStyle = 'rgba(154,151,146,.85)'; ctx.fillText(p.label!, q[0] + 6, q[1] - 4); ctx.fillRect(q[0] - 1.5, q[1] - 1.5, 3, 3); });
    }
    // 机位小部件（编辑视角）：机身、视锥、运镜路径
    if (P.mode === 'editor' && P.editCam) {
      const e = P.editCam, ff = norm(sub(e.target, e.eye)); let rr = cross(ff, [0, 1, 0]); rr = norm(Math.hypot(...rr) < 1e-6 ? [1, 0, 0] : rr); const uu = cross(rr, ff);
      const t = Math.tan((e.fov * Math.PI / 180) / 2) * 1.6, dd = 1.6;
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => add(add(e.eye, mul(ff, dd)), add(mul(rr, a * t * 16 / 9), mul(uu, b * t))));
      corners.forEach(cn => seg(e.eye, cn, 'rgba(255,122,26,.75)'));
      corners.forEach((cn, i) => seg(cn, corners[(i + 1) % 4], 'rgba(255,122,26,.75)'));
      seg(e.eye, e.target, 'rgba(255,122,26,.25)');
      if (e.end) { ctx.setLineDash([4, 4]); seg(e.eye, e.end, '#ff7a1a'); ctx.setLineDash([]); const q = P2(e.end); if (q) { ctx.strokeStyle = '#ff7a1a'; ctx.beginPath(); ctx.arc(q[0], q[1], 6, 0, Math.PI * 2); ctx.stroke(); ctx.fillStyle = '#ff7a1a'; ctx.fillText('终点', q[0] + 9, q[1] + 4); } }
      const q = P2(e.eye); if (q) { ctx.fillStyle = '#ff7a1a'; ctx.fillRect(q[0] - 6, q[1] - 5, 12, 10); ctx.fillStyle = '#141213'; ctx.fillRect(q[0] - 2, q[1] - 2, 4, 4); ctx.fillStyle = '#ff7a1a'; ctx.fillText('机位', q[0] + 9, q[1] + 4); }
      const tq = P2(e.target); if (tq) { ctx.strokeStyle = 'rgba(255,122,26,.6)'; ctx.beginPath(); ctx.moveTo(tq[0] - 5, tq[1]); ctx.lineTo(tq[0] + 5, tq[1]); ctx.moveTo(tq[0], tq[1] - 5); ctx.lineTo(tq[0], tq[1] + 5); ctx.stroke(); }
    }
    ctx.globalAlpha = 1;
    // 机位视角：安全框 + 三分线
    if (P.mode === 'camera') {
      const fw = Math.min(w - 40, (h - 40) * 16 / 9), fh = fw * 9 / 16, x0 = (w - fw) / 2, y0 = (h - fh) / 2;
      ctx.fillStyle = 'rgba(13,11,14,.72)'; ctx.fillRect(0, 0, w, y0); ctx.fillRect(0, y0 + fh, w, h - y0 - fh); ctx.fillRect(0, y0, x0, fh); ctx.fillRect(x0 + fw, y0, w - x0 - fw, fh);
      ctx.strokeStyle = 'rgba(236,235,231,.55)'; ctx.strokeRect(x0 + .5, y0 + .5, fw, fh);
      ctx.strokeStyle = 'rgba(236,235,231,.14)'; ctx.beginPath(); for (let i = 1; i < 3; i++) { ctx.moveTo(x0 + fw * i / 3, y0); ctx.lineTo(x0 + fw * i / 3, y0 + fh); ctx.moveTo(x0, y0 + fh * i / 3); ctx.lineTo(x0 + fw, y0 + fh * i / 3); } ctx.stroke();
      ctx.strokeStyle = '#ff7a1a'; const k = 14; ([[x0, y0, 1, 1], [x0 + fw, y0, -1, 1], [x0, y0 + fh, 1, -1], [x0 + fw, y0 + fh, -1, -1]] as number[][]).forEach(([x, y, sx, sy]) => { ctx.beginPath(); ctx.moveTo(x + sx * k, y); ctx.lineTo(x, y); ctx.lineTo(x, y + sy * k); ctx.stroke(); });
    }
    if (animating) raf.current = requestAnimationFrame(draw);
  };
  const request = () => { cancelAnimationFrame(raf.current); raf.current = requestAnimationFrame(draw); };
  useEffect(request);
  useEffect(() => { const c = canvas.current!; const ro = new ResizeObserver(request); ro.observe(c); return () => { ro.disconnect(); cancelAnimationFrame(raf.current); }; }, []);

  /* 交互 */
  const ray = (x: number, y: number) => { const L = last.current!; const f = norm(sub(L.view.target, L.view.eye)); let r = cross(f, [0, 1, 0]); r = norm(Math.hypot(...r) < 1e-6 ? [1, 0, 0] : r); const u = cross(r, f); return { o: L.view.eye, d: norm(add(f, add(mul(r, (x - L.cx) / L.F), mul(u, -(y - L.cy) / L.F)))) }; };
  const onPlane = (x: number, y: number, h: number): V3 | null => { const { o, d } = ray(x, y); if (Math.abs(d[1]) < 1e-4) return null; const t = (h - o[1]) / d[1]; return t > 0 ? add(o, mul(d, t)) : null; };
  const screen = (p: V3) => { const L = last.current!; const f = norm(sub(L.view.target, L.view.eye)); let r = cross(f, [0, 1, 0]); r = norm(Math.hypot(...r) < 1e-6 ? [1, 0, 0] : r); const u = cross(r, f); const d = sub(p, L.view.eye), z = dot(d, f); return z > .05 ? [L.cx + dot(d, r) / z * L.F, L.cy - dot(d, u) / z * L.F] : null; };
  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top; e.currentTarget.setPointerCapture(e.pointerId);
    const P = props.current;
    if (P.mode === 'editor' && P.editCam) for (const which of ['end', 'eye'] as const) { const p = which === 'eye' ? P.editCam.eye : P.editCam.end; if (!p) continue; const s = screen(p); if (s && Math.hypot(s[0] - x, s[1] - y) < 14) { drag.current = { kind: 'cam', which, x, y, plane: p[1] }; return; } }
    if (P.mode === 'editor' && P.buildAt !== null) { let best: { id: string; d: number } | null = null; for (const ch of P.chars) { const s = screen([ch.p[0], ch.h * .5, ch.p[2]]); if (!s) continue; const d = Math.hypot(s[0] - x, s[1] - y); if (d < 30 && (!best || d < best.d)) best = { id: ch.id, d }; } if (best) { onSelChar(best.id); drag.current = { kind: 'char', id: best.id, x, y }; return; } }
    if (P.mode === 'editor') onSelChar(null);
    drag.current = { kind: e.shiftKey || e.button === 2 ? 'pan' : 'orbit', x, y };
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current; if (!d) return; const rect = e.currentTarget.getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top, o = orbit.current;
    if (d.kind === 'orbit' && props.current.mode === 'editor') { o.yaw -= (x - d.x) * .008; o.pitch = Math.max(.08, Math.min(1.45, o.pitch + (y - d.y) * .006)); request(); }
    else if (d.kind === 'pan' && props.current.mode === 'editor') { const L = last.current!; const f = norm(sub(L.view.target, L.view.eye)); const r = norm(cross(f, [0, 1, 0])); const k = o.dist / L.F; o.target = add(o.target, add(mul(r, -(x - d.x) * k), [0, (y - d.y) * k, 0])); request(); }
    else if (d.kind === 'char' && d.id) { const p = onPlane(x, y, 0); if (p) onMoveChar(d.id, [Math.max(-9, Math.min(9, p[0])), 0, Math.max(-14, Math.min(9, p[2]))]); }
    else if (d.kind === 'cam' && d.which) { const p = onPlane(x, y, d.plane ?? 1.5); if (p) onMoveCam(d.which, p); }
    d.x = x; d.y = y;
  };
  const up = () => { drag.current = null; };
  const wheel = (e: React.WheelEvent) => { if (props.current.mode !== 'editor') return; const o = orbit.current; o.dist = Math.max(4, Math.min(40, o.dist * (1 + e.deltaY * .001))); request(); };
  return <canvas ref={canvas} className="vp-canvas" data-mode={mode} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onWheel={wheel} onContextMenu={e => e.preventDefault()} aria-label="白模视口" />;
}
