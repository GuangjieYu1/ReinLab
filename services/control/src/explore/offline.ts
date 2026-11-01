/**
 * 离线包（design/prd/09-explore-v2.md §3、10-explore-v2-contract.md §2.1）。
 *
 * 服务端的活：按拍摄日算覆盖范围和瓦片坐标、给一份固定修订的清单、带 ReinLab
 * 标识代取矢量瓦片与字形。设备那边的 Service Worker / Cache Storage 由前端做。
 *
 * 三条老实账：
 * - 只发清单里列过的瓦片/字形，不在清单里的坐标一律不代取。
 * - 守 OpenFreeMap 的单次上限（3000 张 / 50 MB / 并发 4）：清单里写实际数量和
 *   按每级抽样估出来的大小；代取时到上限就明确拒绝（413），不悄悄漏图。
 * - 清单里的 tileBytes 是「到目前为止真的取到多少字节」，不是估出来的数。
 */
import type pg from "pg";
import { createHash, randomUUID } from "node:crypto";
import type { LngLat, OfflineManifest, Stop } from "@reinlab/contracts";
import { ApiFailure } from "../api/errors";
import type { MapConfig } from "./map-config";
import type { PlanDocument, StoredPlan } from "./plan";
import { listRefs, type ExploreStorage } from "./refs";
import { snapshotRevision } from "./revisions";

type Client = pg.PoolClient;

export const OFFLINE_LIMITS = {
  /** OpenFreeMap 单次离线下载上限：3000 张瓦片或 50 MB。 */
  maxTiles: 3000,
  maxBytes: 52_428_800,
  /** 默认覆盖范围：路线两侧 500 米、停留点周围 1 km（PRD §3.1）。 */
  corridorM: 500,
  stopRadiusM: 1000,
  /** 当日行程总览的低级别（z8–12）。 */
  overviewMinZoom: 8,
  overviewMaxZoom: 12,
  /** 走廊和点周围（z13–16，实际受源 maxzoom 限制）。 */
  detailMinZoom: 13,
  detailMaxZoom: 16,
  /** 地图渲染用的字体区段：只带拉丁/标点，中文交给设备的本地表意字体。 */
  glyphRanges: ["0-255", "256-511"],
} as const;

/** 地图样式里用到的 fontstack（与前端 mapStyle 一致）；取不到的进 unknowns。 */
const FONTSTACKS = ["Noto Sans Regular", "Noto Sans Bold"];

const USER_AGENT = "ReinLab/0.1 (offline pack; +https://openfreemap.org)";

export type Fetched = { ok: boolean; status: number; body: Buffer };
/** 取数通道：真实 fetch 或测试注入。 */
export type OfflineFetch = (url: string) => Promise<Fetched>;

export const defaultOfflineFetch: OfflineFetch = async (url) => {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  return { ok: response.ok, status: response.status, body: Buffer.from(await response.arrayBuffer()) };
};

