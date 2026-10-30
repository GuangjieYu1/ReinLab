// 真实地点的太阳（契约第 2 节，前后端同一套约定）：
// 方位真北 0° 顺时针；高度角度数；金色时刻 −4°～6°，蓝调 −6°～−4°；日出日落按 SunCalc 默认（上缘接触地平线）。
// 时间都按拍摄地点的 IANA 时区换算，不用浏览器所在时区。
import SunCalc from 'suncalc';

SunCalc.addTime(-4, 'goldStartAm', 'goldEndPm');   // −4°：金色时刻的下沿 / 蓝调的上沿

const DEG = 180 / Math.PI;

export function sunPos(at: Date, lng: number, lat: number) {
  const p = SunCalc.getPosition(at, lat, lng);
  // SunCalc 的方位从正南起算、向西为正（弧度）；换成真北 0° 顺时针
  return { az: (p.azimuth * DEG + 180 + 360) % 360, alt: p.altitude * DEG };
}

/** 某时区里某个时刻相对 UTC 的偏移（分钟）。 */
function offsetMin(at: Date, tz: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(at);
  const v = (t: string) => Number(parts.find(p => p.type === t)?.value);
  const asUtc = Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute'), v('second'));
  return Math.round((asUtc - at.getTime()) / 60000);
}

/** 当地日期 + 当地分钟数（可以超过 1440，表示跨到第二天）→ 真实时刻。 */
export function localToDate(day: string, minutes: number, tz: string) {
  const [y, m, d] = day.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  const off = offsetMin(new Date(guess), tz);
  const t = guess - off * 60000;
  // 夏令时边界附近再校一次
  const off2 = offsetMin(new Date(t), tz);
  return new Date(off2 === off ? t : guess - off2 * 60000);
}

/** 真实时刻 → 以 day 当地 0 点为起点的分钟数（可为负或超过 1440）。 */
export function dateToLocal(at: Date | string, day: string, tz: string) {
  const t = typeof at === 'string' ? new Date(at) : at;
  return Math.round((t.getTime() - localToDate(day, 0, tz).getTime()) / 60000);
}

export const hm = (m: number) => { const x = ((Math.round(m) % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };

export type DayLight = {
  sunrise: number | null; sunset: number | null;
  blueAm: [number, number] | null; goldAm: [number, number] | null;
  goldPm: [number, number] | null; bluePm: [number, number] | null;
};

/** 一天的光线时段（当地分钟）。极昼极夜时对应项为 null。 */
export function dayLight(day: string, tz: string, lng: number, lat: number): DayLight {
  const noon = localToDate(day, 12 * 60, tz);
  const t = SunCalc.getTimes(noon, lat, lng) as unknown as Record<string, Date>;
  const m = (k: string) => { const v = t[k]; return v && !isNaN(v.getTime()) ? dateToLocal(v, day, tz) : null; };
  const pair = (a: number | null, b: number | null): [number, number] | null => a !== null && b !== null ? [a, b] : null;
  return {
    sunrise: m('sunrise'), sunset: m('sunset'),
    blueAm: pair(m('dawn'), m('goldStartAm')), goldAm: pair(m('goldStartAm'), m('goldenHourEnd')),
    goldPm: pair(m('goldenHour'), m('goldEndPm')), bluePm: pair(m('goldEndPm'), m('dusk')),
  };
}

/** 某方位的地平线仰角（地平线曲线按方位线性插值）。没有曲线返回 null。 */
export function horizonAt(horizon: { azimuth: number; elevation: number }[] | null | undefined, az: number) {
  if (!horizon || horizon.length === 0) return null;
  const h = [...horizon].sort((a, b) => a.azimuth - b.azimuth);
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    const span = ((b.azimuth - a.azimuth) + 360) % 360 || 360;
    const off = ((az - a.azimuth) + 360) % 360;
    if (off <= span) return a.elevation + (b.elevation - a.elevation) * (off / span);
  }
  return h[0].elevation;
}
