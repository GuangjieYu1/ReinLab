/**
 * 地点搜索与步行路线（06 §2.1、§4、07 契约第 2、3 节）。
 *
 * 国内用高德（GCJ-02，进出边界转换），海外用 openrouteservice（WGS84）。
 * 凭据只在宿主的配置里读，**不发给浏览器**；没有配置就明确说缺哪项，
 * 不换成别的来源、也不把直线距离当步行路线。
 */
import type { Conflict, LngLat, RouteLeg, Source, Stop } from "@reinlab/contracts";
import { ApiFailure } from "../api/errors";
import { chinaTimezone, gcj02ToWgs84, likelyMainlandChina, wgs84ToGcj02 } from "./geo";

export type GeoProviderKind = "amap" | "ors";

export type GeoTransport = (url: string, init?: { method?: string; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<any>;
}>;

export type GeoProviders = {
  amapKey: string | null;
  orsKey: string | null;
  /** openrouteservice 的自建/官方地址，默认官方。 */
  orsBaseUrl?: string;
  transport?: GeoTransport;
};

let current: GeoProviders = { amapKey: null, orsKey: null };
const AMAP_BASE = "https://restapi.amap.com";
const ORS_BASE_DEFAULT = "https://api.openrouteservice.org";

export function configureGeoProviders(providers: GeoProviders) {
  current = providers;
}

export function geoProviderStatus() {
  return { amap: Boolean(current.amapKey), ors: Boolean(current.orsKey) };
}

const transportOf = (): GeoTransport =>
  current.transport ?? ((url, init) => fetch(url, { ...(init ?? {}), signal: AbortSignal.timeout(12_000) }) as any);

const orsBase = () => (current.orsBaseUrl ?? ORS_BASE_DEFAULT).replace(/\/+$/, "");

/** 选哪个来源：显式指定 > 目的地时区 > 坐标粗判断。 */
export function providerFor(options: { provider?: string; timezone?: string | null; near?: LngLat | null }): GeoProviderKind {
  if (options.provider === "amap" || options.provider === "ors") return options.provider;
  if (chinaTimezone(options.timezone)) return "amap";
  if (options.near && likelyMainlandChina(options.near)) return "amap";
  return "ors";
}

const amapSource = (): Source => ({ name: "高德", url: "https://lbs.amap.com/", fetchedAt: new Date().toISOString() });
const orsSource = (): Source => ({ name: "openrouteservice", url: "https://openrouteservice.org/", fetchedAt: new Date().toISOString() });

const amapPoint = (value: unknown): LngLat | null => {
  if (typeof value !== "string") return null;
  const [lng, lat] = value.split(",").map(Number);
  return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
};

export type PlaceHit = { name: string; address?: string; at: LngLat; source: Source };

/** 查地点。缺配置时抛 PLACES_NOT_CONFIGURED，页面照实显示「没配置」。 */
export async function searchPlaces(input: {
  q: string;
  near?: LngLat | null;
  provider?: string;
  timezone?: string | null;
  limit?: number;
}): Promise<PlaceHit[]> {
  const q = input.q.trim();
  if (!q) return [];
  const kind = providerFor(input);
  const limit = Math.min(Math.max(input.limit ?? 8, 1), 20);

  if (kind === "amap") {
    if (!current.amapKey)
      throw new ApiFailure(
        "PLACES_NOT_CONFIGURED",
        503,
        "国内地点搜索要配高德 Web 服务 key（AMAP_KEY），现在没有配。",
        // 页面据此显示「没配置」而不是报错弹窗；助手据此照实转述。
        { provider: "amap", missing: ["AMAP_KEY"] },
      );
    const params = new URLSearchParams({ key: current.amapKey, keywords: q, offset: String(limit), page: "1" });
    if (input.near) {
      const [lng, lat] = wgs84ToGcj02(input.near);
      params.set("location", `${lng},${lat}`);
    }
    const response = await transportOf()(`${AMAP_BASE}/v3/place/text?${params.toString()}`);
    if (!response.ok) throw new ApiFailure("PLACES_UPSTREAM", 503, `高德返回 ${response.status}，没查到地点。`);
    const body = await response.json();
    if (String(body?.status ?? "1") !== "1")
      throw new ApiFailure("PLACES_UPSTREAM", 503, `高德说：${String(body?.info ?? "查询失败").slice(0, 80)}`);
    const pois = Array.isArray(body?.pois) ? body.pois : [];
    return pois.flatMap((poi: any) => {
      const gcj = amapPoint(poi?.location);
      if (!gcj) return [];
      return [
        {
          name: String(poi?.name ?? "未命名地点").slice(0, 120),
          ...(poi?.address ? { address: String(poi.address).slice(0, 200) } : {}),
          // 高德给的是 GCJ-02：进业务层立刻转回 WGS84，之后不再重复偏移。
          at: gcj02ToWgs84(gcj),
          source: amapSource(),
        },
      ];
    });
  }

  if (!current.orsKey)
    throw new ApiFailure(
      "PLACES_NOT_CONFIGURED",
      503,
      "海外地点搜索要配 openrouteservice key（ORS_KEY），现在没有配。",
      { provider: "ors", missing: ["ORS_KEY"] },
    );
  const params = new URLSearchParams({ api_key: current.orsKey, text: q, size: String(limit) });
  if (input.near) params.set("focus.point.lat", String(input.near[1])), params.set("focus.point.lon", String(input.near[0]));
  const response = await transportOf()(`${orsBase()}/geocode/search?${params.toString()}`);
  if (!response.ok) throw new ApiFailure("PLACES_UPSTREAM", 503, `openrouteservice 返回 ${response.status}，没查到地点。`);
  const body = await response.json();
  const features = Array.isArray(body?.features) ? body.features : [];
  return features.flatMap((feature: any) => {
    const coordinates = feature?.geometry?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) return [];
    const properties = feature?.properties ?? {};
    return [
      {
        name: String(properties.name ?? properties.label ?? "未命名地点").slice(0, 120),
        ...(properties.label ? { address: String(properties.label).slice(0, 200) } : {}),
        at: [Number(coordinates[0]), Number(coordinates[1])] as LngLat,
        source: orsSource(),
      },
    ];
  });
}

