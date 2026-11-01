/**
 * 建筑场景（design/prd/09-explore-v2.md §7.1、10-explore-v2-contract.md §2.6）。
 *
 * 白模与楼影读同一份场景：从 Overpass 取 building / building:part 的真实几何与原始标签，
 * 换成以停留点为中心的局部米制坐标（x 东、y 北），按区域缓存复用。
 *
 * 三条底线：
 * - 楼高不编：height 标签 → tag；只有 building:levels → ×3 m 标 levels 并写清依据；
 *   都没有 → heightM 为 null、只画轮廓，不补默认楼块。瓦片里的 render_height 不当正式高度。
 * - 部件与整体去重：一个 building 有 building:part 时只用部件立楼，不把同一栋楼立两遍。
 * - 空查询不代表这里没有楼：coverage 照实写 empty / partial / failed。
 */
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { Building, BuildingScene, LngLat } from "@reinlab/contracts";

export const SCENE_RADIUS_M = 1000;
/** 楼很少变：缓存一周，过期再取。 */
export const SCENE_TTL_MS = 7 * 24 * 3600_000;
const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";
/** 公共实例忙的时候可以换一个（OVERPASS_URL）；默认仍是官方的 overpass-api.de。 */
let endpoint = OVERPASS_ENDPOINT;
export function configureOverpassEndpoint(url?: string | null) {
  const clean = (url ?? "").trim();
  endpoint = /^https?:\/\//.test(clean) ? clean : OVERPASS_ENDPOINT;
}
export const overpassEndpoint = () => endpoint;
/** 公共实例满载 / 限流时的状态码：值得等一下再试一次。 */
const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const USER_AGENT = "ReinLab/1.0 (local travel-plan; building scene; +https://openstreetmap.org)";
const MAX_BUILDINGS = 3000;
const METERS_PER_DEGREE = 111_320;

export type OverpassResponse = { ok: boolean; status: number; text: () => Promise<string> };
/** 取数通道：缺省真连 Overpass，测试注入。 */
export type OverpassTransport = (url: string, body: string) => Promise<OverpassResponse>;

let defaultTransport: OverpassTransport | undefined;
export function configureOverpassTransport(transport?: OverpassTransport) {
  defaultTransport = transport;
}

const realTransport: OverpassTransport = (url, body) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": USER_AGENT },
    body,
    // 密集城区（胡同、陆家嘴）一次 1 km 查询实测 30–40 秒：给足时间，别在快回来时把连接掐了。
    signal: AbortSignal.timeout(45_000),
  }) as unknown as Promise<OverpassResponse>;

/** 经纬度 → 以 origin 为原点的局部米制（x 东、y 北）。 */
export function toLocalMeters(origin: LngLat, point: LngLat): [number, number] {
  const [lng0, lat0] = origin;
  const mPerDegLat = METERS_PER_DEGREE;
  const mPerDegLng = METERS_PER_DEGREE * Math.cos((lat0 * Math.PI) / 180);
  return [
    Math.round((point[0] - lng0) * mPerDegLng * 100) / 100,
    Math.round((point[1] - lat0) * mPerDegLat * 100) / 100,
  ];
}

type OsmTags = Record<string, string>;
type OsmPoint = { lat: number; lon: number };
type OsmMember = { type?: string; role?: string; geometry?: OsmPoint[] };
type OsmElement = {
  type?: string;
  id?: number;
  tags?: OsmTags;
  geometry?: OsmPoint[];
  members?: OsmMember[];
};

const num = (raw: string | undefined): number | null => {
  if (!raw) return null;
  // 「24」「24 m」「24.5m」都收；带英尺符号的不猜，按未知处理。
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*(m|米)?\s*$/i.exec(raw);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 && value < 2000 ? value : null;
};

export type HeightInfo = {
  heightM: number | null;
  minHeightM: number;
  heightSource: Building["heightSource"];
  basis: string;
};

/**
 * 楼高：只用原始标签，换算过程写进 basis。
 * min_height 照用，min_level 按同样 3 m/层换算。
 */
export function heightOf(tags: OsmTags): HeightInfo {
  const height = num(tags.height);
  const levels = Number(tags["building:levels"]);
  const minHeightTag = num(tags.min_height);
  const minLevels = Number(tags["building:min_level"]);
  const minHeightM =
    minHeightTag ?? (Number.isFinite(minLevels) && minLevels > 0 ? minLevels * 3 : 0);
  if (height !== null)
    return {
      heightM: height,
      minHeightM,
      heightSource: "tag",
      basis: `height=${tags.height}${minHeightM > 0 ? `；min_height=${minHeightM} m` : ""}`,
    };
  if (Number.isFinite(levels) && levels > 0)
    return {
      heightM: Math.round(levels * 3 * 10) / 10,
      minHeightM,
      heightSource: "levels",
      basis: `building:levels=${levels} × 3 m${minHeightM > 0 ? `；min_height=${minHeightM} m` : ""}`,
    };
  return {
    heightM: null,
    minHeightM,
    heightSource: "unknown",
    basis: "没有 height / building:levels 标签（楼高未知，不补默认高度）",
  };
}