/** 出站并发最多 4（OpenFreeMap 的要求），超出排队。 */
function outboundLimit(max = 4) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function run<T>(work: () => Promise<T>): Promise<T> {
    while (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await work();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}
const outbound = outboundLimit(4);

// ── 瓦片坐标 ───────────────────────────────────────────────

export type Bounds = { west: number; south: number; east: number; north: number };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** 经纬度 → 该级别的瓦片坐标（Web Mercator，与 MapLibre 一致）。 */
export function tileOf(lng: number, lat: number, z: number) {
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const rad = (clamp(lat, -85.051129, 85.051129) * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return { z, x: clamp(x, 0, n - 1), y: clamp(y, 0, n - 1) };
}

export function tileRangeOf(bounds: Bounds, z: number) {
  const northEast = tileOf(bounds.west, bounds.north, z);
  const southWest = tileOf(bounds.east, bounds.south, z);
  return { minX: northEast.x, maxX: southWest.x, minY: northEast.y, maxY: southWest.y };
}

const METERS_PER_DEGREE = 111_320;
const latMeters = (lat: number) => METERS_PER_DEGREE * Math.cos((lat * Math.PI) / 180);

/** 以某点为中心、半径若干米的外接经纬度框。 */
export function circleBounds(center: LngLat, radiusM: number): Bounds {
  const dLat = radiusM / METERS_PER_DEGREE;
  const dLng = radiusM / Math.max(1, latMeters(center[1]));
  return {
    west: center[0] - dLng,
    south: center[1] - dLat,
    east: center[0] + dLng,
    north: center[1] + dLat,
  };
}

export function padBounds(bounds: Bounds, meters: number): Bounds {
  const midLat = (bounds.north + bounds.south) / 2;
  const dLat = meters / METERS_PER_DEGREE;
  const dLng = meters / Math.max(1, latMeters(midLat));
  return {
    west: bounds.west - dLng,
    south: bounds.south - dLat,
    east: bounds.east + dLng,
    north: bounds.north + dLat,
  };
}

export function mergeBounds(list: Bounds[]): Bounds | null {
  if (!list.length) return null;
  return list.reduce((acc, item) => ({
    west: Math.min(acc.west, item.west),
    south: Math.min(acc.south, item.south),
    east: Math.max(acc.east, item.east),
    north: Math.max(acc.north, item.north),
  }));
}

/** 停留点的代表坐标：点自己；街区取外接框中心（与取天气同一个语义）。 */
export function stopPoint(stop: Stop): LngLat {
  if (stop.geometry.type === "Point") return stop.geometry.coordinates as LngLat;
  return boundsCenter(geometryBounds(stop.geometry));
}

export function geometryBounds(geometry: { type: string; coordinates: unknown }): Bounds {
  if (geometry.type === "Point") {
    const [lng, lat] = geometry.coordinates as LngLat;
    return { west: lng, south: lat, east: lng, north: lat };
  }
  const rings =
    geometry.type === "Polygon"
      ? ((geometry.coordinates as LngLat[][]) ?? [])
      : geometry.type === "LineString"
        ? [[geometry.coordinates as LngLat]]
        : ((geometry.coordinates as LngLat[][][]) ?? []).flat();
  const points = rings.flat() as LngLat[];
  if (!points.length) return { west: 0, south: 0, east: 0, north: 0 };
  const lngs = points.map((point) => point[0]);
  const lats = points.map((point) => point[1]);
  return {
    west: Math.min(...lngs),
    south: Math.min(...lats),
    east: Math.max(...lngs),
    north: Math.max(...lats),
  };
}

const boundsCenter = (bounds: Bounds): LngLat => [
  (bounds.west + bounds.east) / 2,
  (bounds.south + bounds.north) / 2,
];

export type TileCoord = { z: number; x: number; y: number };

/**
 * 一天的瓦片坐标：低级别看整日行程，细节级别只覆盖停留点周围与路线走廊。
 * 顺序就是优先级（先低级别、先总览），超出单次上限时截断靠后的。
 */
export function planTileSet(input: {
  document: PlanDocument;
  day: string;
  maxZoom: number;
  detail: "full" | "low";
}): { tiles: TileCoord[]; stops: Stop[]; bounds: Bounds; missing: string[] } {
  const { document, day, maxZoom, detail } = input;
  const all = document.stops.filter((stop) => stop.day === day);
  const confirmed = all.filter((stop) => stop.state === "confirmed");
  const stops = confirmed.length ? confirmed : all;
  if (!stops.length) throw new ApiFailure("OFFLINE_NO_STOPS", 409, "这一天还没有停留点，先确认计划再来准备离线包。");
  const stopIds = new Set(stops.map((stop) => stop.id));

  const overviewParts: Bounds[] = stops.map((stop) => geometryBounds(stop.geometry));
  const detailParts: Bounds[] = stops.map((stop) => circleBounds(stopPoint(stop), OFFLINE_LIMITS.stopRadiusM));
  const missing: string[] = [];

  const legs = document.routes.filter((leg) => stopIds.has(leg.from) && stopIds.has(leg.to));
  if (legs.length) {
    for (const leg of legs) {
      if (leg.geometry) {
        overviewParts.push(geometryBounds(leg.geometry));
        // 路线两侧各 500 米：按线段逐段外扩，不拿整条路线的大外接框（那会多要很多瓦片）。
        const lines =
          leg.geometry.type === "LineString"
            ? [leg.geometry.coordinates as LngLat[]]
            : (leg.geometry.coordinates as unknown as LngLat[][]);
        for (const line of lines)
          for (let index = 1; index < line.length; index += 1)
            detailParts.push(padBounds(segmentBounds(line[index - 1], line[index]), OFFLINE_LIMITS.corridorM));
      } else {
        // 没有真实路线：只按两点头线走一遍，清单里如实写「路线未取得」。
        missing.push("路线未取得，走廊按两点连线估算");
        detailParts.push(
          padBounds(segmentBounds(stopPoint(stops.find((s) => s.id === leg.from)!), stopPoint(stops.find((s) => s.id === leg.to)!)), OFFLINE_LIMITS.corridorM),
        );
      }
    }
  } else if (stops.length > 1) {
    missing.push("没有已确认路线，走廊按停留点连线估算");
    for (let index = 1; index < stops.length; index += 1)
      detailParts.push(
        padBounds(segmentBounds(stopPoint(stops[index - 1]), stopPoint(stops[index])), OFFLINE_LIMITS.corridorM),
      );
  } else missing.push("只有一个停留点，没有路线走廊");

  const overview = padBounds(mergeBounds(overviewParts) ?? geometryBounds(stops[0].geometry), 5_000);
  const overviewZooms = zoomRange(
    OFFLINE_LIMITS.overviewMinZoom,
    detail === "low" ? Math.min(11, maxZoom) : Math.min(OFFLINE_LIMITS.overviewMaxZoom, maxZoom),
  );
  const detailZooms = zoomRange(
    detail === "low" ? OFFLINE_LIMITS.detailMinZoom - 1 : OFFLINE_LIMITS.detailMinZoom,
    Math.min(detail === "low" ? 13 : OFFLINE_LIMITS.detailMaxZoom, maxZoom),
  );

  const seen = new Set<string>();
  const tiles: TileCoord[] = [];
  const push = (coord: TileCoord) => {
    const key = `${coord.z}/${coord.x}/${coord.y}`;
    if (seen.has(key)) return;
    seen.add(key);
    tiles.push(coord);
  };
  for (const z of overviewZooms) for (const coord of tilesIn(overview, z)) push(coord);
  for (const z of detailZooms) for (const part of detailParts) for (const coord of tilesIn(part, z)) push(coord);

  return { tiles, stops, bounds: overview, missing };
}

const zoomRange = (from: number, to: number): number[] => {
  const zooms: number[] = [];
  for (let z = from; z <= to; z += 1) zooms.push(z);
  return zooms;
};

/** 一个经纬度框覆盖的所有瓦片。 */
export function tilesIn(bounds: Bounds, z: number): TileCoord[] {
  const range = tileRangeOf(bounds, z);
  const coords: TileCoord[] = [];
  // 单级别别把内存撑爆：超出的由调用方按上限截断，这里给个硬护栏。
  let count = 0;
  for (let x = range.minX; x <= range.maxX; x += 1)
    for (let y = range.minY; y <= range.maxY; y += 1) {
      coords.push({ z, x, y });
      count += 1;
      if (count > 20_000) return coords;
    }
  return coords;
}

function segmentBounds(a: LngLat, b: LngLat): Bounds {
  return {
    west: Math.min(a[0], b[0]),
    south: Math.min(a[1], b[1]),
    east: Math.max(a[0], b[0]),
    north: Math.max(a[1], b[1]),
  };
}

// ── 上游 TileJSON ────────────────────────────────────────

type TileSource = { template: string; maxzoom: number; raw: Record<string, unknown> };

const sourceCache = new Map<string, { at: number; source: TileSource }>();

/** 取源的 TileJSON：拿瓦片模板和 maxzoom（不请求不存在的级别）。 */
export async function tileSource(options: {
  mapConfig: () => MapConfig;
  fetch: OfflineFetch;
  now?: () => Date;
}): Promise<TileSource> {
  const url = options.mapConfig().vector.tilejson;
  const cached = sourceCache.get(url);
  const now = (options.now?.() ?? new Date()).getTime();
  if (cached && now - cached.at < 10 * 60_000) return cached.source;
  const response = await options.fetch(url);
  if (!response.ok)
    throw new ApiFailure("OFFLINE_SOURCE_UNAVAILABLE", 503, "取不到矢量底图的 TileJSON，先确认能上互联网。");
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(response.body.toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new ApiFailure("OFFLINE_SOURCE_UNAVAILABLE", 503, "矢量底图的 TileJSON 不是合法 JSON。");
  }
  const templates = Array.isArray(raw.tiles) ? raw.tiles.filter((item): item is string => typeof item === "string") : [];
  if (!templates.length)
    throw new ApiFailure("OFFLINE_SOURCE_UNAVAILABLE", 503, "矢量底图的 TileJSON 没有瓦片地址。");
  const source: TileSource = {
    template: templates[0],
    maxzoom: Number(raw.maxzoom ?? 14),
    raw,
  };
  sourceCache.set(url, { at: now, source });
  return source;
}

const tileUrl = (template: string, coord: TileCoord) =>
  template
    .replace("{z}", String(coord.z))
    .replace("{x}", String(coord.x))
    .replace("{y}", String(coord.y))
    .replace("{ratio}", "")
    .replace("{s}", "a");

const glyphUrl = (template: string, fontstack: string, range: string) =>
  template.replace("{fontstack}", encodeURIComponent(fontstack)).replace("{range}", range);

const safeName = (value: string) => value.replace(/[^A-Za-z0-9._-]+/g, "_") || "font";

const tileAssetName = (coord: TileCoord) => `tiles/${coord.z}/${coord.x}/${coord.y}.pbf`;
const glyphAssetName = (fontstack: string, range: string) => `glyphs/${safeName(fontstack)}/${range}.pbf`;

/** 清单里的地址：服务端相对路径，前端补 origin 使用。 */
export const tilePath = (packId: string, coord: TileCoord) =>
  `/v1/explore/offline-tiles/${packId}/${coord.z}/${coord.x}/${coord.y}`;
export const glyphPath = (fontstack: string, range: string) =>
  `/v1/explore/offline-glyphs/${encodeURIComponent(fontstack)}/${range}.pbf`;
/** 样式的字形模板：页面把 MapLibre 的 glyphs 指到这里，离线时先查缓存。 */
export const GLYPH_TEMPLATE = "/v1/explore/offline-glyphs/{fontstack}/{range}.pbf";
export const tilejsonPath = (packId: string) => `/v1/explore/offline-packs/${packId}/tilejson`;

// ── 清单 ─────────────────────────────────────────────────

export type OfflineOptions = {
  storage: ExploreStorage;
  mapConfig: () => MapConfig;
  fetch?: OfflineFetch;
  now?: () => Date;
};

type PackRow = {
  id: string;
  dossier_id: string;
  day: string;
  plan_revision: number;
  detail: "full" | "low";
  manifest: OfflineManifest;
  tile_list: TileCoord[];
  glyph_list: { fontstack: string; range: string }[];
  tiles_fetched: number;
  tile_bytes: string | number;
};

const packUrl = (dossier: string, packId: string) => `/v1/explore/plans/${dossier}/offline-packs/${packId}`;

/**
 * 生成一份离线包清单。
 *
 * 不预取整份瓦片：清单里列坐标，设备按清单来取，服务端代取时记账。
 * 只取每级少量瓦片做大小抽样，好让页面在下载前能说「约多少 MB、是否超上限」。
 */
export async function createOfflinePack(
  client: Client,
  account: string,
  dossier: string,
  input: { plan: StoredPlan; day: string; detail?: "full" | "low" },
  options: OfflineOptions,
): Promise<OfflineManifest> {
  const now = options.now?.() ?? new Date();
  const fetchRemote = options.fetch ?? defaultOfflineFetch;
  const mapConfig = options.mapConfig;
  const source = await tileSource({ mapConfig, fetch: fetchRemote, now: () => now });
  const detail = input.detail ?? "full";
  const set = planTileSet({ document: input.plan.document, day: input.day, maxZoom: source.maxzoom, detail });

  const packId = randomUUID();
  // 出发那一版要留得下来：清单引用固定修订，回顾时对照用。
  await snapshotRevision(client, {
    account,
    dossier,
    revision: input.plan.revision,
    state: input.plan.state,
    document: input.plan.document,
  });

  const truncated = set.tiles.length > OFFLINE_LIMITS.maxTiles;
  const tiles = truncated ? set.tiles.slice(0, OFFLINE_LIMITS.maxTiles) : set.tiles;

  // 大小抽样：每级取首尾两张（已经取到的落盘缓存，设备随后下载就不用再等上游）。
  const samples = new Map<number, number[]>();
  const sampleCoords: TileCoord[] = [];
  for (const z of new Set(tiles.map((coord) => coord.z))) {
    const pool = tiles.filter((coord) => coord.z === z);
    sampleCoords.push(pool[0]);
    if (pool.length > 1) sampleCoords.push(pool[pool.length - 1]);
  }
  let sampledBytes = 0;
  await Promise.all(
    sampleCoords.map((coord) =>
      outbound(async () => {
        const response = await fetchRemote(tileUrl(source.template, coord)).catch(() => null);
        if (!response?.ok || !response.body.length) return;
        sampledBytes += response.body.length;
        const list = samples.get(coord.z) ?? [];
        list.push(response.body.length);
        samples.set(coord.z, list);
        await options.storage
          .savePackAsset({ dossier, packId, name: tileAssetName(coord), bytes: response.body })
          .catch(() => undefined);
      }),
    ),
  );

  const countByZoom = new Map<number, number>();
  for (const coord of tiles) countByZoom.set(coord.z, (countByZoom.get(coord.z) ?? 0) + 1);
  let estimate = 0;
  let estimated = false;
  for (const [z, count] of countByZoom) {
    const list = samples.get(z);
    if (!list?.length) continue;
    estimated = true;
    estimate += count * (list.reduce((sum, value) => sum + value, 0) / list.length);
  }

  const refs = await listRefs(client, account, dossier);
  const glyphs = FONTSTACKS.flatMap((fontstack) =>
    OFFLINE_LIMITS.glyphRanges.map((range) => ({ fontstack, range })),
  );

  const overTiles = tiles.length >= OFFLINE_LIMITS.maxTiles && truncated;
  const overBytes = estimated && estimate > OFFLINE_LIMITS.maxBytes;
  const unknowns: string[] = [...set.missing];
  for (const stop of set.stops) {
    if (!stop.light?.horizon) unknowns.push(`${stop.name}：没有地形见光数据（高程没取到）`);
    if (!stop.light2) unknowns.push(`${stop.name}：双位置受光还没算（建筑场景未取或未重算）`);
    else if (stop.light2.camera.missing.length)
      unknowns.push(`${stop.name}：${stop.light2.camera.missing.slice(0, 2).join("；")}`);
  }
  if (estimated)
    unknowns.push(
      `整包大小是按每级抽样估的（约 ${(estimate / 1024 / 1024).toFixed(1)} MB），实际以下载为准`,
    );
  else unknowns.push("这次没取到瓦片样本，整包大小未知");

  const manifest: OfflineManifest = {
    packId,
    day: input.day,
    planRevision: input.plan.revision,
    createdAt: now.toISOString(),
    area: {
      corridorM: OFFLINE_LIMITS.corridorM,
      stopRadiusM: OFFLINE_LIMITS.stopRadiusM,
      bounds: [
        [set.bounds.west, set.bounds.south],
        [set.bounds.east, set.bounds.north],
      ],
    },
    tiles: tiles.map((coord) => ({ ...coord, url: tilePath(packId, coord) })),
    tileTemplate: `/v1/explore/offline-tiles/${packId}/{z}/{x}/{y}`,
    tileZoom: {
      min: Math.min(...tiles.map((coord) => coord.z)),
      max: Math.max(...tiles.map((coord) => coord.z)),
    },
    glyphTemplate: GLYPH_TEMPLATE,
    tileBytes: sampledBytes,
    limit: {
      maxTiles: OFFLINE_LIMITS.maxTiles,
      maxBytes: OFFLINE_LIMITS.maxBytes,
      withinLimit: !overTiles && !overBytes,
      note: [
        `共 ${tiles.length} 张瓦片，已取 ${sampledBytes ? "少量样本" : "0 张"} ${(
          sampledBytes / 1024
        ).toFixed(0)} KB`,
        estimated ? `按每级抽样估算约 ${(estimate / 1024 / 1024).toFixed(1)} MB` : "大小未知",
        overTiles ? `超过单次 ${OFFLINE_LIMITS.maxTiles} 张上限，清单已截到上限` : "",
        overBytes ? "估算超过单次 50 MB 上限：缩小范围或选较低细节（detail=low）" : "",
      ]
        .filter(Boolean)
        .join("；"),
    },
    style: { vectorTilejson: tilejsonPath(packId) },
    glyphs: glyphs.map(({ fontstack, range }) => ({ url: glyphPath(fontstack, range) })),
    // 白模与楼影同源：每个已确认停留点一份建筑场景（离线时要能看白模、看受光）。
    scenes: set.stops
      .filter((stop) => stop.state === "confirmed")
      .map((stop) => ({
        stopId: stop.id,
        url: `/v1/explore/plans/${dossier}/scene?stopId=${encodeURIComponent(stop.id)}`,
      })),
    plan: `/v1/explore/plans/${dossier}/revisions/${input.plan.revision}`,
    light: `/v1/explore/plans/${dossier}/offline-light?day=${encodeURIComponent(input.day)}`,
    weather: `/v1/explore/plans/${dossier}/weather`,
    refs: refs.flatMap((ref) => (ref.image ? [{ id: ref.id, thumb: ref.image.src }] : [])),
    unknowns,
  };

  await client.query(
    `insert into explore_offline_pack
       (id,account_id,dossier_id,day,plan_revision,detail,manifest,tile_list,glyph_list,tiles_fetched,tile_bytes)
     values($1,$2,$3,$4::date,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11)`,
    [
      packId,
      account,
      dossier,
      input.day,
      input.plan.revision,
      detail,
      JSON.stringify(manifest),
      JSON.stringify(tiles),
      JSON.stringify(glyphs),
      // 样本也算已经取过的：这里记的是「服务端真的从这里取出去多少」。
      sampleCoords.length,
      sampledBytes,
    ],
  );
  return manifest;
}

async function loadPack(client: Client, account: string, packId: string): Promise<PackRow> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(packId))
    throw new ApiFailure("OFFLINE_PACK_NOT_FOUND", 404, "找不到这个离线包。");
  const row = (
    await client.query(
      `select id,dossier_id,to_char(day,'YYYY-MM-DD') as day,plan_revision,detail,manifest,tile_list,glyph_list,
              tiles_fetched,tile_bytes
         from explore_offline_pack where account_id=$1 and id=$2`,
      [account, packId],
    )
  ).rows[0] as PackRow | undefined;
  if (!row) throw new ApiFailure("OFFLINE_PACK_NOT_FOUND", 404, "找不到这个离线包。");
  return row;
}

