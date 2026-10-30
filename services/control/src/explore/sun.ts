/**
 * 服务端太阳计算（design/prd/07-explore-contract.md 第 2 节"太阳"、06 §5）。
 *
 * 和前端用同一个库（SunCalc）、同一套约定，给 Agent、后台天气判断和 PDF 用：
 *  - 方位：真北 0°，顺时针，单位度；高度角单位度。
 *  - 时刻：按停留点位置与拍摄地点的 IANA 时区，输出带偏移的 ISO 8601。
 *  - 金色时刻 = 太阳高度 −4°～6°，蓝调 = −6°～−4°；日出/日落按 SunCalc（上缘接地平线）。
 * 地形见光在下一批用高程算；这里只给天文时段，不把天文时段冒充见光时段。
 */
import SunCalc from "suncalc";
import type { LngLat } from "@reinlab/contracts";

export type SunWindow = { start: string; end: string; phase: "morning" | "evening" };

export type SunDay = {
  timezone: string;
  day: string;
  /** 太阳上缘接地平线的时刻；极昼极夜时为 null。 */
  sunrise: string | null;
  sunset: string | null;
  solarNoon: string | null;
  /** 金色时刻（−4°～6°），每天最多两段。 */
  golden: SunWindow[];
  /** 蓝调（−6°～−4°），每天最多两段。 */
  blue: SunWindow[];
};

export type SunPosition = { at: string; azimuth: number; altitude: number };

/** 时区在某一瞬间相对 UTC 的偏移（分钟，东为正）。 */
export function offsetMinutesAt(timezone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  // Intl 里 24 点是 0 点的写法差异统一成 0。
  const hour = value("hour") % 24;
  const wall = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    hour,
    value("minute"),
    value("second"),
  );
  return Math.round((wall - at.getTime()) / 60000);
}

/** 把某一瞬间写成拍摄地点当地的带偏移 ISO 时间。 */
export function isoAt(timezone: string, at: Date): string {
  const offset = offsetMinutesAt(timezone, at);
  const local = new Date(at.getTime() + offset * 60000);
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const pad = (n: number) => String(n).padStart(2, "0");
  return local.toISOString().slice(0, 19) + sign + pad(Math.floor(abs / 60)) + ":" + pad(abs % 60);
}

/** 当地日期 + 当地钟点 → 真正的时间点（跨夏令时也不偏）。 */
export function instantOfLocal(day: string, clock: string, timezone: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  const [hour, minute] = clock.split(":").map(Number);
  const wall = Date.UTC(year, month - 1, date, hour, minute, 0);
  // 先用猜测偏移算一次，再用真实偏移修正一次（覆盖夏令时切换当天）。
  let at = new Date(wall - offsetMinutesAt(timezone, new Date(wall)) * 60000);
  at = new Date(wall - offsetMinutesAt(timezone, at) * 60000);
  return at;
}

/** 太阳方位换算：SunCalc 以南为 0 向西为正 → 真北 0° 顺时针。 */
function azimuthFromNorth(radians: number): number {
  const degrees = ((radians * 180) / Math.PI + 180) % 360;
  return Math.round((degrees + 360) % 360 * 10) / 10;
}

export function sunPositionAt(at: LngLat, instant: Date, timezone: string): SunPosition {
  const [lng, lat] = at;
  const position = SunCalc.getPosition(instant, lat, lng);
  return {
    at: isoAt(timezone, instant),
    azimuth: azimuthFromNorth(position.azimuth),
    altitude: Math.round(position.altitude * (180 / Math.PI) * 10) / 10,
  };
}

const DEG = 180 / Math.PI;
const altitudeAt = (at: LngLat, instant: Date): number =>
  SunCalc.getPosition(instant, at[1], at[0]).altitude * DEG;

/** 太阳高度落在某个区间里的连续时段（一分钟粒度，够页面显示与判断用）。 */
function runsWithin(
  at: LngLat,
  from: Date,
  to: Date,
  inside: (altitude: number) => boolean,
): { start: Date; end: Date }[] {
  const out: { start: Date; end: Date }[] = [];
  const stepMs = 60_000;
  let startedAt: Date | null = null;
  for (let t = from.getTime(); t <= to.getTime(); t += stepMs) {
    const now = inside(altitudeAt(at, new Date(t)));
    if (now && !startedAt) startedAt = new Date(t);
    else if (!now && startedAt) {
      out.push({ start: startedAt, end: new Date(t) });
      startedAt = null;
    }
  }
  if (startedAt) out.push({ start: startedAt, end: new Date(to.getTime()) });
  return out;
}

/**
 * 一天的天文时段。按当地日期扫描当地 00:00–24:00，跨时区也用同一把尺子。
 * 极昼极夜没有区间：日出日落为 null，金色/蓝调为空。
 */
export function sunDay(at: LngLat, day: string, timezone: string): SunDay {
  const from = instantOfLocal(day, "00:00", timezone);
  const to = new Date(from.getTime() + 24 * 3600_000);
  const times = SunCalc.getTimes(new Date((from.getTime() + to.getTime()) / 2), at[1], at[0]);
  const iso = (value: Date | undefined) =>
    value instanceof Date && Number.isFinite(value.getTime()) ? isoAt(timezone, value) : null;
  const middle = (from.getTime() + to.getTime()) / 2;
  const phase = (value: Date): "morning" | "evening" =>
    value.getTime() < middle ? "morning" : "evening";
  const windows = (runs: { start: Date; end: Date }[]): SunWindow[] =>
    runs.map((run) => ({
      start: isoAt(timezone, run.start),
      end: isoAt(timezone, run.end),
      phase: phase(run.start),
    }));

  return {
    timezone,
    day,
    sunrise: iso(times.sunrise),
    sunset: iso(times.sunset),
    solarNoon: iso(times.solarNoon),
    // 金色 = 太阳高度 −4°～6°，蓝调 = −6°～−4°（契约第 2 节）。
    golden: windows(runsWithin(at, from, to, (a) => a > -4 && a < 6)),
    blue: windows(runsWithin(at, from, to, (a) => a > -6 && a <= -4)),
  };
}

/** 某个停留点在拍摄时段两端的太阳方位与高度，给 Agent 用。 */
export function sunAtWindow(
  at: LngLat,
  window: { start: string; end: string } | null,
  timezone: string,
): { start: SunPosition | null; end: SunPosition | null } {
  return {
    start: window ? sunPositionAt(at, new Date(window.start), timezone) : null,
    end: window ? sunPositionAt(at, new Date(window.end), timezone) : null,
  };
}