/** 闭合环：去重相邻重复点，首尾相同。 */
function closeRing(points: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (last && last[0] === point[0] && last[1] === point[1]) continue;
    out.push(point);
  }
  if (out.length > 1 && (out[0][0] !== out[out.length - 1][0] || out[0][1] !== out[out.length - 1][1]))
    out.push([out[0][0], out[0][1]]);
  return out;
}

const ringPoints = (geometry: OsmPoint[] | undefined, origin: LngLat): [number, number][] =>
  closeRing((geometry ?? []).map((point) => toLocalMeters(origin, [point.lon, point.lat])));

function areaOf(ring: [number, number][]): number {
  let sum = 0;
  for (let index = 1; index < ring.length; index += 1) {
    const [x1, y1] = ring[index - 1];
    const [x2, y2] = ring[index];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

function centroidOf(ring: [number, number][]): [number, number] {
  let x = 0;
  let y = 0;
  const points = ring.length > 1 ? ring.slice(0, -1) : ring;
  for (const point of points) {
    x += point[0];
    y += point[1];
  }
  return [x / Math.max(1, points.length), y / Math.max(1, points.length)];
}

export function pointInRing(point: [number, number], ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

/** 一个 Overpass 元素 → 一到多栋楼（relation 可能有多个外环）。 */
function buildingsOf(element: OsmElement, origin: LngLat): { buildings: Building[]; incomplete: boolean } {
  const tags = element.tags ?? {};
  const height = heightOf(tags);
  const osm = `${element.type ?? "way"}/${element.id ?? "0"}`;
  if (element.type === "relation") {
    const members = element.members ?? [];
    const outers = members.filter(
      (member) => member.type === "way" && (member.role === "outer" || member.role === "") && member.geometry?.length,
    );
    const inners = members.filter((member) => member.type === "way" && member.role === "inner" && member.geometry?.length);
    const incomplete = members.some((member) => member.type === "way" && !member.geometry?.length);
    const buildings: Building[] = [];
    outers.forEach((outer, index) => {
      const footprint = ringPoints(outer.geometry, origin);
      if (footprint.length < 4 || areaOf(footprint) < 4) return;
      const centre = centroidOf(footprint);
      const holes = inners
        .map((inner) => ringPoints(inner.geometry, origin))
        .filter((ring) => ring.length >= 4 && pointInRing(centroidOf(ring), footprint))
        .slice(0, 10);
      void centre;
      buildings.push({
        id: outers.length > 1 ? `${osm}#${index + 1}` : osm,
        osm,
        footprint,
        ...(holes.length ? { holes } : {}),
        baseM: 0,
        heightM: height.heightM,
        minHeightM: height.minHeightM,
        heightSource: height.heightSource,
        basis: height.basis,
      });
    });
    return { buildings, incomplete };
  }
  const footprint = ringPoints(element.geometry, origin);
  if (footprint.length < 4 || areaOf(footprint) < 4) return { buildings: [], incomplete: false };
  return {
    buildings: [
      {
        id: osm,
        osm,
        footprint,
        baseM: 0,
        heightM: height.heightM,
        minHeightM: height.minHeightM,
        heightSource: height.heightSource,
        basis: height.basis,
      },
    ],
    incomplete: false,
  };
}

export type ParsedScene = {
  buildings: Building[];
  coverage: BuildingScene["coverage"];
  /** 皮肤之外的统计，给日志与工具用。 */
  stats: { elements: number; parts: number; unknownHeight: number; skipped: number };
};

/**
 * Overpass 响应 → Building[]。
 *
 * 去重规则：一栋 building 下面有 building:part 时，按部件立楼、丢掉整体轮廓
 * （否则同一栋楼会被立两遍、影子也会算两遍）。没有部件的整体照常立。
 */
export function buildingsFromOverpass(payload: unknown, origin: LngLat): ParsedScene {
  const elements = (payload as { elements?: OsmElement[] })?.elements;
  if (!Array.isArray(elements))
    return {
      buildings: [],
      coverage: { status: "failed", note: "Overpass 返回的数据不是预期形状，这次没有建筑数据。" },
      stats: { elements: 0, parts: 0, unknownHeight: 0, skipped: 0 },
    };
  const wholes: OsmElement[] = [];
  const parts: OsmElement[] = [];
  for (const element of elements) {
    const tags = element.tags ?? {};
    if (tags["building:part"] !== undefined) parts.push(element);
    else if (tags.building !== undefined) wholes.push(element);
  }

  let skipped = 0;
  let partial = false;
  const partBuildings: Building[] = [];
  const partRings: [number, number][][] = [];
  for (const part of parts) {
    const parsed = buildingsOf(part, origin);
    if (parsed.incomplete) partial = true;
    if (!parsed.buildings.length) skipped += 1;
    for (const building of parsed.buildings) {
      partBuildings.push(building);
      partRings.push(building.footprint);
    }
  }

  // 一栋楼被部件盖住多少：部件都在轮廓里、且面积占整体 60% 以上，就只按部件立楼；
  // 只有一小块部件（塔楼 + 裙楼）时整体轮廓也保留，并写进覆盖说明。
  const partCoverageOf = (whole: Building): number => {
    const total = areaOf(whole.footprint);
    if (!total) return 0;
    const inside = partRings.filter((ring) => pointInRing(centroidOf(ring), whole.footprint));
    return inside.reduce((sum, ring) => sum + areaOf(ring), 0) / total;
  };
  let partialCoverage = false;
  const wholeBuildings: Building[] = [];
  for (const whole of wholes) {
    const parsed = buildingsOf(whole, origin);
    if (parsed.incomplete) partial = true;
    if (!parsed.buildings.length) {
      skipped += 1;
      continue;
    }
    for (const building of parsed.buildings) {
      const coverage = partRings.length ? partCoverageOf(building) : 0;
      if (coverage >= 0.6) continue; // 部件就是这栋楼的细节，整体轮廓不再立
      if (coverage > 0) partialCoverage = true;
      wholeBuildings.push(building);
    }
  }

  // 楼太多时按「离机位近的先留」截断：远处的楼对遮挡影响小，但必须写进覆盖说明，别悄悄丢。
  const all = [...partBuildings, ...wholeBuildings];
  const distance = (building: Building) =>
    Math.hypot(centroidOf(building.footprint)[0], centroidOf(building.footprint)[1]);
  const truncated = all.length > MAX_BUILDINGS;
  const buildings = truncated
    ? [...all].sort((a, b) => distance(a) - distance(b)).slice(0, MAX_BUILDINGS)
    : all;
  const unknownHeight = buildings.filter((building) => building.heightM === null).length;
  if (!buildings.length)
    return {
      buildings,
      coverage: {
        status: "empty",
        note: "这一圈没有取到建筑几何；空查询不代表现场没有楼，楼影按未知处理。",
      },
      stats: { elements: elements.length, parts: parts.length, unknownHeight, skipped },
    };
  const notes = [
    `Overpass 取到 ${elements.length} 个元素、立起 ${buildings.length} 栋`,
    parts.length ? `其中 ${partBuildings.length} 栋来自 building:part（已去掉对应的整体轮廓）` : "",
    unknownHeight ? `${unknownHeight} 栋楼高未知（只画轮廓，不参与确定性无遮挡结论）` : "",
    "基底高程统一按机位处 Copernicus GLO-90（约 90 m 分辨率）取，属近似",
    partialCoverage ? "部分楼栋的 building:part 只覆盖了一部分轮廓，整体轮廓也保留（可能有重叠）" : "",
    truncated ? `这一圈超过 ${MAX_BUILDINGS} 栋，只保留离机位最近的 ${MAX_BUILDINGS} 栋（更远的楼没算进来）` : "",
    partial ? "部分 relation 的成员几何缺失，这份数据不完整" : "",
  ].filter(Boolean);
  return {
    buildings,
    coverage: {
      status: partial || partialCoverage || truncated || unknownHeight > 0 ? "partial" : "ok",
      note: notes.join("；"),
    },
    stats: { elements: elements.length, parts: parts.length, unknownHeight, skipped },
  };
}

// ── 缓存 ─────────────────────────────────────────────────

export type SceneStore = {
  read: (key: string) => Promise<BuildingScene | null>;
  write: (key: string, scene: BuildingScene) => Promise<void>;
};

/** 场景缓存：一份 JSON 一个文件，键是取整后的原点 + 半径。 */
export function localSceneStore(root: string): SceneStore {
  const dir = path.join(root, "scenes");
  const file = (key: string) => path.join(dir, `${key}.json`);
  return {
    async read(key) {
      const raw = await readFile(file(key), "utf8").catch(() => null);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as BuildingScene;
      } catch {
        return null;
      }
    },
    async write(key, scene) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const temporary = path.join(dir, `.${key}.${process.pid}.tmp`);
      const handle = await open(temporary, "w", 0o600);
      try {
        await handle.writeFile(JSON.stringify(scene));
      } finally {
        await handle.close();
      }
      await rename(temporary, file(key)).catch(async (error) => {
        await rm(temporary, { force: true });
        throw error;
      });
    },
  };
}

/**
 * 缓存键：按约 1 km 的格子取整——同一天的机位往往只隔几百米，用同一份场景就够
 * （局部坐标以场景 origin 为基准，几百米的偏移不影响白模与受光）。这也是对公共
 * Overpass 的礼貌：不该为每条街重新拉一次。
 */
export const sceneKey = (origin: LngLat, radiusM: number): string =>
  createHash("sha256")
    .update([origin[0].toFixed(2), origin[1].toFixed(2), radiusM].join("|"))
    .digest("hex")
    .slice(0, 16);

/** Overpass QL：只取与楼有关的元素，带几何；按半径夹住，避免拉整座城。 */
export function overpassQuery(origin: LngLat, radiusM: number): string {
  const [lng, lat] = origin;
  const around = `around:${Math.round(radiusM)},${lat.toFixed(6)},${lng.toFixed(6)}`;
  return [
    "[out:json][timeout:25];",
    "(",
    `  way(${around})["building"];`,
    `  way(${around})["building:part"];`,
    `  relation(${around})["building"];`,
    ");",
    "out geom tags;",
  ].join("\n");
}

export type SceneResult = {
  scene: BuildingScene;
  cached: boolean;
};

/**
 * 取一个位置周围 1 km 的建筑场景（有缓存就用缓存）。
 * 取数失败照实返回 failed 场景，而不是空场景冒充「这里没有楼」。
 */
export async function sceneFor(input: {
  origin: LngLat;
  radiusM?: number;
  store?: SceneStore;
  transport?: OverpassTransport;
  now?: Date;
  /** 强制重新取（缓存过期之外的手动刷新）。 */
  refresh?: boolean;
}): Promise<SceneResult> {
  const radiusM = input.radiusM ?? SCENE_RADIUS_M;
  const key = sceneKey(input.origin, radiusM);
  const now = input.now ?? new Date();
  const cached = await input.store?.read(key).catch(() => null);
  if (cached && !input.refresh && now.getTime() - Date.parse(cached.fetchedAt) < SCENE_TTL_MS)
    return { scene: cached, cached: true };

  const transport = input.transport ?? defaultTransport ?? realTransport;
  const body = `data=${encodeURIComponent(overpassQuery(input.origin, radiusM))}`;
  let payload: unknown;
  let lastError = "";
  // 公共实例会满载（502）或限流（429）：等两秒再试一次，仍不行就照实说，不编。
  for (let attempt = 0; attempt < 2 && payload === undefined; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2_000));
    try {
      const response = await transport(endpoint, body);
      const text = await response.text();
      if (!response.ok) {
        lastError = `Overpass 返回 ${response.status}`;
        if (TRANSIENT_STATUS.has(response.status) && attempt === 0) continue;
        throw new Error(lastError);
      }
      payload = JSON.parse(text);
    } catch (error) {
      // 超时 / 网络错误不重试：再等一遍只会让页面更久，留给用户点重算。
      lastError = String((error as Error)?.message ?? error).slice(0, 140);
      break;
    }
  }
  if (payload === undefined) {
    const scene: BuildingScene = {
      id: key,
      version: (cached?.version ?? 0) + 1,
      origin: input.origin,
      radiusM,
      fetchedAt: now.toISOString(),
      source: "OpenStreetMap（Overpass API）取数失败",
      buildings: [],
      coverage: {
        status: "failed",
        note: `没取到建筑数据：${lastError || "没有响应"}；Overpass 是公共实例，忙的时候会这样，稍后再点一次重算即可；这次楼影按未知处理。`,
      },
    };
    return { scene, cached: false };
  }
  const parsed = buildingsFromOverpass(payload, input.origin);
  const scene: BuildingScene = {
    id: key,
    version: (cached?.version ?? 0) + 1,
    origin: input.origin,
    radiusM,
    fetchedAt: now.toISOString(),
    source: "© OpenStreetMap contributors（Overpass API）· building / building:part 原始几何与标签",
    buildings: parsed.buildings,
    coverage: parsed.coverage,
  };
  await input.store?.write(key, scene).catch(() => undefined);
  return { scene, cached: false };
}
