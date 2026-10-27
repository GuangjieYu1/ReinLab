// 太阳位置（NOAA 简化公式，误差约 0.5°，够做机位规划）。方位角从正北顺时针，高度角为地平线以上。
// 时间一律用「当天分钟数」+ 时区，示例固定在京都东山。

export const KYOTO = { lat: 35.012, lon: 135.785, tz: 9 };
const R = Math.PI / 180;

export function sunAt(date: { y: number; m: number; d: number }, minutes: number, loc = KYOTO) {
  const ms = Date.UTC(date.y, date.m - 1, date.d, 0, 0) + (minutes - loc.tz * 60) * 60000;
  const n = ms / 86400000 + 2440587.5 - 2451545.0;
  const g = (357.529 + .98560028 * n) * R, q = 280.459 + .98564736 * n;
  const L = (q + 1.915 * Math.sin(g) + .020 * Math.sin(2 * g)) * R, e = (23.439 - .00000036 * n) * R;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)), dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = ((18.697374558 + 24.06570982441908 * n) % 24 + 24) % 24;
  const ha = (gmst * 15 + loc.lon) * R - ra, lat = loc.lat * R;
  const alt = Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(lat) - Math.sin(lat) * Math.cos(ha));
  return { az: ((az / R) % 360 + 360) % 360, alt: alt / R };
}

/** 一天里的关键时刻：日出、日落、金色时刻（高度角 -4°~6°）与蓝调时刻（-6°~-4°）。 */
export function dayTimes(date: { y: number; m: number; d: number }, loc = KYOTO) {
  const alt = (t: number) => sunAt(date, t, loc).alt;
  const cross = (from: number, to: number, a: number) => { let t = from; const up = alt(from) < a; for (; t < to; t++) if ((alt(t) >= a) === up) break; return t; };
  const noon = Array.from({ length: 24 * 4 }, (_, i) => i * 15).reduce((b, t) => alt(t) > alt(b) ? t : b, 0);
  return {
    noon,
    blueAm: [cross(180, noon, -6), cross(180, noon, -4)] as [number, number],
    goldAm: [cross(180, noon, -4), cross(180, noon, 6)] as [number, number],
    sunrise: cross(180, noon, -.833), sunset: cross(noon, 1380, -.833),
    goldPm: [cross(noon, 1380, 6), cross(noon, 1380, -4)] as [number, number],
    bluePm: [cross(noon, 1380, -4), cross(noon, 1380, -6)] as [number, number],
  };
}

export const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;
/** 光线类型：比较太阳方位与镜头朝向。 */
export function lightOf(sunAz: number, sunAlt: number, camDir: number) {
  if (sunAlt < -4) return '夜景 / 人工光';
  if (sunAlt < 0) return '蓝调 · 无直射光';
  const d = Math.abs(((sunAz - camDir) % 360 + 540) % 360 - 180); // 0 = 太阳在镜头正前方（逆光），180 = 在镜头正后方（顺光）
  const kind = d < 50 ? '逆光' : d > 130 ? '顺光' : '侧光';
  return sunAlt < 6 ? `${kind} · 金色时刻` : sunAlt > 40 ? `${kind} · 顶光偏硬` : kind;
}
