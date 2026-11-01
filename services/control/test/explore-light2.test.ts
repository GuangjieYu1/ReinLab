/**
 * 双位置受光（09 §7.2–7.3、契约 §1 StopLight2 / PositionLight / LightSegment）。
 *
 * 关键判定都用真实几何 + 真实太阳位置验：楼挡（带 buildingIds）、min_height 能从楼下穿、
 * 山挡优先、夜间、数据不全时给 unknown 而不是「确定有光」。
 */
import { describe, expect, it } from "vitest";
import type { BuildingScene, LngLat, Stop, StopLight } from "@reinlab/contracts";
import { blockedBy, computeLight2, readingAt, segmentsFor, shapesOf, type LightContext } from "../src/explore/light2";
import { sunPositionAt } from "../src/explore/sun";

const ORIGIN: LngLat = [116.4, 39.9];
const DAY = "2026-11-08";
const TZ = "Asia/Shanghai";

const box = (x1: number, y1: number, x2: number, y2: number): [number, number][] => [
  [x1, y1],
  [x2, y1],
  [x2, y2],
  [x1, y2],
  [x1, y1],
];

const scene = (buildings: BuildingScene["buildings"], coverage: BuildingScene["coverage"] = { status: "ok", note: "" }): BuildingScene => ({
  id: "s1",
  version: 1,
  origin: ORIGIN,
  radiusM: 1000,
  fetchedAt: new Date().toISOString(),
  source: "test",
  buildings,
  coverage,
});

const wall = (minHeightM = 0, heightM = 40): BuildingScene["buildings"][number] => ({
  id: "way/9",
  osm: "way/9",
  footprint: box(30, -60, 60, 60),
  baseM: 0,
  heightM,
  minHeightM,
  heightSource: "tag",
  basis: `height=${heightM}`,
});

const flatTerrain = (): StopLight => ({
  horizon: Array.from({ length: 24 }, (_, index) => ({ azimuth: index * 15, elevation: 0 })),
  lit: null,
  basis: { dem: "测试高程", radiusKm: 6, resolutionM: 90 },
});

/** 找一个当地太阳在东南 / 东边、高度够低的早晨分钟数。 */
function morningMinute(): number {
  for (let minute = 6 * 60; minute < 12 * 60; minute += 5) {
    const instant = new Date(Date.parse(`${DAY}T00:00:00+08:00`) + minute * 60_000);
    const sun = sunPositionAt(ORIGIN, instant, TZ);
    if (sun.altitude > 5 && sun.altitude < 25 && sun.azimuth > 95 && sun.azimuth < 155) return minute;
  }
  throw new Error("找不到合适的早晨时刻");
}

const context = (input: Partial<LightContext> = {}): LightContext => ({
  scene: scene([wall()]),
  terrain: flatTerrain(),
  day: DAY,
  timezone: TZ,
  point: [0, 0],
  heightM: 1.5,
  timezoneOffsetMin: 480,
  shapes: [],
  unknownBuildings: 0,
  ...input,
});

describe("射线求交", () => {
  it("东边的墙挡住早晨的太阳", () => {
    const shapes = shapesOf(scene([wall()]));
    const hit = blockedBy(shapes, { x: 0, y: 0, dx: 1, dy: 0, height: 1.5, slope: Math.tan((10 * Math.PI) / 180) });
    expect(hit?.buildingId).toBe("way/9");
  });

  it("有 min_height 的楼底部留空隙：贴着地面看不到，抬到楼上才挡", () => {
    const shapes = shapesOf(scene([wall(20)]));
    const ray = { x: 0, y: 0, dx: 1, dy: 0, height: 1.5, slope: Math.tan((10 * Math.PI) / 180) };
    expect(blockedBy(shapes, ray)).toBeNull();
    // 楼够高、斜面够陡时（这里是抬到 30 m 高看），才会被挡
    const high = { ...ray, height: 30 };
    expect(blockedBy(shapes, high)?.buildingId).toBe("way/9");
  });

  it("太阳在反方向时不会被同一栋楼挡", () => {
    const shapes = shapesOf(scene([wall()]));
    const hit = blockedBy(shapes, {
      x: 0,
      y: 0,
      dx: -1,
      dy: 0,
      height: 1.5,
      slope: Math.tan((10 * Math.PI) / 180),
    });
    expect(hit).toBeNull();
  });
});

describe("某一刻的状态", () => {
  it("夜里就是 night", () => {
    expect(readingAt(context(), 3 * 60).state).toBe("night");
  });

  it("楼挡：带上 buildingIds", () => {
    const minute = morningMinute();
    const reading = readingAt({ ...context(), shapes: shapesOf(scene([wall()])) }, minute);
    expect(reading.state).toBe("building");
    expect(reading.buildingIds).toContain("way/9");
  });

  it("没有楼挡、数据齐全时给 maybe_lit（已知数据下预计见光），不说「确定有光」", () => {
    const minute = morningMinute();
    const reading = readingAt({ ...context(), scene: scene([]), shapes: [] }, minute);
    expect(reading.state).toBe("maybe_lit");
  });

  it("山挡优先于楼：地平线高过太阳就是 terrain", () => {
    const minute = morningMinute();
    const highRidge: StopLight = {
      horizon: Array.from({ length: 24 }, (_, index) => ({ azimuth: index * 15, elevation: 80 })),
      lit: null,
      basis: { dem: "测试高程", radiusKm: 6, resolutionM: 90 },
    };
    expect(readingAt({ ...context({ terrain: highRidge }), shapes: shapesOf(scene([wall()])) }, minute).state).toBe("terrain");
  });

  it("缺地形数据就不能断言见光：unknown 并写清原因", () => {
    const minute = morningMinute();
    const reading = readingAt({ ...context({ terrain: null }), shapes: [] }, minute);
    expect(reading.state).toBe("unknown");
    expect(reading.note).toContain("地形");
  });

  it("建筑数据取数失败时 likewise unknown", () => {
    const minute = morningMinute();
    const reading = readingAt(
      { ...context({ scene: scene([], { status: "failed", note: "" }) }), shapes: [] },
      minute,
    );
    expect(reading.state).toBe("unknown");
  });
});

