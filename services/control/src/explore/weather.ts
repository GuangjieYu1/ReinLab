/**
 * 停留点逐时天气（06 §5.2、07 契约第 1、2 节"天气"）。
 *
 * 数据源 Open-Meteo Forecast API：全球逐时，不需要 key。约定写死在这里，
 * 页面和模型看到的是同一套单位：云量 %、降水概率 %、降水量 mm/h、风与阵风 m/s、温度 °C。
 * 取数按停留点自己的位置和当地时间；跨午夜取完整时段，不在午夜截断。
 */
import type { LngLat, Source, WeatherHour } from "@reinlab/contracts";
import { isoAt, instantOfLocal } from "./sun";

export type WeatherState = "ok" | "out_of_range" | "failed";

export type StopWeatherResult = {
  state: WeatherState;
  hours: WeatherHour[];
  /** out_of_range 时：大约从哪天起可查（当地日期）。 */
  fromDate?: string;
  fetchedAt: string | null;
  source: Source;
  /** failed 时给人看的一句话；不编数据。 */
  reason?: string;
};

/** 只依赖 fetch 的形状，测试可以注入假的。 */
export type WeatherTransport = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<any>;
}>;

const ENDPOINT = "https://api.open-meteo.com/v1/forecast";
const HOURLY = [
  "cloud_cover",
  "precipitation_probability",
  "precipitation",
  "wind_speed_10m",
  "wind_gusts_10m",
  "temperature_2m",
].join(",");

/** Open-Meteo 默认 16 天预报窗（今天起算）。 */
export const FORECAST_DAYS = 16;

export const weatherSource = (): Source => ({
  name: "Open-Meteo",
  url: "https://open-meteo.com/",
});

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** 当地日期加减天数（只做日期字符串运算，不受时区影响）。 */
export function shiftDay(day: string, delta: number): string {
  const [year, month, date] = day.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, date + delta));
  return shifted.toISOString().slice(0, 10);
}

/** 某个瞬间所在的当地日期。 */
export function localDayOf(at: Date, timezone: string): string {
  return isoAt(timezone, at).slice(0, 10);
}

/**
 * 把 Open-Meteo 的逐时数组映射成契约里的 WeatherHour[]。
 * 只保留 [from, to] 之间的整点（窗口已含前后各 2 小时）。
 */
export function mapHourly(
  payload: any,
  options: { timezone: string; from: Date; to: Date },
): WeatherHour[] {
  const times: unknown = payload?.hourly?.time;
  if (!Array.isArray(times)) return [];
  const column = (name: string): unknown[] => {
    const values = payload?.hourly?.[name];
    return Array.isArray(values) ? values : [];
  };
  const cloud = column("cloud_cover");
  const prob = column("precipitation_probability");
  const precip = column("precipitation");
  const wind = column("wind_speed_10m");
  const gust = column("wind_gusts_10m");
  const temp = column("temperature_2m");
  const hours: WeatherHour[] = [];
  for (const [index, stamp] of times.entries()) {
    // timeformat=unixtime：秒。也可以用 "YYYY-MM-DDTHH:mm" 的字符串，两种都认。
    const instant =
      typeof stamp === "number"
        ? new Date(stamp * 1000)
        : typeof stamp === "string"
          ? new Date(stamp + ":00Z")
          : null;
    if (!instant || !Number.isFinite(instant.getTime())) continue;
    if (instant.getTime() < options.from.getTime() || instant.getTime() > options.to.getTime()) continue;
    hours.push({
      at: isoAt(options.timezone, instant),
      cloud: num(cloud[index]),
      precipProb: num(prob[index]),
      // Open-Meteo 的逐时降水量就是这一小时的毫米数 → mm/h。
      precipMm: num(precip[index]),
      wind: num(wind[index]),
      gust: num(gust[index]),
      temp: num(temp[index]),
    });
  }
  return hours;
}

