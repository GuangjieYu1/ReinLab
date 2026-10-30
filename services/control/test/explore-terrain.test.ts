import { describe, expect, it } from "vitest";
import {
  AZIMUTH_STEP_DEG,
  DISTANCE_KM,
  OBSERVER_HEIGHT_M,
  computeStopLight,
  horizonElevationAt,
  horizonFromSamples,
  litWindows,
  pointAt,
  type ElevationTransport,
} from "../src/explore/terrain";
import { isoAt, instantOfLocal, sunDay } from "../src/explore/sun";
import type { LngLat } from "@reinlab/contracts";

const KYOTO: LngLat = [135.7681, 35.0116];

/** 造一个高程应答：按「方位 → 海拔」给一圈，机位自身海拔放第一个。 */
function elevationTransport(options: {
  base?: number;
  /** 方位 → 该方向山脊高度（米）；没给的方位用 base。 */
  ridges?: Record<number, number>;
  fail?: boolean;
}): { transport: ElevationTransport; calls: string[] } {
  const calls: string[] = [];
  const transport: ElevationTransport = async (url) => {
    calls.push(url);
    if (options.fail) return { ok: false, status: 503, json: async () => ({}) };
    const base = options.base ?? 50;
    const azimuths: number[] = [];
    for (let azimuth = 0; azimuth < 360; azimuth += AZIMUTH_STEP_DEG) azimuths.push(azimuth);
    const elevation: number[] = [base];
    for (const azimuth of azimuths) {
      const near = Math.round(azimuth / AZIMUTH_STEP_DEG) * AZIMUTH_STEP_DEG;
      for (const _distance of DISTANCE_KM) elevation.push(options.ridges?.[near] ?? base);
    }
    return { ok: true, status: 200, json: async () => ({ elevation }) };
  };
  return { transport, calls };
}

