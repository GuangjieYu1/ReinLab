// 登录页背景的 ∞ 缎带：沿伯努利双纽线走一圈、带半圈扭转（莫比乌斯），
// 由几百条横向细线构成。Canvas 2D 软渲染，不使用 WebGL。

type Vec = [number, number, number];

const RUNGS = 560;
const HALF_WIDTH = .34;

const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a: Vec, s: number): Vec => [a[0] * s, a[1] * s, a[2] * s];
const norm = (a: Vec): Vec => scale(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function center(u: number): Vec {
  const s = Math.sin(u), c = Math.cos(u), d = 1 + s * s;
  return [1.7 * c / d, 1.7 * s * c / d, .42 * s];
}

// 固定种子的伪随机，保证每次飞散的方向一致、可复现。
function seeded(i: number) { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }

// 预先算好每条横线两端在模型空间中的位置，以及飞散时的方向与力度。
const MODEL = Array.from({ length: RUNGS }, (_, i) => {
  const u = i / RUNGS * Math.PI * 2;
  const p = center(u);
  const t = norm(sub(center(u + .001), center(u - .001)));
  const up: Vec = [0, 0, 1];
  const n = norm(sub(up, scale(t, dot(up, t))));
  const b = cross(t, n);
  const twist = u / 2;
  const dir: Vec = [
    Math.cos(twist) * n[0] + Math.sin(twist) * b[0],
    Math.cos(twist) * n[1] + Math.sin(twist) * b[1],
    Math.cos(twist) * n[2] + Math.sin(twist) * b[2],
  ];
  const angle = seeded(i) * Math.PI * 2;
  return {
    a: sub(p, scale(dir, HALF_WIDTH)), b: [p[0] + dir[0] * HALF_WIDTH, p[1] + dir[1] * HALF_WIDTH, p[2] + dir[2] * HALF_WIDTH] as Vec, u,
    fly: { x: Math.cos(angle), y: Math.sin(angle), force: .35 + seeded(i + 999) * .9, spin: (seeded(i + 77) - .5) * 2.4 },
  };
});

export type RibbonState = {
  time: number;     // 秒
  yaw: number;      // 鼠标视差
  pitch: number;
  zoom: number;     // 1 = 常态
  cx: number;       // 缎带中心的水平位置（视口宽度的比例）
  frontal: number;  // 0..1 转向正面，∞ 形完整可读
  scatter: number;  // 0..1 细线剥离飞散
  morph: number;    // 0..1 细线收拢成刻度环（与选台开场的圆环重合）
  ring: { x: number; y: number; r: number };
  fade: number;     // 0..1 整体透明度
  signal: number;   // 0..1 橙色信号段的位置
  ink: string;
  accent: string;
  weight: number;   // 线条浓度倍数（警示态更浓）
};

export function drawRibbon(ctx: CanvasRenderingContext2D, width: number, height: number, s: RibbonState) {
  ctx.clearRect(0, 0, width, height);
  if (s.fade <= 0) return;
  const f = s.frontal;
  const wrappedRoll = Math.atan2(Math.sin(s.time * .035), Math.cos(s.time * .035));
  const yaw = lerp(Math.sin(s.time * .12) * .45 + s.yaw, 0, f);
  const pitch = lerp(-1.05 + Math.sin(s.time * .09) * .08 + s.pitch, -.2, f);
  const roll = lerp(wrappedRoll, 0, f);
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
  const unit = Math.min(width, height * 1.6) * .21 * s.zoom;
  const ox = width * s.cx, oy = height * .52, camera = 5.4;
  const reach = Math.max(width, height) * .9;
  const sc = s.scatter * s.scatter;

  const project = (v: Vec) => {
    // 先绕 z 轴缓慢自转，再俯仰、偏航，最后透视投影。
    let x = v[0] * cr - v[1] * sr, y = v[0] * sr + v[1] * cr, z = v[2];
    const y2 = y * cp - z * sp; z = y * sp + z * cp; y = y2;
    const x2 = x * cy + z * sy; z = -x * sy + z * cy; x = x2;
    const k = camera / (camera - z);
    return { x: ox + x * unit * k, y: oy + y * unit * k, z };
  };

  const lines = MODEL.map(r => ({ a: project(r.a), b: project(r.b), u: r.u, fly: r.fly }));
  lines.sort((p, q) => (p.a.z + p.b.z) - (q.a.z + q.b.z));

  ctx.lineCap = 'round';
  const signalU = s.signal * Math.PI * 2;
  const mo = s.morph < .5 ? 4 * s.morph ** 3 : 1 - Math.pow(-2 * s.morph + 2, 3) / 2;
  for (const l of lines) {
    const depth = ((l.a.z + l.b.z) / 2 + 1.2) / 2.4; // 远 0 → 近 1
    const gap = Math.abs(((l.u - signalU + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    const lit = gap < .055 && s.scatter < .3;
    let ax = l.a.x, ay = l.a.y, bx = l.b.x, by = l.b.y;
    if (sc > 0) {
      // 剥离：每条细线沿自己的方向飞出，同时绕中点旋转、变短。
      const dx = l.fly.x * l.fly.force * reach * sc, dy = l.fly.y * l.fly.force * reach * sc;
      const mx = (ax + bx) / 2 + dx, my = (ay + by) / 2 + dy;
      const hx = (bx - ax) / 2 * (1 - sc * .6), hy = (by - ay) / 2 * (1 - sc * .6);
      const r = l.fly.spin * sc, c = Math.cos(r), si = Math.sin(r);
      ax = mx - (hx * c - hy * si); ay = my - (hx * si + hy * c);
      bx = mx + (hx * c - hy * si); by = my + (hx * si + hy * c);
    }
    if (mo > 0) {
      // 每条细线按它在缎带上的位置，落到圆环上对应角度，成为一根径向刻度。
      const angle = l.u - Math.PI / 2, major = Math.round(l.u / (Math.PI * 2) * RUNGS) % 14 === 0;
      const inner = s.ring.r - (major ? 9 : 4), outer = s.ring.r + (major ? 9 : 4);
      const cx = Math.cos(angle), cy2 = Math.sin(angle);
      ax += (s.ring.x + cx * inner - ax) * mo; ay += (s.ring.y + cy2 * inner - ay) * mo;
      bx += (s.ring.x + cx * outer - bx) * mo; by += (s.ring.y + cy2 * outer - by) * mo;
    }
    const base = lit && mo < .2 ? .85 : Math.min(1, (.08 + depth * .38) * s.weight);
    ctx.globalAlpha = s.fade * (base + (.55 - base) * mo) * (1 - s.scatter * .85);
    ctx.strokeStyle = lit && mo < .2 ? s.accent : s.ink;
    ctx.lineWidth = (lit && mo < .2 ? 1.4 : .6 + depth * .7) * (1 - mo) + .8 * mo;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
