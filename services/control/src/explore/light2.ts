/**
 * 双位置受光（design/prd/09-explore-v2.md §7.2–7.3、10-explore-v2-contract.md §1）。
 *
 * 机位与模特各算一遍：沿太阳方向发射线，和「有高度来源」的楼块求交；有 min_height 的
 * 楼底部留空隙（能从楼下穿过去的不算挡）。山体用第一版的地形地平线，太阳用同一套计算。
 *
 * 只下这些结论：night（太阳在地平线下）、terrain（山挡）、building（楼挡，带 buildingIds）、
 * maybe_lit（已知数据下预计有光，缺项写进 missing）、unknown（数据不够，说不清）。
 * 没有「确定有光」这一档：OSM 和 90 m 高程都不足以承诺。
 */
import type {
  Building,
  BuildingScene,
  LightSegment,
  LngLat,
  PositionLight,
  Stop,
  StopLight,
  StopLight2,
} from "@reinlab/contracts";
import { isoAt, offsetMinutesAt, sunPositionAt } from "./sun";
import { horizonElevationAt } from "./terrain";
import { toLocalMeters } from "./scene";

/** 默认相机与主体采样高度（米）。 */
export const DEFAULT_CAMERA_HEIGHT_M = 1.5;
export const DEFAULT_SUBJECT_HEIGHT_M = 1.5;
/** 粗采样步长；状态变化后细到分钟。 */
const COARSE_STEP_MIN = 2;

type Edge = { ax: number; ay: number; bx: number; by: number };

type BuildingShape = {
  id: string;
  bbox: [number, number, number, number];
  edges: Edge[];
  heightM: number;
  minHeightM: number;
};

/** 把场景几何摊成边表 + 包围盒，采样时反复用。 */
export function shapesOf(scene: BuildingScene): BuildingShape[] {
  return scene.buildings
    .filter((building): building is Building & { heightM: number } => building.heightM !== null)
    .map((building) => {
      const ring = building.footprint;
      const edges: Edge[] = [];
      for (let index = 1; index < ring.length; index += 1)
        edges.push({ ax: ring[index - 1][0], ay: ring[index - 1][1], bx: ring[index][0], by: ring[index][1] });
      const xs = ring.map((point) => point[0]);
      const ys = ring.map((point) => point[1]);
      return {
        id: building.id,
        bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
        edges,
        heightM: building.heightM,
        minHeightM: Math.max(0, building.minHeightM ?? 0),
      };
    });
}

export type RayBlock = { buildingId: string; distance: number } | null;

/**
 * 从 (x, y, height) 沿 (dx, dy) 发射线，看哪栋楼先挡住。
 * 命中点上射线的高度必须落在这栋楼的 [minHeight, height] 之间——底部有洞（骑楼、架空层）
 * 时能穿过去，不能拿最大屋顶仰角一律判「全挡」。
 */
export function blockedBy(
  shapes: BuildingShape[],
  ray: { x: number; y: number; dx: number; dy: number; height: number; slope: number },
): RayBlock {
  let best: RayBlock = null;
  for (const shape of shapes) {
    const [minX, minY, maxX, maxY] = shape.bbox;
    // 先看射线会不会碰到包围盒：斜率已知时用射线起点到盒子的最近距离做粗筛。
    if (!rayCrossesBox(ray, minX, minY, maxX, maxY)) continue;
    for (const edge of shape.edges) {
      const ex = edge.bx - edge.ax;
      const ey = edge.by - edge.ay;
      const denominator = ray.dx * ey - ray.dy * ex;
      if (Math.abs(denominator) < 1e-9) continue;
      const ox = edge.ax - ray.x;
      const oy = edge.ay - ray.y;
      const t = (ox * ey - oy * ex) / denominator;
      if (t <= 0.05) continue;
      const u = (ox * ray.dy - oy * ray.dx) / denominator;
      if (u < 0 || u > 1) continue;
      if (best && t >= best.distance) continue;
      const rayHeight = ray.height + t * ray.slope;
      if (rayHeight > shape.heightM || rayHeight < shape.minHeightM) continue;
      best = { buildingId: shape.id, distance: t };
    }
  }
  return best;
}

/** 射线与轴对齐包围盒相交的粗筛（只用来少算边，不参与判定）。 */
function rayCrossesBox(
  ray: { x: number; y: number; dx: number; dy: number },
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): boolean {
  let tMin = 0;
  let tMax = Number.POSITIVE_INFINITY;
  for (const [origin, direction, low, high] of [
    [ray.x, ray.dx, minX, maxX],
    [ray.y, ray.dy, minY, maxY],
  ] as [number, number, number, number][]) {
    if (Math.abs(direction) < 1e-9) {
      if (origin < low || origin > high) return false;
      continue;
    }
    const t1 = (low - origin) / direction;
    const t2 = (high - origin) / direction;
    tMin = Math.max(tMin, Math.min(t1, t2));
    tMax = Math.min(tMax, Math.max(t1, t2));
    if (tMin > tMax) return false;
  }
  return true;
}

