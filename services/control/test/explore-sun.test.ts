import { describe, expect, it } from "vitest";
import { instantOfLocal, isoAt, sunAtWindow, sunDay, sunPositionAt } from "../src/explore/sun";

const KYOTO: [number, number] = [135.7681, 35.0116];

describe("服务端太阳计算", () => {
  it("京都秋日的日出日落与正午按当地时间给，带偏移", () => {
    const day = sunDay(KYOTO, "2026-11-15", "Asia/Tokyo");
    expect(day.sunrise).toBe("2026-11-15T06:32:09+09:00");
    expect(day.sunset).toBe("2026-11-15T16:53:30+09:00");
    expect(day.solarNoon).toMatch(/^2026-11-15T11:4\d:\d{2}\+09:00$/);
  });

  it("正午太阳在正南：方位 180° 左右，符合真北 0° 顺时针的约定", () => {
    const day = sunDay(KYOTO, "2026-11-15", "Asia/Tokyo");
    const noon = sunPositionAt(KYOTO, new Date(day.solarNoon!), "Asia/Tokyo");
    expect(noon.azimuth).toBeGreaterThan(178);
    expect(noon.azimuth).toBeLessThan(182);
    expect(noon.altitude).toBeGreaterThan(30);
  });

  it("早晨太阳在东边（方位 90–135°），傍晚在西边", () => {
    const morning = sunPositionAt(KYOTO, new Date("2026-11-15T07:10:00+09:00"), "Asia/Tokyo");
    expect(morning.azimuth).toBeGreaterThan(90);
    expect(morning.azimuth).toBeLessThan(135);
    const evening = sunPositionAt(KYOTO, new Date("2026-11-15T16:30:00+09:00"), "Asia/Tokyo");
    expect(evening.azimuth).toBeGreaterThan(225);
    expect(evening.azimuth).toBeLessThan(260);
  });

  it("金色时刻是太阳高度 −4°～6°，蓝调 −6°～−4°，两段都在日出日落附近", () => {
    const day = sunDay(KYOTO, "2026-11-15", "Asia/Tokyo");
    expect(day.golden).toHaveLength(2);
    expect(day.blue).toHaveLength(2);
    const [morningGolden, eveningGolden] = day.golden;
    expect(morningGolden.phase).toBe("morning");
    expect(eveningGolden.phase).toBe("evening");
    // 边界就是阈值：金色起点高度约 −4°，终点约 6°。
    const startAltitude = sunPositionAt(KYOTO, new Date(morningGolden.start), "Asia/Tokyo").altitude;
    const endAltitude = sunPositionAt(KYOTO, new Date(morningGolden.end), "Asia/Tokyo").altitude;
    expect(startAltitude).toBeGreaterThan(-4.5);
    expect(startAltitude).toBeLessThan(-3.5);
    expect(endAltitude).toBeGreaterThan(5.5);
    expect(endAltitude).toBeLessThan(6.5);
    // 蓝调紧挨着金色，且比日出早。
    expect(new Date(day.blue[0].end).getTime()).toBe(new Date(morningGolden.start).getTime());
    expect(new Date(day.blue[0].start).getTime()).toBeLessThan(new Date(day.sunrise!).getTime());
  });

  it("极昼没有日出日落，也不编金色时刻", () => {
    const day = sunDay([18.9553, 69.6492], "2027-06-21", "Europe/Oslo");
    expect(day.sunrise).toBeNull();
    expect(day.sunset).toBeNull();
    expect(day.solarNoon).toBeTruthy();
    expect(day.blue).toEqual([]);
  });

  it("南半球夏令时按当地偏移给（悉尼 12 月是 +11:00）", () => {
    const day = sunDay([151.2093, -33.8688], "2026-12-21", "Australia/Sydney");
    expect(day.sunrise).toMatch(/\+11:00$/);
    expect(day.sunrise).toMatch(/^2026-12-21T05:4\d/);
  });

  it("跨午夜时段两端的太阳方位都能算", () => {
    const positions = sunAtWindow(
      KYOTO,
      { start: "2026-11-15T22:30:00+09:00", end: "2026-11-16T00:20:00+09:00" },
      "Asia/Tokyo",
    );
    expect(positions.start?.altitude).toBeLessThan(0);
    expect(positions.end?.altitude).toBeLessThan(0);
    expect(positions.end?.at).toMatch(/^2026-11-16T00:20:00\+09:00$/);
  });

  it("当地钟点换算不偏：同一瞬间在东京与纽约各写各的偏移", () => {
    const instant = instantOfLocal("2026-11-15", "07:10", "Asia/Tokyo");
    expect(isoAt("Asia/Tokyo", instant)).toBe("2026-11-15T07:10:00+09:00");
    expect(isoAt("America/New_York", instant)).toBe("2026-11-14T17:10:00-05:00");
  });
});
