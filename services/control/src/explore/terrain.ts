/**
 * 山体遮挡与地形见光（06 §5.1、07 契约第 1、2 节 StopLight）。
 *
 * 取机位周围真实高程（Copernicus GLO-90，经 Open-Meteo Elevation API，免 key），
 * 沿不同方位采样周边山脊，算每个方位的最大仰角形成地平线曲线；再把太阳轨迹
 * 和地平线比，求出「山后见光」时段。
 *
 * 边界说清楚：GLO-90 是约 90 米地表模型，**建筑和树木分不出来**，只能给山体尺度
 * 的估算；拿不到数据就是未知，绝不默认「无遮挡」。
 */
import type { LngLat, StopLight } from "@reinlab/contracts";
import { isoAt, sunPositionAt } from "./sun";

export type ElevationTransport = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<any>;
}>;

/** 默认走真实网络；测试或换源时用 configureTerrainTransport 覆盖。 */
let defaultTransport: ElevationTransport | undefined;
export function configureTerrainTransport(transport?: ElevationTransport) {
  defaultTransport = transport;
}

export type TerrainResult = {
  light: StopLight;
  /** 取不到时给人看的一句话。 */
  reason?: string;
};

const ELEVATION_ENDPOINT = "https://api.open-meteo.com/v1/elevation";
/** 方位采样：15° 一圈；距离环：近处细、远处粗（90 米分辨率够用）。 */
export const AZIMUTH_STEP_DEG = 15;
export const DISTANCE_KM = [0.6, 1.5, 3, 6];
/** 观测高度：机位按人眼/三脚架高度 1.6 米。 */
export const OBSERVER_HEIGHT_M = 1.6;
/** 只算到这个半径；不把有限范围内的结果说成绝对无遮挡。 */
export const TERRAIN_RADIUS_KM = Math.max(...DISTANCE_KM);
const DEM_LABEL = "Copernicus GLO-90（Open-Meteo Elevation API）";
const EARTH_RADIUS_M = 6371000;

/** 沿方位和距离推一个点（球面近似，几公里内够用）。 */
export function pointAt(at: LngLat, azimuthDeg: number, distanceKm: number): LngLat {
  const rad = (azimuthDeg * Math.PI) / 180;
  const dLat = (distanceKm * 1000 * Math.cos(rad)) / 111_320;
  const dLng =
    (distanceKm * 1000 * Math.sin(rad)) / (111_320 * Math.cos((at[1] * Math.PI) / 180));
  return [at[0] + dLng, at[1] + dLat];
}

/** 地球曲率带来的下沉量（米）。 */
const curvatureDropM = (distanceM: number) => (distanceM * distanceM) / (2 * EARTH_RADIUS_M);

/**
 * 从一组 (方位, 距离, 高程) 算地平线仰角。
 * 机位自身高程也用同一套数据，避免拿海拔和山脊两套基准。
 */
export function horizonFromSamples(
  baseAltitudeM: number,
  samples: { azimuth: number; distanceKm: number; altitudeM: number }[],
): { azimuth: number; elevation: number }[] {
  const byAzimuth = new Map<number, number>();
  for (const sample of samples) {
    const height =
      sample.altitudeM + curvatureDropM(sample.distanceKm * 1000) - (baseAltitudeM + OBSERVER_HEIGHT_M);
    const angle = (Math.atan2(height, sample.distanceKm * 1000) * 180) / Math.PI;
    const key = Math.round(sample.azimuth / AZIMUTH_STEP_DEG) * AZIMUTH_STEP_DEG;
    byAzimuth.set(key, Math.max(byAzimuth.get(key) ?? -90, angle));
  }
  return [...byAzimuth.entries()]
    .map(([azimuth, elevation]) => ({ azimuth: (azimuth + 360) % 360, elevation: Math.round(elevation * 10) / 10 }))
    .sort((a, b) => a.azimuth - b.azimuth);
}

/** 地平线曲线上的仰角（按方位线性插值，整数方位环绕）。 */
export function horizonElevationAt(
  horizon: { azimuth: number; elevation: number }[],
  azimuth: number,
): number | null {
  if (!horizon.length) return null;
  const sorted = [...horizon].sort((a, b) => a.azimuth - b.azimuth);
  const target = ((azimuth % 360) + 360) % 360;
  let before = sorted[sorted.length - 1];
  let after = sorted[0];
  for (let index = 0; index < sorted.length; index += 1) {
    if (sorted[index].azimuth <= target) before = sorted[index];
    if (sorted[index].azimuth >= target) {
      after = sorted[index];
      break;
    }
  }
  if (before.azimuth === after.azimuth) return before.elevation;
  let span = after.azimuth - before.azimuth;
  if (span < 0) span += 360;
  let offset = target - before.azimuth;
  if (offset < 0) offset += 360;
  return before.elevation + ((after.elevation - before.elevation) * offset) / (span || 1);
}

