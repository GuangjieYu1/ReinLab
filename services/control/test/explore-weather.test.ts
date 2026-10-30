import { describe, expect, it } from "vitest";
import { FORECAST_DAYS, fetchStopWeather, mapHourly, shiftDay, type WeatherTransport } from "../src/explore/weather";

const KYOTO: [number, number] = [135.7681, 35.0116];
const HOUR = 3600_000;

/** 造一份 Open-Meteo 形状的逐时数据（timeformat=unixtime）。 */
function payload(from: string, hours: number) {
  const start = new Date(from).getTime();
  const time = Array.from({ length: hours }, (_, i) => Math.floor((start + i * HOUR) / 1000));
  return {
    hourly: {
      time,
      cloud_cover: time.map((_, i) => i * 2),
      precipitation_probability: time.map((_, i) => Math.min(100, i * 3)),
      precipitation: time.map((_, i) => (i % 3 === 0 ? 0.2 : 0)),
      wind_speed_10m: time.map((_, i) => 1 + i * 0.1),
      wind_gusts_10m: time.map((_, i) => 3 + i * 0.1),
      temperature_2m: time.map(() => 12.5),
    },
  };
}

const transportOf = (body: any, seen: string[] = []): WeatherTransport => async (url) => {
  seen.push(url);
  return { ok: true, status: 200, json: async () => body };
};

const failing = (status: number, body: any): WeatherTransport => async () => ({
  ok: false,
  status,
  json: async () => body,
});

describe("停留点逐时天气", () => {
  it("按停留点位置和当地时间给，单位固定，窗口前后各多取 2 小时", async () => {
    const result = await fetchStopWeather({
      at: KYOTO,
      timezone: "Asia/Tokyo",
      window: { start: "2026-11-15T07:10:00+09:00", end: "2026-11-15T07:50:00+09:00" },
      day: "2026-11-15",
      transport: transportOf(payload("2026-11-14T00:00:00Z", 48)),
      now: new Date("2026-11-14T00:00:00Z"),
    });
    expect(result.state).toBe("ok");
    // 20:10Z–00:50Z 之间的整点：06/07/08/09 点（+09:00）
    expect(result.hours.map((hour) => hour.at.slice(11, 16))).toEqual(["06:00", "07:00", "08:00", "09:00"]);
    expect(result.hours.every((hour) => hour.at.endsWith("+09:00"))).toBe(true);
    expect(result.hours[0]).toMatchObject({ cloud: 42, precipProb: 63, precipMm: 0.2, wind: 3.1, gust: 5.1, temp: 12.5 });
    expect(result.fetchedAt).toBeTruthy();
    expect(result.source.name).toBe("Open-Meteo");
  });

  it("跨午夜的停留点取完整时段，不在午夜截断", async () => {
    const result = await fetchStopWeather({
      at: KYOTO,
      timezone: "Asia/Tokyo",
      window: { start: "2026-11-15T22:30:00+09:00", end: "2026-11-16T00:20:00+09:00" },
      day: "2026-11-15",
      transport: transportOf(payload("2026-11-15T00:00:00Z", 48)),
      now: new Date("2026-11-15T00:00:00Z"),
    });
    const clocks = result.hours.map((hour) => hour.at);
    expect(clocks.some((at) => at.startsWith("2026-11-15T23:00"))).toBe(true);
    expect(clocks.some((at) => at.startsWith("2026-11-16T00:00"))).toBe(true);
    expect(clocks.some((at) => at.startsWith("2026-11-16T02:00"))).toBe(true);
  });

  it("没有时段就按当地整天的逐时给", async () => {
    const result = await fetchStopWeather({
      at: KYOTO,
      timezone: "Asia/Tokyo",
      window: null,
      day: "2026-11-15",
      transport: transportOf(payload("2026-11-14T00:00:00Z", 72)),
      now: new Date("2026-11-14T00:00:00Z"),
    });
    expect(result.hours).toHaveLength(24);
    expect(result.hours[0].at).toBe("2026-11-15T00:00:00+09:00");
    expect(result.hours[23].at).toBe("2026-11-15T23:00:00+09:00");
  });

  it("还没进入预报范围就明说哪天起可查，不去请求也不编数据", async () => {
    const seen: string[] = [];
    const far = shiftDay("2026-11-15", FORECAST_DAYS + 10);
    const result = await fetchStopWeather({
      at: KYOTO,
      timezone: "Asia/Tokyo",
      window: null,
      day: far,
      transport: transportOf(payload("2026-11-15T00:00:00Z", 24), seen),
      now: new Date("2026-11-15T00:00:00Z"),
    });
    expect(result.state).toBe("out_of_range");
    expect(result.hours).toEqual([]);
    expect(result.fromDate).toBe(shiftDay(far, -(FORECAST_DAYS - 1)));
    expect(seen).toEqual([]);
  });

  it("窗口边界按服务商的 UTC 口径算：差一天就不要白跑一次请求", async () => {
    // 现在是 10-30（UTC），预报窗到 11-14；11-15 的拍摄请求必然被拒。
    const seen: string[] = [];
    const atBoundary = await fetchStopWeather({
      at: KYOTO,
      timezone: "Asia/Tokyo",
      window: { start: "2026-11-15T07:10:00+09:00", end: "2026-11-15T07:50:00+09:00" },
      day: "2026-11-15",
      transport: transportOf(payload("2026-11-14T00:00:00Z", 48), seen),
      now: new Date("2026-10-30T18:00:00Z"),
    });
    expect(atBoundary.state).toBe("out_of_range");
    expect(atBoundary.fromDate).toBe("2026-10-31");
    expect(seen).toEqual([]);

    // 到了 10-31（UTC），同一天就在窗口里了，正常取数。
    const inRange = await fetchStopWeather({
      at: KYOTO,
      timezone: "Asia/Tokyo",
      window: { start: "2026-11-15T07:10:00+09:00", end: "2026-11-15T07:50:00+09:00" },
      day: "2026-11-15",
      transport: transportOf(payload("2026-11-14T00:00:00Z", 48)),
      now: new Date("2026-10-31T01:00:00Z"),
    });
    expect(inRange.state).toBe("ok");
    expect(inRange.hours.length).toBeGreaterThan(0);
  });

  it("服务端说超出允许范围也算 out_of_range，不说成没变化", async () => {
    const result = await fetchStopWeather({
      at: KYOTO,
      timezone: "Asia/Tokyo",
      window: null,
      day: "2026-11-15",
      transport: failing(400, { reason: "Data corrupted at time 2026-11-15T00:00 The requested time period is beyond allowed range." }),
      now: new Date("2026-11-15T00:00:00Z"),
    });
    expect(result.state).toBe("out_of_range");
    expect(result.fromDate).toBeTruthy();
  });

  it("取不到数就说失败，并给出一句原因", async () => {
    const server = await fetchStopWeather({
      at: KYOTO,
      timezone: "Asia/Tokyo",
      window: null,
      day: "2026-11-15",
      transport: failing(500, { reason: "upstream boom" }),
      now: new Date("2026-11-15T00:00:00Z"),
    });
    expect(server.state).toBe("failed");
    expect(server.reason).toContain("500");
    const offline = await fetchStopWeather({
      at: KYOTO,
      timezone: "Asia/Tokyo",
      window: null,
      day: "2026-11-15",
      transport: async () => {
        throw new Error("ENOTFOUND");
      },
      now: new Date("2026-11-15T00:00:00Z"),
    });
    expect(offline.state).toBe("failed");
    expect(offline.reason).toContain("ENOTFOUND");
  });

  it("服务商没给的值留 null，不记成 0", () => {
    const hours = mapHourly(
      {
        hourly: {
          time: [Math.floor(new Date("2026-11-14T22:00:00Z").getTime() / 1000)],
          cloud_cover: [null],
          precipitation_probability: [null],
          precipitation: [null],
          wind_speed_10m: [null],
          wind_gusts_10m: [null],
          temperature_2m: [null],
        },
      },
      {
        timezone: "Asia/Tokyo",
        from: new Date("2026-11-14T20:00:00Z"),
        to: new Date("2026-11-15T02:00:00Z"),
      },
    );
    expect(hours).toHaveLength(1);
    expect(hours[0]).toMatchObject({ cloud: null, precipProb: null, precipMm: null, wind: null, gust: null, temp: null });
  });
});

