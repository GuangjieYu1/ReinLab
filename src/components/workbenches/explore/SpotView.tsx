import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { sunFor, type Prim, type Spot } from './model';

// 机位的 2.5D 白模：Canvas 2D 软渲染（不用 WebGL）。按当前时刻的太阳方向投影影子，被山挡住时没有直射光。
// 两种视角：环绕（拖动旋转、滚轮缩放）与机位（按镜头焦距算视角，叠三分线和 3:2 取景框）。

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const D = Math.PI / 180;
const dirOf = (az: number): V3 => [Math.sin(az * D), 0, -Math.cos(az * D)];
const COLOR: Record<Prim['kind'], string> = { building: '#d9d7d1', tree: '#7d7a74', wall: '#a8978a', water: '#b9c3c8', rail: '#3a3837', lantern: '#ff7a1a', torii: '#ff7a1a', sand: '#efede8', hill: '#cbc6be', path: '#e3e0da' };
const FLAT = new Set(['water', 'path', 'rail']);
const shade = (hex: string, k: number) => { const n = parseInt(hex.slice(1), 16), f = (c: number) => Math.round(Math.max(0, Math.min(255, c * k))); return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`; };
const focal = (lens: string) => +(lens.match(/\d+/g)?.slice(-1)[0] ?? 50);

function boxes(p: Prim): { c: V3[]; kind: Prim['kind'] }[] {
  const mk = (x: number, z: number, w: number, d: number, y0: number, h: number, kind: Prim['kind']) => ({ kind, c: [[x - w / 2, y0, z - d / 2], [x + w / 2, y0, z - d / 2], [x + w / 2, y0, z + d / 2], [x - w / 2, y0, z + d / 2], [x - w / 2, y0 + h, z - d / 2], [x + w / 2, y0 + h, z - d / 2], [x + w / 2, y0 + h, z + d / 2], [x - w / 2, y0 + h, z + d / 2]] as V3[] });
  if (p.kind === 'tree') return [mk(p.x, p.z, .45, .45, 0, p.h * .4, 'rail'), mk(p.x, p.z, p.w, p.d, p.h * .35, p.h * .65, 'tree')];
  return [mk(p.x, p.z, p.w, p.d, p.y ?? 0, p.h, p.kind)];
}
const FACES = [[4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
function hull(pts: [number, number][]) {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]); if (p.length < 3) return p;
  const cr = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: [number, number][] = [], up: [number, number][] = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return [...lo.slice(0, -1), ...up.slice(0, -1)];
}

export default function SpotView({ spot, t, palette, mode }: { spot: Spot; t: number; palette?: string[]; mode: 'orbit' | 'camera' }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 600, h: 400 });
  const [orbit, setOrbit] = useState({ yaw: spot.dir + 210, pitch: 42, dist: Math.max(42, spot.dist * 3.5) });
  useEffect(() => setOrbit({ yaw: spot.dir + 210, pitch: 42, dist: Math.max(42, spot.dist * 3.5) }), [spot.id, spot.dir, spot.dist]);
  useLayoutEffect(() => { const el = cv.current!.parentElement!; const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight })); ro.observe(el); return () => ro.disconnect(); }, []);
  useEffect(() => {
    const el = cv.current; if (!el) return;
    const wheel = (e: WheelEvent) => { e.preventDefault(); setOrbit(o => ({ ...o, dist: Math.max(8, Math.min(140, o.dist * (e.deltaY < 0 ? .9 : 1.1))) })); };
    el.addEventListener('wheel', wheel, { passive: false }); return () => el.removeEventListener('wheel', wheel);
  }, []);

  useEffect(() => {
    const el = cv.current; if (!el) return; const dpr = window.devicePixelRatio || 1;
    el.width = size.w * dpr; el.height = size.h * dpr; const g = el.getContext('2d')!; g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sun = sunFor(spot, t), lit = sun.alt > 0 && !sun.blocked;
    const sv: V3 = [Math.sin(sun.az * D) * Math.cos(sun.alt * D), Math.sin(sun.alt * D), -Math.cos(sun.az * D) * Math.cos(sun.alt * D)];
    const camPos: V3 = (() => { const d = dirOf(spot.dir); return [-d[0] * spot.dist, 1.5, -d[2] * spot.dist]; })();
    let eye: V3, target: V3, fovY: number;
    // 机位视角的取景框：人像竖拍 2:3，风光横拍 3:2；焦距按取景框的高度换算，框里看到的就是这支镜头的视角。
    const vertical = spot.kind === 'portrait', aspect = vertical ? 2 / 3 : 3 / 2;
    const fh = Math.min(size.h - 30, (size.w - 30) / aspect), fwid = fh * aspect, x0 = (size.w - fwid) / 2, y0 = (size.h - fh) / 2;
    if (mode === 'camera') { eye = camPos; target = [0, 1.1, 0]; const f = focal(spot.lens); fovY = 2 * Math.atan((vertical ? 36 : 24) / (2 * f)); }
    else { const y = orbit.yaw * D, p = orbit.pitch * D; target = [0, 1, 0]; eye = [Math.sin(y) * Math.cos(p) * orbit.dist, Math.sin(p) * orbit.dist + 1, -Math.cos(y) * Math.cos(p) * orbit.dist]; fovY = 50 * D; }
    const fw = norm(sub(target, eye)), rt = norm(cross(fw, [0, 1, 0])), up = cross(rt, fw), fl = (mode === 'camera' ? fh : size.h) / 2 / Math.tan(fovY / 2);
    const P = (v: V3): [number, number, number] => { const r = sub(v, eye), z = dot(r, fw); return [size.w / 2 + dot(r, rt) / z * fl, size.h / 2 - dot(r, up) / z * fl, z]; };
    // 近平面裁剪：穿过镜头的长条（小路、水渠、铁轨）只裁掉身后那一段，不整块丢掉。
    const NEAR = .2;
    const clipProj = (vs: V3[]) => {
      const cs = vs.map(v => { const r = sub(v, eye); return [dot(r, rt), dot(r, up), dot(r, fw)] as V3; });
      const out: V3[] = [];
      cs.forEach((a, i) => { const b = cs[(i + 1) % cs.length], ai = a[2] >= NEAR, bi = b[2] >= NEAR;
        if (ai) out.push(a);
        if (ai !== bi) { const k = (NEAR - a[2]) / (b[2] - a[2]); out.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, NEAR]); } });
      return out.map(([x, y, z]) => [size.w / 2 + x / z * fl, size.h / 2 - y / z * fl, z] as [number, number, number]);
    };
    // 天空与地面
    const sky = g.createLinearGradient(0, 0, 0, size.h);
    sky.addColorStop(0, lit ? '#e6e4df' : sun.alt > -6 ? '#3a4150' : '#1c1f26'); sky.addColorStop(1, lit ? '#f0eeea' : sun.alt > -6 ? '#8a7a70' : '#2a2a2e');
    g.fillStyle = sky; g.fillRect(0, 0, size.w, size.h);
    const ground: V3[] = [[-90, 0, -90], [90, 0, -90], [90, 0, 90], [-90, 0, 90]];
    const gp = clipProj(ground);
    if (gp.length > 2) { g.fillStyle = lit ? '#ecebe7' : '#55524f'; g.beginPath(); gp.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath(); g.fill(); }
    g.strokeStyle = lit ? '#14121312' : '#ffffff10'; g.lineWidth = 1;
    for (let i = -60; i <= 60; i += 5) for (const [a, b] of [[[i, 0, -60], [i, 0, 60]], [[-60, 0, i], [60, 0, i]]] as [V3, V3][]) { const pa = P(a), pb = P(b); if (pa[2] > .5 && pb[2] > .5) { g.beginPath(); g.moveTo(pa[0], pa[1]); g.lineTo(pb[0], pb[1]); g.stroke(); } }
    // 体块（含模特）
    const all = [...spot.scene, { x: 0, z: 0, w: .45, d: .3, h: 1.68, kind: 'building' as const, model: true }].flatMap(p => boxes(p).map(b => ({ ...b, model: 'model' in p })));
    // 影子：顶点沿太阳方向投到地面，取凸包。
    if (lit) {
      g.fillStyle = 'rgba(20,18,19,.2)';
      for (const b of all) {
        if (FLAT.has(b.kind)) continue;
        const k = Math.min(1 / Math.max(.05, sv[1]), 14);
        const pts = b.c.map(v => [v[0] - sv[0] * v[1] * k, v[2] - sv[2] * v[1] * k] as [number, number]);
        const h2 = clipProj(hull(pts).map(([x, z]) => [x, .01, z] as V3));
        if (h2.length < 3) continue;
        g.beginPath(); h2.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath(); g.fill();
      }
    }
    type F = { pts: [number, number, number][]; z: number; fill: string; stroke: string };
    const faces: F[] = [];
    for (const b of all) for (const f of FACES) {
      const v = f.map(i => b.c[i]); const n = norm(cross(sub(v[2], v[0]), sub(v[1], v[0]))); // FACES 的顶点顺序从外面看是顺时针，叉乘反过来得到朝外的法线
      const c: V3 = [v.reduce((s, q) => s + q[0], 0) / 4, v.reduce((s, q) => s + q[1], 0) / 4, v.reduce((s, q) => s + q[2], 0) / 4];
      if (dot(n, sub(eye, c)) <= 0) continue;
      const pts = clipProj(v); if (pts.length < 3) continue;
      const base = b.model ? (palette?.[0] ?? '#141213') : COLOR[b.kind];
      const k = lit ? .72 + .38 * Math.max(0, dot(n, sv)) : (b.kind === 'lantern' ? 1.1 : .55);
      faces.push({ pts, z: Math.hypot(...sub(c, eye)), fill: shade(base, k), stroke: b.model ? '#ff7a1a' : lit ? '#14121355' : '#00000066' });
    }
    faces.sort((a, b) => b.z - a.z);
    g.lineWidth = .8;
    for (const f of faces) { g.beginPath(); f.pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath(); g.fillStyle = f.fill; g.fill(); g.strokeStyle = f.stroke; g.stroke(); }
    // 灯笼在暗处发光
    if (!lit) for (const p of spot.scene.filter(x => x.kind === 'lantern')) { const q = P([p.x, (p.y ?? 0) + .4, p.z]); if (q[2] < .2) continue; const r = 60 / q[2] * 6; const gr = g.createRadialGradient(q[0], q[1], 0, q[0], q[1], r); gr.addColorStop(0, '#ff7a1a88'); gr.addColorStop(1, '#ff7a1a00'); g.fillStyle = gr; g.fillRect(q[0] - r, q[1] - r, r * 2, r * 2); }
    if (mode === 'orbit') {
      // 机位：相机体 + 视锥
      const f = focal(spot.lens), hf = Math.atan(36 / (2 * f)), vf = Math.atan(24 / (2 * f)), d = dirOf(spot.dir), side: V3 = [-d[2], 0, d[0]], L = spot.dist + 6;
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [camPos[0] + (d[0] + side[0] * Math.tan(hf) * a) * L, camPos[1] + Math.tan(vf) * b * L, camPos[2] + (d[2] + side[2] * Math.tan(hf) * a) * L] as V3);
      const c0 = P(camPos);
      if (c0[2] > .2) {
        g.strokeStyle = '#ff7a1a'; g.lineWidth = 1.2; g.setLineDash([4, 3]);
        const cp = corners.map(P); if (cp.every(q => q[2] > .2)) { cp.forEach(q => { g.beginPath(); g.moveTo(c0[0], c0[1]); g.lineTo(q[0], q[1]); g.stroke(); }); g.beginPath(); cp.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath(); g.stroke(); }
        g.setLineDash([]); g.fillStyle = '#141213'; g.fillRect(c0[0] - 7, c0[1] - 5, 14, 10); g.fillStyle = '#ff7a1a'; g.fillRect(c0[0] - 2, c0[1] - 2, 4, 4);
        g.font = '500 11px "IBM Plex Mono", monospace'; g.fillStyle = '#141213'; g.fillText(`${spot.lens} · ${spot.dist}m`, c0[0] + 10, c0[1] - 8);
      }
      // 模特标签
      const m0 = P([0, 2.3, 0]);
      if (m0[2] > .2) { g.font = '600 11px "DM Sans", sans-serif'; const tw = g.measureText('模特').width + 10; g.fillStyle = '#ff7a1a'; g.fillRect(m0[0] - tw / 2, m0[1] - 16, tw, 16); g.fillStyle = '#141213'; g.fillText('模特', m0[0] - tw / 2 + 5, m0[1] - 4); g.beginPath(); g.moveTo(m0[0], m0[1]); g.lineTo(m0[0], m0[1] + 6); g.strokeStyle = '#ff7a1a'; g.stroke(); }
      // 太阳方向
      if (sun.alt > -2) { const s0 = P([0, 1.7, 0]), s1 = P([sv[0] * 30, 1.7 + sv[1] * 30, sv[2] * 30]); if (s0[2] > .2 && s1[2] > .2) { g.strokeStyle = sun.blocked ? '#9a9792' : '#ff7a1a'; g.lineWidth = 2; g.beginPath(); g.moveTo(s0[0], s0[1]); g.lineTo(s1[0], s1[1]); g.stroke(); g.beginPath(); g.arc(s1[0], s1[1], 9, 0, Math.PI * 2); g.fillStyle = sun.blocked ? '#f0eeea' : '#ff7a1a'; g.fill(); g.stroke(); } }
    } else {
      // 机位视角：取景框 + 三分线
      g.fillStyle = 'rgba(20,18,19,.55)'; g.fillRect(0, 0, size.w, y0); g.fillRect(0, y0 + fh, size.w, size.h); g.fillRect(0, y0, x0, fh); g.fillRect(x0 + fwid, y0, x0, fh);
      g.strokeStyle = '#fbfbf9aa'; g.lineWidth = 1; g.strokeRect(x0, y0, fwid, fh);
      g.strokeStyle = '#fbfbf955'; for (let i = 1; i < 3; i++) { g.beginPath(); g.moveTo(x0 + fwid * i / 3, y0); g.lineTo(x0 + fwid * i / 3, y0 + fh); g.moveTo(x0, y0 + fh * i / 3); g.lineTo(x0 + fwid, y0 + fh * i / 3); g.stroke(); }
      g.font = '500 11px "IBM Plex Mono", monospace'; g.fillStyle = '#fbfbf9'; g.fillText(`${spot.lens}  ${spot.ap}  ${spot.ss}  ${spot.iso}`, x0 + 8, y0 + 18);
    }
  }, [spot, t, palette, mode, orbit, size]);

  return <canvas ref={cv} className="sv" style={{ width: size.w, height: size.h }} data-mode={mode}
    onPointerDown={e => { if (mode !== 'orbit') return; const s = { x: e.clientX, y: e.clientY, o: orbit }; (e.target as HTMLElement).setPointerCapture(e.pointerId);
      const move = (m: PointerEvent) => setOrbit({ ...s.o, yaw: s.o.yaw - (m.clientX - s.x) * .4, pitch: Math.max(8, Math.min(80, s.o.pitch + (m.clientY - s.y) * .3)) });
      const upf = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', upf); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', upf); }} />;
}