/**
 * 一天里的地形见光时段：太阳高度高过该方位的地平线才算见光。
 * 用同一套太阳计算（sun.ts），所以和前端拖动时间线看到的太阳位置一致。
 */
export function litWindows(
  at: LngLat,
  timezone: string,
  day: string,
  horizon: { azimuth: number; elevation: number }[],
  options: { stepMinutes?: number } = {},
): { start: string; end: string }[] {
  const step = options.stepMinutes ?? 2;
  const [year, month, date] = day.split("-").map(Number);
  const startUtc = Date.UTC(year, month - 1, date) - 12 * 3600_000;
  const windows: { start: string; end: string }[] = [];
  let open: Date | null = null;
  for (let minute = 0; minute <= 24 * 60; minute += step) {
    const instant = new Date(startUtc + minute * 60_000);
    const local = isoAt(timezone, instant);
    if (local.slice(0, 10) !== day) continue;
    const sun = sunPositionAt(at, instant, timezone);
    const blocked = horizonElevationAt(horizon, sun.azimuth);
    const lit = blocked === null ? sun.altitude > 0 : sun.altitude > blocked + 0.3;
    if (lit && !open) open = instant;
    if (!lit && open) {
      windows.push({ start: isoAt(timezone, open), end: isoAt(timezone, instant) });
      open = null;
    }
  }
  if (open) {
    const endOfDay = new Date(startUtc + 24 * 60 * 60_000);
    windows.push({ start: isoAt(timezone, open), end: isoAt(timezone, endOfDay) });
  }
  return windows.filter((window) => window.start < window.end);
}

/**
 * 算一个机位的地形见光。取不到高程就返回 horizon/lit 为 null + 原因，
 * 页面写「没有地形数据」，绝不默认无遮挡。
 */
export async function computeStopLight(
  input: {
    at: LngLat;
    timezone: string;
    day: string;
    transport?: ElevationTransport;
    timeoutMs?: number;
  },
): Promise<TerrainResult> {
  // 测试环境不默认连外网：要测地形就注入一个传输层，和天气/网图那边一致。
  if (!input.transport && !defaultTransport && process.env.NODE_ENV === "test")
    return {
      light: { horizon: null, lit: null, basis: null },
      reason: "测试环境不连高程服务（要验证就注入传输层）。",
    };
  const transport: ElevationTransport =
    input.transport ??
    defaultTransport ??
    ((url) =>
      fetch(url, {
        headers: { "user-agent": "ReinLab/1.0 (local travel-plan tool)" },
        signal: AbortSignal.timeout(input.timeoutMs ?? 12_000),
      }) as any);

  const azimuths: number[] = [];
  for (let azimuth = 0; azimuth < 360; azimuth += AZIMUTH_STEP_DEG) azimuths.push(azimuth);
  const points: { azimuth: number; distanceKm: number }[] = [];
  for (const azimuth of azimuths) for (const distanceKm of DISTANCE_KM) points.push({ azimuth, distanceKm });
  const coordinates = points.map((point) => pointAt(input.at, point.azimuth, point.distanceKm));
  // 机位自己也取一个（同一套基准）。
  const all = [input.at, ...coordinates];

  const url =
    `${ELEVATION_ENDPOINT}?latitude=${all.map((p) => p[1].toFixed(5)).join(",")}` +
    `&longitude=${all.map((p) => p[0].toFixed(5)).join(",")}`;
  const unavailable = (reason: string): TerrainResult => ({
    light: { horizon: null, lit: null, basis: null },
    reason,
  });
  try {
    const response = await transport(url);
    if (!response.ok) return unavailable(`高程服务返回 ${response.status}，这次没有地形数据。`);
    const body = await response.json();
    const elevations: unknown[] = Array.isArray(body?.elevation) ? body.elevation : [];
    if (elevations.length !== all.length || elevations.some((value) => typeof value !== "number"))
      return unavailable("高程服务没有回全这些点的海拔，这次没有地形数据。");
    const base = Number(elevations[0]);
    const samples = points.map((point, index) => ({
      azimuth: point.azimuth,
      distanceKm: point.distanceKm,
      altitudeM: Number(elevations[index + 1]),
    }));
    const horizon = horizonFromSamples(base, samples);
    if (!horizon.length) return unavailable("地平线没算出来，这次没有地形数据。");
    return {
      light: {
        horizon,
        lit: litWindows(input.at, input.timezone, input.day, horizon),
        basis: { dem: DEM_LABEL, radiusKm: TERRAIN_RADIUS_KM, resolutionM: 90 },
      },
    };
  } catch (error) {
    return unavailable(`没连上高程服务：${String((error as Error)?.message ?? error).slice(0, 100)}`);
  }
}