/** 清单（准备页检查完整性用）：大小与超限状态按现在真实取到多少重算。 */
export async function readOfflinePack(
  client: Client,
  account: string,
  dossier: string,
  packId: string,
): Promise<OfflineManifest> {
  const row = await loadPack(client, account, packId);
  if (row.dossier_id !== dossier) throw new ApiFailure("OFFLINE_PACK_NOT_FOUND", 404, "找不到这个离线包。");
  const bytes = Number(row.tile_bytes);
  const tileCount = row.manifest.tiles.length;
  return {
    ...row.manifest,
    tileBytes: bytes,
    limit: {
      ...row.manifest.limit,
      withinLimit: tileCount <= OFFLINE_LIMITS.maxTiles && bytes <= OFFLINE_LIMITS.maxBytes,
      note: `${row.manifest.limit.note ?? ""}${row.manifest.limit.note ? "；" : ""}服务端已代取 ${
        row.tiles_fetched
      }/${tileCount} 张、${(bytes / 1024 / 1024).toFixed(1)} MB`,
    },
  };
}

/** 清单里列过的瓦片才代取；取过就落盘，重取不再打扰上游。 */
export async function offlineTile(
  client: Client,
  account: string,
  input: { packId: string; z: number; x: number; y: number },
  options: OfflineOptions,
): Promise<{ bytes: Buffer; mime: string; cached: boolean }> {
  const fetchRemote = options.fetch ?? defaultOfflineFetch;
  const row = await loadPack(client, account, input.packId);
  const coord = { z: input.z, x: input.x, y: input.y };
  if (!row.tile_list.some((item) => item.z === coord.z && item.x === coord.x && item.y === coord.y))
    throw new ApiFailure("OFFLINE_TILE_NOT_LISTED", 404, "这张瓦片不在这个离线包的清单里。");

  const cached = await options.storage.readPackAsset({
    dossier: row.dossier_id,
    packId: row.id,
    name: tileAssetName(coord),
  });
  if (cached) return { bytes: cached, mime: "application/vnd.mapbox-vector-tile", cached: true };

  if (Number(row.tile_bytes) >= OFFLINE_LIMITS.maxBytes)
    throw new ApiFailure(
      "OFFLINE_LIMIT_REACHED",
      413,
      "这个离线包已经到单次 50 MB 上限了；缩小范围或选较低细节重新准备。",
    );
  const source = await tileSource({ mapConfig: options.mapConfig, fetch: fetchRemote, now: options.now });
  const response = await outbound(() => fetchRemote(tileUrl(source.template, coord)));
  if (!response.ok)
    throw new ApiFailure("OFFLINE_TILE_FAILED", 503, `瓦片源返回 ${response.status}，这张先没取到。`);
  await options.storage.savePackAsset({
    dossier: row.dossier_id,
    packId: row.id,
    name: tileAssetName(coord),
    bytes: response.body,
  });
  await client.query(
    `update explore_offline_pack set tiles_fetched = tiles_fetched + 1, tile_bytes = tile_bytes + $3
      where account_id=$1 and id=$2`,
    [account, row.id, response.body.length],
  );
  return { bytes: response.body, mime: "application/vnd.mapbox-vector-tile", cached: false };
}

