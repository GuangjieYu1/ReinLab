// WGS84 → GCJ-02（国内地图偏移，公开算法）。境外坐标原样返回（不套国内偏移）。
const A = 6378245.0, EE = 0.00669342162296594323;
// 分区矩形 [北, 西, 南, 东]：粗矩形会把日本、韩国框进来，境外坐标被错误偏移
const IN = [[49.2204, 79.4462, 42.8899, 96.33], [54.1415, 109.6872, 39.3742, 135.0002], [42.8899, 73.1246, 29.5297, 124.143255],
  [29.5297, 82.9684, 26.7186, 97.0352], [29.5297, 97.0253, 20.414096, 124.367395], [20.414096, 107.975793, 17.871542, 111.744104]];
const OUT = [[25.398623, 119.921265, 21.785006, 122.497559], [22.284, 101.8652, 20.0988, 106.665], [21.5422, 106.4525, 20.4878, 108.051],
  [55.8175, 109.0323, 50.3257, 119.127], [55.8175, 127.4568, 49.5574, 137.0227], [44.8922, 131.2662, 42.5692, 137.0227]];
const inRect = (lng: number, lat: number, r: number[]) => lat <= r[0] && lng >= r[1] && lat >= r[2] && lng <= r[3];
const outOfChina = (lng: number, lat: number) => !IN.some(r => inRect(lng, lat, r)) || OUT.some(r => inRect(lng, lat, r));
function tLat(x: number, y: number) {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  r += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
  r += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
  return r;
}
function tLng(x: number, y: number) {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  r += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
  r += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;
  return r;
}
export function wgsToGcj(lng: number, lat: number): { at: [number, number]; china: boolean } {
  if (outOfChina(lng, lat)) return { at: [lng, lat], china: false };
  let dLat = tLat(lng - 105, lat - 35), dLng = tLng(lng - 105, lat - 35);
  const rad = lat / 180 * Math.PI; let m = Math.sin(rad); m = 1 - EE * m * m; const s = Math.sqrt(m);
  dLat = (dLat * 180) / ((A * (1 - EE)) / (m * s) * Math.PI); dLng = (dLng * 180) / (A / s * Math.cos(rad) * Math.PI);
  return { at: [lng + dLng, lat + dLat], china: true };
}
/** 高德官方 marker URI（用户点击才唤起；不传持续位置）。 */
export function amapLink(lng: number, lat: number, name: string) {
  const g = wgsToGcj(lng, lat);
  if (!g.china) return null;   // 境外不保证高德覆盖，不给链接
  return `https://uri.amap.com/marker?position=${g.at[0].toFixed(6)},${g.at[1].toFixed(6)}&name=${encodeURIComponent(name)}&coordinate=gaode&callnative=1`;
}

/** 两点距离（米）。 */
export function meters(a: [number, number], b: [number, number]) {
  const R = 6371008.8, r = Math.PI / 180, dLat = (b[1] - a[1]) * r, dLng = (b[0] - a[0]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
/** 点在多边形内（射线法，经纬度平面近似，街区尺度够用）。 */
export function inside(p: [number, number], ring: [number, number][]) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