const AMAP_LEG = (polyline: string): LngLat[] =>
  polyline
    .split(";")
    .map((pair) => amapPoint(pair))
    .filter((point): point is LngLat => point !== null)
    .map((point) => gcj02ToWgs84(point));

const orsLeg = (coordinates: unknown): LngLat[] =>
  Array.isArray(coordinates)
    ? coordinates.flatMap((pair: any) =>
        Array.isArray(pair) && pair.length >= 2 && Number.isFinite(pair[0]) && Number.isFinite(pair[1])
          ? [[Number(pair[0]), Number(pair[1])] as LngLat]
          : [],
      )
    : [];

export type WalkResult =
  | { state: "ok"; geometry: LngLat[]; distanceM: number; durationS: number; source: Source }
  | { state: "unavailable"; reason: string; source: Source };

/** 两点之间的真实步行路线。取不到就如实说「未取得」，不拿直线顶替。 */
export async function walkingRoute(input: {
  from: LngLat;
  to: LngLat;
  provider?: string;
  timezone?: string | null;
}): Promise<WalkResult> {
  const kind = providerFor({ provider: input.provider, timezone: input.timezone, near: input.from });

  if (kind === "amap") {
    if (!current.amapKey)
      return {
        state: "unavailable",
        reason: "没配高德 Web 服务 key（AMAP_KEY），步行路线没取。",
        source: { name: "高德（未配置）" },
      };
    const origin = wgs84ToGcj02(input.from);
    const destination = wgs84ToGcj02(input.to);
    const params = new URLSearchParams({
      key: current.amapKey,
      origin: `${origin[0]},${origin[1]}`,
      destination: `${destination[0]},${destination[1]}`,
    });
    try {
      // 用 v3 步行导航：v4 接口对当前这类 Web 服务 key 返回 SERVICE_NOT_AVAILABLE（实测）。
      const response = await transportOf()(`${AMAP_BASE}/v3/direction/walking?${params.toString()}`);
      const body = await response.json().catch(() => ({}));
      const path = body?.route?.paths?.[0];
      if (!response.ok || String(body?.status ?? "") !== "1" || !path)
        return {
          state: "unavailable",
          reason: `高德没给出步行路线（${String(
            body?.info ?? body?.errmsg ?? body?.errcode ?? response.status,
          ).slice(0, 60)}）。`,
          source: { name: "高德" },
        };
      const steps = Array.isArray(path.steps) ? path.steps : [];
      const geometry = steps.flatMap((step: any) => AMAP_LEG(String(step?.polyline ?? "")));
      if (geometry.length < 2)
        return { state: "unavailable", reason: "高德返回的路线没有可用顶点。", source: { name: "高德" } };
      return {
        state: "ok",
        geometry,
        distanceM: Math.round(Number(path.distance ?? 0)),
        durationS: Math.round(Number(path.duration ?? 0)),
        source: amapSource(),
      };
    } catch (error) {
      return {
        state: "unavailable",
        reason: `高德路线请求失败：${String((error as Error)?.message ?? error).slice(0, 80)}`,
        source: { name: "高德" },
      };
    }
  }

  if (!current.orsKey)
    return {
      state: "unavailable",
      reason: "没配 openrouteservice key（ORS_KEY），步行路线没取。",
      source: { name: "openrouteservice（未配置）" },
    };
  try {
    const response = await transportOf()(
      `${orsBase()}/v2/directions/foot-walking/geojson?api_key=${encodeURIComponent(current.orsKey)}`,
      { method: "POST", body: JSON.stringify({ coordinates: [input.from, input.to] }) },
    );
    const body = await response.json().catch(() => ({}));
    const feature = Array.isArray(body?.features) ? body.features[0] : null;
    if (!response.ok || !feature)
      return {
        state: "unavailable",
        reason: `openrouteservice 没给出步行路线（${String(body?.error?.message ?? response.status).slice(0, 60)}）。`,
        source: { name: "openrouteservice" },
      };
    const geometry = orsLeg(feature?.geometry?.coordinates);
    if (geometry.length < 2)
      return { state: "unavailable", reason: "openrouteservice 返回的路线没有可用顶点。", source: { name: "openrouteservice" } };
    const summary = feature?.properties?.summary ?? {};
    return {
      state: "ok",
      geometry,
      distanceM: Math.round(Number(summary.distance ?? 0)),
      durationS: Math.round(Number(summary.duration ?? 0)),
      source: orsSource(),
    };
  } catch (error) {
    return {
      state: "unavailable",
      reason: `openrouteservice 路线请求失败：${String((error as Error)?.message ?? error).slice(0, 80)}`,
      source: { name: "openrouteservice" },
    };
  }
}