/**
 * 字形：只代取样式用到的 fontstack 的拉丁/标点区段（0–255、256–511）；
 * 中文走 MapLibre 的本地表意字体（设备字体），不进离线包。
 */
export async function offlineGlyph(
  input: { fontstack: string; range: string },
  options: OfflineOptions,
): Promise<{ bytes: Buffer; mime: string }> {
  const fetchRemote = options.fetch ?? defaultOfflineFetch;
  const range = input.range.replace(/\.pbf$/i, "");
  if (!FONTSTACKS.includes(input.fontstack) || !OFFLINE_LIMITS.glyphRanges.includes(range as "0-255"))
    throw new ApiFailure("OFFLINE_GLYPH_NOT_LISTED", 404, "这组字形不在离线范围内（只带拉丁与标点区段）。");
  const name = glyphAssetName(input.fontstack, range);
  const cached = await options.storage.readFontAsset({ name });
  if (cached) return { bytes: cached, mime: "application/x-protobuf" };
  const configured = options.mapConfig().vector.glyphs;
  const response = await outbound(() => fetchRemote(glyphUrl(configured, input.fontstack, range)));
  if (!response.ok)
    throw new ApiFailure("OFFLINE_GLYPH_FAILED", 503, `字形源返回 ${response.status}，这组先没取到。`);
  await options.storage.saveFontAsset({ name, bytes: response.body });
  return { bytes: response.body, mime: "application/x-protobuf" };
}