describe("天气判断通道", () => {
  const json = (body: any) => async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  });

  it("输出被截断（没有可解析的 JSON）时明确失败，不当成「没影响」", async () => {
    const { createWeatherJudge } = await import("../src/explore/weather-judge");
    const judge = createWeatherJudge({
      baseUrl: "https://provider.example/anthropic",
      apiKey: "test",
      model: "deepseek-v4-flash",
      transport: json({
        content: [{ type: "text", text: '{"material":tr' }],
        usage: { input_tokens: 900, output_tokens: 900 },
      }) as never,
    });
    await expect(
      judge({ timezone: "Asia/Tokyo", destination: "京都", revision: 1, stops: [] }),
    ).rejects.toThrowError(/可解析/);
  });

  it("发出去的内容写清 before/after 是同一点的新旧预报，并带参考阈值", async () => {
    const { createWeatherJudge } = await import("../src/explore/weather-judge");
    let sent = "";
    const judge = createWeatherJudge({
      baseUrl: "https://provider.example/anthropic",
      apiKey: "test",
      model: "deepseek-v4-flash",
      transport: (async (request: Request) => {
        sent = await request.text();
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              content: [{ type: "text", text: JSON.stringify({ material: false, summary: "没变化", changes: [] }) }],
              usage: { input_tokens: 10, output_tokens: 5 },
            }),
        };
      }) as never,
    });
    await judge({ timezone: "Asia/Tokyo", destination: "京都", revision: 1, stops: [] });
    expect(sent).toContain("before 是上一次检查的预报");
    expect(sent).toContain("after 是刚拿到的新预报");
    expect(sent).toContain("thresholdHint");
    expect(sent).toContain("60");
    // 预算要够这个模型先想再答，否则 JSON 会被截断成「没影响」。
    expect(JSON.parse(sent).max_tokens).toBeGreaterThanOrEqual(2000);
  });

  it("正常 JSON 就按它给的结论走", async () => {
    const { createWeatherJudge } = await import("../src/explore/weather-judge");
    const judge = createWeatherJudge({
      baseUrl: "https://provider.example/anthropic",
      apiKey: "test",
      model: "deepseek-v4-flash",
      transport: json({
        content: [
          {
            type: "text",
            text: JSON.stringify({ material: true, summary: "要改", changes: [{ stopId: "s1", patch: { fallback: "廊下" }, why: "雨" }] }),
          },
        ],
        usage: { input_tokens: 500, output_tokens: 120 },
      }) as never,
    });
    const out = await judge({
      timezone: "Asia/Tokyo",
      destination: "京都",
      revision: 1,
      stops: [{ stopId: "s1", name: "桥", day: "2026-11-02", window: null, before: null, after: null }],
    });
    expect(out.judgement.material).toBe(true);
    // fallback 简称并进 detail.fallback
    expect(out.judgement.changes[0].patch).toEqual({ detail: { fallback: "廊下" } });
    expect(out.usage).toMatchObject({ known: true, inputTokens: 500, outputTokens: 120 });
  });
});