export type LightContext = {
  scene: BuildingScene | null;
  terrain: StopLight | null;
  day: string;
  timezone: string;
  /** 待判定的位置（场景原点为基准）。 */
  point: [number, number];
  heightM: number;
  timezoneOffsetMin: number;
  shapes: BuildingShape[];
  unknownBuildings: number;
};

export type LightReading = { state: LightSegment["state"]; buildingIds?: string[]; note?: string };

/**
 * 某一瞬间某个位置的受光状态。太阳方位用第一版同一约定（真北 0° 顺时针、高度角）。
 */
export function readingAt(context: LightContext, minutesOfDay: number): LightReading {
  const [year, month, date] = context.day.split("-").map(Number);
  const wallUtc = Date.UTC(year, month - 1, date, 0, 0, 0);
  const instant = new Date(wallUtc - context.timezoneOffsetMin * 60_000 + minutesOfDay * 60_000);
  const [lng, lat] = context.scene?.origin ?? [0, 0];
  const sun = sunPositionAt([lng, lat], instant, context.timezone);
  if (sun.altitude <= 0) return { state: "night" };
  // 山体：第一版的地形地平线，按方位取该方向的仰角。
  if (context.terrain?.horizon) {
    const ridge = horizonElevationAt(context.terrain.horizon, sun.azimuth);
    if (ridge !== null && sun.altitude < ridge + 0.3) return { state: "terrain" };
  }
  if (!context.scene || context.scene.coverage.status === "failed")
    return { state: "unknown", note: context.scene ? "建筑数据没取到，楼影未知" : "没有建筑场景" };
  if (!context.terrain?.horizon) return { state: "unknown", note: "没有地形高程数据，山挡未知" };
  const altitudeRad = (sun.altitude * Math.PI) / 180;
  const azimuthRad = (sun.azimuth * Math.PI) / 180;
  // 方位：真北 0° 顺时针 → 东为 +x、北为 +y。
  const hit = blockedBy(context.shapes, {
    x: context.point[0],
    y: context.point[1],
    dx: Math.sin(azimuthRad),
    dy: Math.cos(azimuthRad),
    height: context.heightM,
    slope: Math.tan(altitudeRad),
  });
  if (hit) return { state: "building", buildingIds: [hit.buildingId] };
  if (context.scene.coverage.status === "empty")
    return { state: "unknown", note: "这一圈没有建筑几何，不能断言没被挡" };
  return { state: "maybe_lit" };
}

const stateKey = (reading: LightReading) =>
  `${reading.state}:${(reading.buildingIds ?? []).slice(0, 3).join(",")}`;

/** 一天里的分段：先 2 分钟粗采，状态变化处再二分细化到分钟。 */
export function segmentsFor(context: LightContext, dayStartMin = 0, dayEndMin = 24 * 60): LightSegment[] {
  const [year, month, date] = context.day.split("-").map(Number);
  const dayStart = Date.UTC(year, month - 1, date, 0, 0, 0);
  const iso = (minutes: number) =>
    isoAt(context.timezone, new Date(dayStart - context.timezoneOffsetMin * 60_000 + minutes * 60_000));
  const boundaries: { minute: number; reading: LightReading }[] = [];
  let previous: LightReading | null = null;
  for (let minute = dayStartMin; minute <= dayEndMin; minute += COARSE_STEP_MIN) {
    const reading = readingAt(context, minute);
    if (previous && stateKey(reading) !== stateKey(previous)) {
      // 二分到分钟：找出状态翻转的那一分钟。
      let low = Math.max(dayStartMin, minute - COARSE_STEP_MIN);
      let high = minute;
      while (high - low > 1) {
        const middle = Math.floor((low + high) / 2);
        if (stateKey(readingAt(context, middle)) === stateKey(previous)) low = middle;
        else high = middle;
      }
      boundaries.push({ minute: high, reading });
    }
    previous = reading;
  }
  const first = readingAt(context, dayStartMin);
  const segments: LightSegment[] = [];
  let start = dayStartMin;
  let current = first;
  const push = (end: number) => {
    if (end <= start) return;
    segments.push({
      start: iso(start),
      end: iso(end),
      state: current.state,
      ...(current.buildingIds?.length || current.note
        ? { cause: { ...(current.buildingIds?.length ? { buildingIds: current.buildingIds.slice(0, 5) } : {}), ...(current.note ? { note: current.note } : {}) } }
        : {}),
    });
  };
  for (const boundary of boundaries) {
    push(boundary.minute);
    start = boundary.minute;
    current = boundary.reading;
  }
  push(dayEndMin);
  return segments.filter((segment) => segment.start < segment.end);
}

