/**
 * 建筑场景的取数与换算（09 §7.1、契约 §1 BuildingScene）。
 *
 * 只测会出错的地方：楼高三种来源、部件与整体不重复立楼、局部米制、覆盖率照实写、
 * 缓存复用与取数失败不冒充「这里没有楼」。
 */
import { describe, expect, it } from "vitest";
import {
  buildingsFromOverpass,
  heightOf,
  overpassQuery,
  sceneFor,
  toLocalMeters,
  type OverpassTransport,
  type SceneStore,
} from "../src/explore/scene";
import type { BuildingScene } from "@reinlab/contracts";

const ORIGIN: [number, number] = [121.5, 31.23];
const D = 0.0001; // 约 9.5 m（东）/ 11.1 m（北）

const ring = (lng: number, lat: number, size = D) => [
  { lat, lon: lng },
  { lat, lon: lng + size },
  { lat: lat + size, lon: lng + size },
  { lat: lat + size, lon: lng },
  { lat, lon: lng },
];

describe("楼高来源", () => {
  it("height 标签直接用，min_height 照用", () => {
    const info = heightOf({ height: "24", "min_height": "4" });
    expect(info.heightM).toBe(24);
    expect(info.minHeightM).toBe(4);
    expect(info.heightSource).toBe("tag");
    expect(info.basis).toContain("height=24");
  });

  it("只有层数：×3 m，依据写清是换算", () => {
    const info = heightOf({ "building:levels": "14" });
    expect(info.heightM).toBe(42);
    expect(info.heightSource).toBe("levels");
    expect(info.basis).toContain("building:levels=14 × 3 m");
  });

  it("都没有就是未知，不补默认高度", () => {
    const info = heightOf({ building: "yes" });
    expect(info.heightM).toBeNull();
    expect(info.heightSource).toBe("unknown");
    expect(info.basis).toContain("楼高未知");
    // 带英尺符号的不猜
    expect(heightOf({ height: "80'" }).heightM).toBeNull();
  });
});

describe("Overpass → 建筑", () => {
  const payload = {
    elements: [
      { type: "way", id: 1, tags: { building: "yes", height: "24" }, geometry: ring(121.5002, 31.2302) },
      { type: "way", id: 2, tags: { building: "yes", "building:levels": "14" }, geometry: ring(121.5002, 31.2310) },
      { type: "way", id: 3, tags: { building: "yes" }, geometry: ring(121.5002, 31.2318) },
      // 整体轮廓 + 内部部件：只按部件立楼
      { type: "way", id: 10, tags: { building: "yes" }, geometry: ring(121.5010, 31.2302, 0.0006) },
      { type: "way", id: 11, tags: { "building:part": "yes", height: "40" }, geometry: ring(121.50105, 31.23025, 0.0005) },
      // 只盖住一角的小部件（塔楼 + 裙楼）：整体轮廓要留着
      { type: "way", id: 12, tags: { building: "yes" }, geometry: ring(121.5030, 31.2302, 0.0006) },
      { type: "way", id: 13, tags: { "building:part": "yes", height: "60" }, geometry: ring(121.50305, 31.23025, 0.0002) },
      // relation：一个外环有几何、另一个缺几何 → 数据不完整
      {
        type: "relation",
        id: 20,
        tags: { building: "yes", height: "9" },
        members: [
          { type: "way", role: "outer", geometry: ring(121.5020, 31.2302) },
          { type: "way", role: "outer" },
        ],
      },
    ],
  };

  it("同一栋楼不立两遍：有 building:part 就只用部件", () => {
    const parsed = buildingsFromOverpass(payload, ORIGIN);
    const ids = parsed.buildings.map((building) => building.id);
    expect(ids).toContain("way/11");
    expect(ids).not.toContain("way/10");
    // 其它整体照常立；只有一小块部件的楼栋，整体轮廓保留
    expect(ids).toEqual(expect.arrayContaining(["way/1", "way/2", "way/3", "way/12", "way/13", "relation/20"]));
    expect(parsed.stats.parts).toBe(2);
    expect(parsed.coverage.note).toContain("只覆盖了一部分");
  });

  it("轮廓换成局部米制（x 东、y 北、闭合），高度来源照实标", () => {
    const parsed = buildingsFromOverpass(payload, ORIGIN);
    const tag = parsed.buildings.find((building) => building.id === "way/1")!;
    expect(tag.footprint).toHaveLength(5);
    expect(tag.footprint[0]).toEqual(tag.footprint[tag.footprint.length - 1]);
    // 东移 0.0002° 约 19 m；北移 0.0002° 约 22 m
    expect(tag.footprint[0][0]).toBeGreaterThan(15);
    expect(tag.footprint[0][0]).toBeLessThan(25);
    expect(tag.heightM).toBe(24);
    const levels = parsed.buildings.find((building) => building.id === "way/2")!;
    expect(levels.heightM).toBe(42);
    expect(levels.heightSource).toBe("levels");
    const unknown = parsed.buildings.find((building) => building.id === "way/3")!;
    expect(unknown.heightM).toBeNull();
    expect(unknown.heightSource).toBe("unknown");
  });

  it("覆盖状态照实写：成分未知 + relation 缺几何 → partial", () => {
    const parsed = buildingsFromOverpass(payload, ORIGIN);
    expect(parsed.coverage.status).toBe("partial");
    expect(parsed.coverage.note).toContain("楼高未知");
    expect(parsed.coverage.note).toContain("不完整");
    expect(parsed.coverage.note).toContain("90 m");
  });

  it("空查询不等于这里没有楼", () => {
    const parsed = buildingsFromOverpass({ elements: [] }, ORIGIN);
    expect(parsed.coverage.status).toBe("empty");
    expect(parsed.coverage.note).toContain("空查询不代表");
    expect(buildingsFromOverpass({ nope: 1 }, ORIGIN).coverage.status).toBe("failed");
  });
});