describe("山体遮挡与地形见光", () => {
  it("地平线：正东有一座 300 米山脊，仰角算得出来且随距离变小", () => {
    const samples = [
      { azimuth: 90, distanceKm: 1.5, altitudeM: 350 },
      { azimuth: 90, distanceKm: 3, altitudeM: 350 },
      { azimuth: 270, distanceKm: 1.5, altitudeM: 50 },
    ];
    const horizon = horizonFromSamples(50, samples);
    const east = horizon.find((row) => row.azimuth === 90)!;
    const west = horizon.find((row) => row.azimuth === 270)!;
    expect(east.elevation).toBeGreaterThan(8);
    expect(east.elevation).toBeLessThan(14);
    expect(west.elevation).toBeLessThan(0);
    // 方位插值：45° 落在两者之间。
    const mid = horizonElevationAt(horizon, 45);
    expect(mid).toBeGreaterThan(west.elevation);
    expect(mid).toBeLessThan(east.elevation);
  });

  it("地平线插值在 0°/360° 处环绕，不跳变", () => {
    const horizon = [
      { azimuth: 0, elevation: 2 },
      { azimuth: 90, elevation: 10 },
      { azimuth: 270, elevation: -1 },
    ];
    expect(horizonElevationAt(horizon, 350)).toBeGreaterThan(-1);
    expect(horizonElevationAt(horizon, 350)).toBeLessThan(2);
    expect(horizonElevationAt(horizon, 10)).toBeGreaterThan(2);
  });

  it("太阳高度高过该方位地平线才算见光：东侧有山，见光晚于日出", () => {
    const horizon = [
      { azimuth: 0, elevation: 0 },
      { azimuth: 90, elevation: 12 },
      { azimuth: 180, elevation: 0 },
      { azimuth: 270, elevation: 0 },
    ];
    const day = "2026-11-15";
    const sun = sunDay(KYOTO, day, "Asia/Tokyo");
    const lit = litWindows(KYOTO, "Asia/Tokyo", day, horizon);
    expect(lit.length).toBeGreaterThan(0);
    // 日出后还要等太阳爬过 12° 的东山。
    expect(lit[0].start > sun.sunrise!).toBe(true);
    const sunrise = new Date(sun.sunrise!).getTime();
    const firstLit = new Date(lit[0].start).getTime();
    expect(firstLit - sunrise).toBeGreaterThan(30 * 60_000);
    // 全天没有「天黑后有光」这种错。
    const lastEnd = new Date(lit[lit.length - 1].end).getTime();
    expect(lastEnd).toBeLessThan(new Date(sun.sunset!).getTime() + 60 * 60_000);
  });

  it("真实取数形状：一圈采样、机位海拔作为基准、给依据与半径", async () => {
    const { transport, calls } = elevationTransport({ base: 51, ridges: { 90: 260 } });
    const result = await computeStopLight({
      at: KYOTO,
      timezone: "Asia/Tokyo",
      day: "2026-11-15",
      transport,
    });
    expect(result.light.horizon).not.toBeNull();
    expect(result.light.basis).toMatchObject({ radiusKm: 6, resolutionM: 90 });
    expect(result.light.basis?.dem).toContain("Copernicus");
    expect(calls).toHaveLength(1);
    // 一个请求里带了机位 + 每个方位每个距离的点。
    const points = (calls[0].match(/,/g) ?? []).length;
    expect(points).toBeGreaterThan(30);
    const east = result.light.horizon!.find((row) => row.azimuth === 90)!;
    expect(east.elevation).toBeGreaterThan(3);
  });

  it("取不到高程就是未知，不默认无遮挡", async () => {
    const failed = await computeStopLight({
      at: KYOTO,
      timezone: "Asia/Tokyo",
      day: "2026-11-15",
      transport: elevationTransport({ fail: true }).transport,
    });
    expect(failed.light).toEqual({ horizon: null, lit: null, basis: null });
    expect(failed.reason).toContain("503");

    const broken = await computeStopLight({
      at: KYOTO,
      timezone: "Asia/Tokyo",
      day: "2026-11-15",
      transport: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(broken.light.horizon).toBeNull();
    expect(broken.reason).toContain("ENOTFOUND");

    const short = await computeStopLight({
      at: KYOTO,
      timezone: "Asia/Tokyo",
      day: "2026-11-15",
      transport: async () => ({ ok: true, status: 200, json: async () => ({ elevation: [50] }) }),
    });
    expect(short.light.horizon).toBeNull();
    expect(short.reason).toContain("海拔");
  });

  it("采样点的方位与距离推得对（正东 1 公里经度加、纬度基本不动）", () => {
    const east = pointAt(KYOTO, 90, 1);
    expect(east[0]).toBeGreaterThan(KYOTO[0]);
    expect(Math.abs(east[1] - KYOTO[1])).toBeLessThan(0.0001);
    const north = pointAt(KYOTO, 0, 1);
    expect(north[1]).toBeGreaterThan(KYOTO[1]);
    expect(Math.abs(north[0] - KYOTO[0])).toBeLessThan(0.0001);
    // 观测高度参与基准：同一座山，抬高观测点会压低仰角。
    const low = horizonFromSamples(50, [{ azimuth: 90, distanceKm: 1.5, altitudeM: 200 }]);
    const high = horizonFromSamples(50 + OBSERVER_HEIGHT_M + 20, [{ azimuth: 90, distanceKm: 1.5, altitudeM: 200 }]);
    expect(high[0].elevation).toBeLessThan(low[0].elevation);
  });

  it("时区换算的见光时段带偏移、且在当天", () => {
    const horizon = [
      { azimuth: 0, elevation: 0 },
      { azimuth: 90, elevation: 0 },
      { azimuth: 180, elevation: 0 },
      { azimuth: 270, elevation: 0 },
    ];
    const lit = litWindows(KYOTO, "Asia/Tokyo", "2026-11-15", horizon);
    for (const window of lit) {
      expect(window.start).toMatch(/^2026-11-15T/);
      expect(window.start).toMatch(/\+09:00$/);
    }
    expect(isoAt("Asia/Tokyo", instantOfLocal("2026-11-15", "12:00", "Asia/Tokyo"))).toBe(
      "2026-11-15T12:00:00+09:00",
    );
  });
});