const mergeWindows = (segments: LightSegment[]): { start: string; end: string }[] => {
  const windows: { start: string; end: string }[] = [];
  for (const segment of segments) {
    if (segment.state !== "maybe_lit") continue;
    const last = windows[windows.length - 1];
    if (last && last.end === segment.start) last.end = segment.end;
    else windows.push({ start: segment.start, end: segment.end });
  }
  return windows;
};

const centerOf = (geometry: Stop["geometry"]): LngLat => {
  if (geometry.type === "Point") return geometry.coordinates as LngLat;
  const ring = (geometry.coordinates[0] ?? []) as LngLat[];
  if (!ring.length) return [0, 0];
  const sum = ring.reduce<[number, number]>((acc, point) => [acc[0] + point[0], acc[1] + point[1]], [0, 0]);
  return [sum[0] / ring.length, sum[1] / ring.length];
};

export type Light2Input = {
  scene: BuildingScene | null;
  stop: Stop;
  day: string;
  timezone: string;
  terrain: StopLight | null;
  previousVersion?: number;
  now?: Date;
};

/**
 * 算一个停留点的双位置受光。
 *
 * 片区类停留点没有 areaRef 时不算精确时段：给一段 unknown 并写清原因。
 * 模特点没设（subjectPoint 为空）就给 subject: null —— 风光不需要模特位置。
 */
export function computeLight2(input: Light2Input): StopLight2 {
  const now = input.now ?? new Date();
  const offsetMin = offsetMinutesAt(input.timezone, now);
  const shapes = input.scene ? shapesOf(input.scene) : [];
  const unknownBuildings = input.scene
    ? input.scene.buildings.filter((building) => building.heightM === null).length
    : 0;
  const sceneOrigin = input.scene?.origin ?? null;

  const missing: string[] = [];
  if (!input.scene) missing.push("没有建筑数据（Overpass 没取到），楼影未知");
  else {
    if (input.scene.coverage.status === "failed") missing.push("建筑数据取数失败，楼影未知");
    if (input.scene.coverage.status === "empty") missing.push("这一圈没有建筑几何，楼影按未知处理");
    if (unknownBuildings > 0) missing.push(`${unknownBuildings} 栋楼高未知，可能有遮挡（不补默认高度）`);
    if (input.scene.coverage.status === "partial") missing.push("建筑数据不完整（部分几何缺失）");
  }
  if (!input.terrain?.horizon) missing.push("没有地形高程数据，山体遮挡未知");

  const pointOf = (at: LngLat): [number, number] =>
    sceneOrigin ? toLocalMeters(sceneOrigin, at) : [0, 0];

  const position = (
    label: "camera" | "subject",
    at: LngLat,
    height: number,
    assumed: boolean,
  ): PositionLight => {
    const context: LightContext = {
      scene: input.scene,
      terrain: input.terrain,
      day: input.day,
      timezone: input.timezone,
      point: pointOf(at),
      heightM: height,
      timezoneOffsetMin: offsetMin,
      shapes,
      unknownBuildings,
    };
    const segments = segmentsFor(context);
    const own = [...missing];
    if (label === "camera" && input.stop.kind === "area" && !input.stop.areaRef)
      own.unshift("街区类停留点还没选参考点，这段不当作整片区域的时间");
    return {
      point: at,
      heightM: height,
      heightAssumed: assumed,
      segments:
        label === "camera" && input.stop.kind === "area" && !input.stop.areaRef
          ? segments.map((segment) => ({
              ...segment,
              state: "unknown" as const,
              cause: { note: "街区类停留点还没选参考点，先在地图上点一个位置" },
            }))
          : segments,
      litWindows: mergeWindows(segments),
      missing: [...new Set(own)],
    };
  };

  const cameraAt =
    input.stop.kind === "area" && input.stop.areaRef
      ? input.stop.areaRef
      : input.stop.kind === "area"
        ? centerOf(input.stop.geometry)
        : centerOf(input.stop.geometry);
  const cameraHeight = input.stop.cameraHeightM ?? DEFAULT_CAMERA_HEIGHT_M;
  const subjectAt = input.stop.subjectPoint ?? null;
  const subjectHeight = input.stop.subjectHeightM ?? DEFAULT_SUBJECT_HEIGHT_M;

  return {
    // 版本号只增：调用方没给就沿用计划里那一份的版本。
    version: (input.previousVersion ?? input.stop.light2?.version ?? 0) + 1,
    computedAt: now.toISOString(),
    sceneId: input.scene?.id ?? null,
    radiusM: input.scene?.radiusM ?? 1000,
    dem: input.terrain?.basis?.dem ?? "没有地形数据",
    camera: position("camera", cameraAt, cameraHeight, input.stop.cameraHeightM === undefined),
    subject: subjectAt ? position("subject", subjectAt, subjectHeight, input.stop.subjectHeightM === undefined) : null,
  };
}