describe("取数与缓存", () => {
  const scene = (overrides: Partial<BuildingScene> = {}): BuildingScene => ({
    id: "scene-1",
    version: 1,
    origin: ORIGIN,
    radiusM: 1000,
    fetchedAt: new Date().toISOString(),
    source: "test",
    buildings: [],
    coverage: { status: "ok", note: "" },
    ...overrides,
  });

  it("第二次取同一个位置走缓存，不再打 Overpass", async () => {
    let calls = 0;
    const written: BuildingScene[] = [];
    const store: SceneStore = {
      read: async () => written[0] ?? null,
      write: async (_key, value) => {
        written.push(value);
      },
    };
    const transport: OverpassTransport = async () => {
      calls += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify({ elements: [] }) };
    };
    const first = await sceneFor({ origin: ORIGIN, store, transport });
    expect(first.cached).toBe(false);
    expect(calls).toBe(1);
    const second = await sceneFor({ origin: ORIGIN, store, transport });
    expect(second.cached).toBe(true);
    expect(calls).toBe(1);
    expect(second.scene.coverage.status).toBe("empty");
  });

  it("Overpass 满载（502）等两秒再试一次，第二次成功就用它", async () => {
    let calls = 0;
    const transport: OverpassTransport = async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 502, text: async () => "at capacity" };
      return { ok: true, status: 200, text: async () => JSON.stringify({ elements: [] }) };
    };
    const result = await sceneFor({ origin: ORIGIN, transport });
    expect(calls).toBe(2);
    expect(result.scene.coverage.status).toBe("empty");
  });

  it("取数失败给 failed 场景，不拿空场景冒充没有楼", async () => {
    const transport: OverpassTransport = async () => ({ ok: false, status: 429, text: async () => "" });
    const result = await sceneFor({ origin: ORIGIN, transport });
    expect(result.scene.coverage.status).toBe("failed");
    expect(result.scene.coverage.note).toContain("楼影按未知处理");
    expect(result.scene.coverage.note).toContain("公共实例");
    expect(result.scene.buildings).toEqual([]);
  });

  it("查询串带 ReinLab 标识所需的范围，不拉整座城", () => {
    const query = overpassQuery(ORIGIN, 1000);
    expect(query).toContain("around:1000,31.230000,121.500000");
    expect(query).toContain('["building:part"]');
    expect(query).toContain("out geom tags");
  });

  it("面积过小的碎片不立楼", async () => {
    const tiny = {
      elements: [{ type: "way", id: 99, tags: { building: "yes", height: "9" }, geometry: ring(121.5001, 31.2301, 0.00001) }],
    };
    const parsed = buildingsFromOverpass(tiny, ORIGIN);
    expect(parsed.buildings).toEqual([]);
    expect(parsed.coverage.status).toBe("empty");
  });

  it("米制换算：纬度方向约 111 m / 0.001°", () => {
    const [x, y] = toLocalMeters(ORIGIN, [ORIGIN[0], ORIGIN[1] + 0.001]);
    expect(Math.abs(x)).toBeLessThan(0.1);
    expect(y).toBeGreaterThan(110);
    expect(y).toBeLessThan(112);
  });
});