/**
 * 离线源 TileJSON：把瓦片地址改成这个包的代取路由。
 *
 * 页面把样式里矢量源指向这里，MapLibre 就只会跟我们要清单里列过的瓦片。
 */
export async function offlineTileJson(
  client: Client,
  account: string,
  input: { packId: string; origin: string },
  options: OfflineOptions,
): Promise<Record<string, unknown>> {
  const row = await loadPack(client, account, input.packId);
  const fetched = await tileSource({
    mapConfig: options.mapConfig,
    fetch: options.fetch ?? defaultOfflineFetch,
    now: options.now,
  });
  const zooms = row.tile_list.map((coord) => coord.z);
  return {
    ...fetched.raw,
    tiles: [`${input.origin}/v1/explore/offline-tiles/${row.id}/{z}/{x}/{y}`],
    minzoom: Math.min(...zooms),
    maxzoom: Math.max(...zooms),
  };
}

/** 一天的见光快照（离线包里的 light 地址）：已知的照实给，缺的写进 unknowns。 */
export function lightSnapshot(document: PlanDocument, day: string) {
  const stops = document.stops.filter((stop) => stop.day === day);
  const unknowns: string[] = [];
  const items = stops.map((stop) => {
    if (!stop.light?.horizon) unknowns.push(`${stop.name}：没有地形见光数据`);
    if (!stop.light2) unknowns.push(`${stop.name}：双位置受光还没算`);
    return {
      stopId: stop.id,
      name: stop.name,
      state: stop.state,
      window: stop.window ?? null,
      facing: stop.facing ?? null,
      light: stop.light ?? null,
      // 第二版：机位 / 模特两个位置的受光，与建筑场景同源。
      light2: stop.light2 ?? null,
      cameraHeightM: stop.cameraHeightM ?? null,
      subjectHeightM: stop.subjectHeightM ?? null,
      subjectPoint: stop.subjectPoint ?? null,
      areaRef: stop.areaRef ?? null,
    };
  });
  const digest = createHash("sha256").update(JSON.stringify(items)).digest("hex").slice(0, 16);
  return { day, version: digest, stops: items, unknowns };
}