describe("一天的分段", () => {
  it("连续覆盖整天，首尾是夜间", () => {
    const segments = segmentsFor({ ...context(), shapes: shapesOf(scene([wall()])) });
    expect(segments.length).toBeGreaterThan(2);
    expect(segments[0].start).toMatch(/T00:00:00/);
    expect(segments[segments.length - 1].end).toMatch(/T24:00:00|T23:5|T00:00:00\+08:00/);
    expect(segments[0].state).toBe("night");
    expect(segments[segments.length - 1].state).toBe("night");
    for (let index = 1; index < segments.length; index += 1)
      expect(segments[index].start).toBe(segments[index - 1].end);
    // 楼挡有具体楼号
    const blocked = segments.find((segment) => segment.state === "building");
    expect(blocked?.cause?.buildingIds).toContain("way/9");
  });
});

describe("computeLight2", () => {
  const stop = (overrides: Partial<Stop> = {}): Stop => ({
    id: "stop-1",
    kind: "spot",
    state: "confirmed",
    name: "机位",
    geometry: { type: "Point", coordinates: ORIGIN },
    day: DAY,
    window: null,
    refs: [],
    source: "agent",
    ...overrides,
  });

  it("机位与模特点分开算；没设模特点时 subject 为 null", () => {
    const light2 = computeLight2({
      scene: scene([wall()]),
      stop: stop(),
      day: DAY,
      timezone: TZ,
      terrain: flatTerrain(),
      now: new Date(`${DAY}T08:00:00+08:00`),
    });
    expect(light2.camera.point).toEqual(ORIGIN);
    expect(light2.subject).toBeNull();
    expect(light2.camera.heightAssumed).toBe(true);
    expect(light2.camera.litWindows.length).toBeGreaterThan(0);
    expect(light2.dem).toContain("测试高程");
    expect(light2.radiusM).toBe(1000);
    expect(light2.sceneId).toBe("s1");
  });

  it("设了模特点就有第二份受光，高度按停留点设置", () => {
    const light2 = computeLight2({
      scene: scene([wall()]),
      stop: stop({ subjectPoint: [116.401, 39.9], cameraHeightM: 2, subjectHeightM: 1.7 }),
      day: DAY,
      timezone: TZ,
      terrain: flatTerrain(),
    });
    expect(light2.subject?.point).toEqual([116.401, 39.9]);
    expect(light2.camera.heightM).toBe(2);
    expect(light2.camera.heightAssumed).toBe(false);
    expect(light2.subject?.heightM).toBe(1.7);
  });

  it("街区类停留点没选参考点：整段 unknown 并写明原因", () => {
    const light2 = computeLight2({
      scene: scene([]),
      stop: stop({
        kind: "area",
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [116.3995, 39.8995],
              [116.4005, 39.8995],
              [116.4005, 39.9005],
              [116.3995, 39.9005],
              [116.3995, 39.8995],
            ],
          ],
        },
      }),
      day: DAY,
      timezone: TZ,
      terrain: flatTerrain(),
    });
    expect(light2.camera.segments.every((segment) => segment.state === "unknown")).toBe(true);
    expect(light2.camera.missing.join()).toContain("参考点");
  });

  it("街区类停留点给了 areaRef 就按参考点算", () => {
    const light2 = computeLight2({
      scene: scene([]),
      stop: stop({ kind: "area", areaRef: [116.4002, 39.9001], geometry: { type: "Point", coordinates: ORIGIN } }),
      day: DAY,
      timezone: TZ,
      terrain: flatTerrain(),
    });
    expect(light2.camera.point).toEqual([116.4002, 39.9001]);
    expect(light2.camera.segments.some((segment) => segment.state === "maybe_lit")).toBe(true);
  });

  it("没有建筑场景：缺项写清楚，不冒充确定见光", () => {
    const light2 = computeLight2({
      scene: null,
      stop: stop(),
      day: DAY,
      timezone: TZ,
      terrain: flatTerrain(),
    });
    expect(light2.camera.missing.join()).toContain("没有建筑数据");
    expect(light2.camera.segments.some((segment) => segment.state === "unknown")).toBe(true);
    expect(light2.sceneId).toBeNull();
  });

  it("版本号自增，重算不会原地打转", () => {
    const light2 = computeLight2({
      scene: scene([]),
      stop: stop({ light2: { version: 3 } as never }),
      day: DAY,
      timezone: TZ,
      terrain: flatTerrain(),
    });
    expect(light2.version).toBe(4);
  });
});