/** 取一个停留点（或目的地）的逐时天气。 */
export async function fetchStopWeather(input: {
  at: LngLat;
  timezone: string;
  /** 停留点的拍摄时段；不确定就给 null，按当天整天取。 */
  window: { start: string; end: string } | null;
  /** 停留点所在当地日期（window 为 null 时用）。 */
  day: string;
  transport?: WeatherTransport;
  now?: Date;
  timeoutMs?: number;
}): Promise<StopWeatherResult> {
  const now = input.now ?? new Date();
  const transport: WeatherTransport =
    input.transport ??
    ((url) => fetch(url, { signal: AbortSignal.timeout(input.timeoutMs ?? 10_000) }) as any);

  // 窗口：停留点自己那一段（可以跨午夜），前后各多给 2 小时。
  const from = input.window
    ? new Date(new Date(input.window.start).getTime() - 2 * 3600_000)
    : instantOfLocal(input.day, "00:00", input.timezone);
  const to = input.window
    ? new Date(new Date(input.window.end).getTime() + 2 * 3600_000)
    : instantOfLocal(input.day, "23:00", input.timezone);

  const targetLocal = localDayOf(from, input.timezone);
  // Open-Meteo 的可预报窗口按它自己的「今天」起算 16 天，用 UTC 日期对齐，
  // 否则我们本地算「还在范围内」、它那边已经超窗，白白多一次请求。
  const todayUtc = localDayOf(now, "UTC");
  const horizon = shiftDay(todayUtc, FORECAST_DAYS - 1);
  if (localDayOf(to, "UTC") > horizon) {
    // 还没进入预报范围：说清大概哪天起能查，不拿气候均值当当天预报。
    const fromDate = shiftDay(targetLocal, -(FORECAST_DAYS - 1));
    return {
      state: "out_of_range",
      hours: [],
      fromDate,
      fetchedAt: null,
      source: weatherSource(),
      reason: `这一天还不在预报范围（约 ${fromDate} 起可查）。`,
    };
  }

  // 请求按 UTC 日期覆盖整段窗口（跨午夜、跨日都取到）。
  const startDay = localDayOf(from, "UTC");
  const endDay = localDayOf(to, "UTC");
  const url =
    `${ENDPOINT}?latitude=${input.at[1]}&longitude=${input.at[0]}` +
    `&hourly=${HOURLY}&wind_speed_unit=ms&timeformat=unixtime&timezone=UTC` +
    `&start_date=${startDay}&end_date=${endDay}`;
  try {
    const response = await transport(url);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const detail = String(body?.reason ?? body?.error ?? "").slice(0, 200);
      const beyond = /past|beyond|allowed range|too far/i.test(detail);
      return {
        state: beyond ? "out_of_range" : "failed",
        hours: [],
        ...(beyond ? { fromDate: shiftDay(targetLocal, -(FORECAST_DAYS - 1)) } : {}),
        fetchedAt: new Date().toISOString(),
        source: weatherSource(),
        reason:
          (beyond ? "这一天还不在预报范围。" : `天气服务返回 ${response.status}，没拿到数据。`) +
          (detail ? `（${detail}）` : ""),
      };
    }
    const payload = await response.json();
    const hours = mapHourly(payload, { timezone: input.timezone, from, to });
    if (!hours.length)
      return {
        state: "failed",
        hours: [],
        fetchedAt: new Date().toISOString(),
        source: weatherSource(),
        reason: "天气服务没有返回这个时段的数据。",
      };
    return {
      state: "ok",
      hours,
      fetchedAt: new Date().toISOString(),
      source: { ...weatherSource(), fetchedAt: new Date().toISOString() },
    };
  } catch (error) {
    return {
      state: "failed",
      hours: [],
      fetchedAt: null,
      source: weatherSource(),
      reason: `没连上天气服务：${String((error as Error)?.message ?? error).slice(0, 160)}`,
    };
  }
}