/** 停留点的代表坐标（点用它自己，区域用重心）。 */
export function stopPoint(stop: Stop): LngLat {
  if (stop.geometry.type === "Point") return stop.geometry.coordinates as LngLat;
  const ring = (stop.geometry as { coordinates: number[][][] }).coordinates?.[0] ?? [];
  if (!ring.length) return [0, 0];
  const sum = ring.reduce<[number, number]>((acc, point) => [acc[0] + point[0], acc[1] + point[1]], [0, 0]);
  return [sum[0] / ring.length, sum[1] / ring.length];
}

/**
 * 已确认停留点之间的步行路线：按日期与时段排序，逐段取真实路线。
 * 一段取不到就留 geometry: null（页面写「路线未取得」），不让整批失败。
 */
export async function walkLegs(
  stops: Stop[],
  options: { timezone?: string | null; provider?: string } = {},
): Promise<RouteLeg[]> {
  const ordered = [...stops].sort((a, b) => {
    if (a.day !== b.day) return a.day.localeCompare(b.day);
    return (a.window?.start ?? "").localeCompare(b.window?.start ?? "");
  });
  const legs: RouteLeg[] = [];
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const from = ordered[index];
    const to = ordered[index + 1];
    const walk = await walkingRoute({
      from: stopPoint(from),
      to: stopPoint(to),
      timezone: options.timezone,
      ...(options.provider ? { provider: options.provider } : {}),
    });
    legs.push(
      walk.state === "ok"
        ? {
            from: from.id,
            to: to.id,
            geometry: { type: "LineString", coordinates: walk.geometry },
            distanceM: walk.distanceM,
            durationS: walk.durationS,
            source: walk.source,
          }
        : {
            from: from.id,
            to: to.id,
            geometry: null,
            distanceM: null,
            durationS: null,
            source: walk.source,
            // 为什么没取到：页面照实显示，别当成「没有路」。
            ...({ reason: walk.reason } as Record<string, unknown>),
          } as RouteLeg,
    );
  }
  return legs;
}

/** 把时刻写成拍摄地点当地钟点（用时段自己的偏移，不受服务器时区影响）。 */
function clockWithOffset(instant: number, offset: string): string {
  const sign = offset.startsWith("-") ? -1 : 1;
  const [hours, minutes] = offset.slice(1).split(":").map(Number);
  const local = new Date(instant + sign * (hours * 60 + minutes) * 60000);
  return local.toISOString().slice(11, 16);
}

const offsetOf = (iso: string): string => /([+-]\d{2}:\d{2})$/.exec(iso)?.[1] ?? "+00:00";

/** 按日期与时段排序的已确认停留点。 */
export function orderedConfirmedStops(stops: Stop[]): Stop[] {
  return stops
    .filter((stop) => stop.state === "confirmed")
    .sort((a, b) => {
      if (a.day !== b.day) return a.day.localeCompare(b.day);
      return (a.window?.start ?? "").localeCompare(b.window?.start ?? "");
    });
}

/**
 * 赶不上拍摄窗口：按上一段结束 + 真实步行时间推算到达时刻。
 * 缺路线或缺时段就不猜（不把未知说成冲突）。
 */
export function conflictsOf(stops: Stop[], legs: RouteLeg[]): Conflict[] {
  const ordered = orderedConfirmedStops(stops);
  const byPair = new Map(legs.map((leg) => [leg.from + "|" + leg.to, leg]));
  const conflicts: Conflict[] = [];
  let departure: number | null = null;
  for (const [index, stop] of ordered.entries()) {
    const start = stop.window ? new Date(stop.window.start).getTime() : null;
    const end = stop.window ? new Date(stop.window.end).getTime() : null;
    if (index > 0) {
      const leg = byPair.get(ordered[index - 1].id + "|" + stop.id);
      const travel = leg?.durationS === null || leg?.durationS === undefined ? null : leg.durationS * 1000;
      if (departure !== null && travel !== null && start !== null) {
        const arrival = departure + travel;
        const offset = stop.window ? offsetOf(stop.window.start) : "+00:00";
        if (arrival > start)
          conflicts.push({
            stopId: stop.id,
            text: `按步行时间约 ${clockWithOffset(arrival, offset)} 才到这，赶不上 ${clockWithOffset(start, offset)} 的拍摄窗口。`,
          });
      }
    }
    departure = end;
  }
  return conflicts;
}
