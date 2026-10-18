// Perspective handoff: a flat logo morphs onto a quad measured on a 3D surface.
// Four corner points are interpolated and turned into a CSS matrix3d (a 2D
// homography), so the logo can lie down onto an oblique glass face exactly.

export type Point = [number, number];
export type Quad = [Point, Point, Point, Point]; // top-left, top-right, bottom-left, bottom-right

type M3 = number[];
const adj = (m: M3): M3 => [
  m[4] * m[8] - m[5] * m[7], m[2] * m[7] - m[1] * m[8], m[1] * m[5] - m[2] * m[4],
  m[5] * m[6] - m[3] * m[8], m[0] * m[8] - m[2] * m[6], m[2] * m[3] - m[0] * m[5],
  m[3] * m[7] - m[4] * m[6], m[1] * m[6] - m[0] * m[7], m[0] * m[4] - m[1] * m[3],
];
const mul = (a: M3, b: M3): M3 => {
  const c: M3 = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { let sum = 0; for (let k = 0; k < 3; k++) sum += a[3 * i + k] * b[3 * k + j]; c[3 * i + j] = sum; }
  return c;
};
const mulVec = (m: M3, v: number[]) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
function basis(q: Quad): M3 {
  const [[x1, y1], [x2, y2], [x3, y3], [x4, y4]] = q;
  const m = [x1, x2, x3, y1, y2, y3, 1, 1, 1];
  const v = mulVec(adj(m), [x4, y4, 1]);
  return mul(m, [v[0], 0, 0, 0, v[1], 0, 0, 0, v[2]]);
}

/** matrix3d that maps a w×h box (transform-origin 0 0) onto the quad. */
export function matrixFor(w: number, h: number, quad: Quad): string {
  const t = mul(basis(quad), adj(basis([[0, 0], [w, 0], [0, h], [w, h]])));
  const n = t.map(value => value / t[8]);
  return `matrix3d(${[n[0], n[3], 0, n[6], n[1], n[4], 0, n[7], 0, 0, 1, 0, n[2], n[5], 0, n[8]].map(value => Number.isFinite(value) ? value.toFixed(9) : '0').join(',')})`;
}

export function rectQuad(x: number, y: number, w: number, h: number): Quad {
  return [[x, y], [x + w, y], [x, y + h], [x + w, y + h]];
}

/** Reads four zero-size corner markers ([data-corner="0..3"]) inside an element. */
export function markerQuad(root: Element | null, origin: { x: number; y: number; width?: number; height?: number }): Quad | null {
  if (!root) return null;
  const points = [0, 1, 2, 3].map(index => {
    const marker = root.querySelector(`[data-corner="${index}"]`);
    if (!marker) return null;
    const box = marker.getBoundingClientRect();
    return [box.x + box.width / 2 - origin.x, box.y + box.height / 2 - origin.y] as Point;
  });
  if (points.some(point => !point)) return null;
  const quad = points as Quad;
  // A collapsed or off-screen face is not a useful landing target.
  const area = Math.abs((quad[1][0] - quad[0][0]) * (quad[2][1] - quad[0][1]) - (quad[2][0] - quad[0][0]) * (quad[1][1] - quad[0][1]));
  if (area <= 64) return null;
  // Ignore projections far outside the frame (camera not settled yet).
  if (origin.width && origin.height && quad.some(([x, y]) => x < -origin.width! || x > origin.width! * 2 || y < -origin.height! || y > origin.height! * 2)) return null;
  return quad;
}

const ease = (t: number) => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

/** Corner-wise interpolation with a gentle lift toward the viewer mid-flight. */
export function flightQuad(from: Quad, to: Quad, progress: number): Quad {
  const e = ease(progress), lift = Math.sin(Math.PI * progress);
  const mixed = from.map(([x, y], index) => [x + (to[index][0] - x) * e, y + (to[index][1] - y) * e]) as Quad;
  const cx = mixed.reduce((sum, [x]) => sum + x, 0) / 4, cy = mixed.reduce((sum, [, y]) => sum + y, 0) / 4;
  const grow = 1 + .16 * lift, rise = -54 * lift;
  return mixed.map(([x, y]) => [cx + (x - cx) * grow, cy + (y - cy) * grow + rise]) as Quad;
}
