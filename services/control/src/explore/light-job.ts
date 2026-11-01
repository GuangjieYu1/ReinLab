/**
 * 场景 + 双位置受光的后台计算（09 §7.2–7.3）。
 *
 * 取数（Overpass）和射线求交都不该压在计划写入的事务里：ops 提交后排队，
 * 算完把 light2 写回计划并推 explore.light / explore.scene。旧值照旧可用，
 * 算不出来就保留未知，不编一个「有光」。
 */
import type { BuildingScene, Stop, StopLight, StopLight2 } from "@reinlab/contracts";
import type { Database } from "../db/database";
import { ApiFailure } from "../api/errors";
import { loadPlan } from "./service";
import { sceneFor, SCENE_RADIUS_M, type OverpassTransport, type SceneStore } from "./scene";
import { computeLight2 } from "./light2";
import { computeStopLight, type ElevationTransport } from "./terrain";

export type LightJobOptions = {
  db: Database;
  sceneStore?: SceneStore;
  overpass?: OverpassTransport;
  elevation?: ElevationTransport;
  /** 算完推事件（页面按 stopId/version 重取）。 */
  publish?: (account: string, event: Record<string, unknown>) => void;
  now?: () => Date;
};

let configured: LightJobOptions | null = null;

/** 由宿主（main.ts / 测试）注入依赖；没配置就什么也不排。 */
export function configureLightJobs(options: LightJobOptions | null) {
  configured = options;
}

/** 某个停留点的机位位置（街区看 areaRef，没有就用区域中心）。 */
export function cameraPointOf(stop: Stop): [number, number] {
  if (stop.geometry.type === "Point") return stop.geometry.coordinates as [number, number];
  if (stop.areaRef) return stop.areaRef;
  const ring = (stop.geometry.coordinates[0] ?? []) as [number, number][];
  if (!ring.length) return [0, 0];
  const sum = ring.reduce<[number, number]>((acc, point) => [acc[0] + point[0], acc[1] + point[1]], [0, 0]);
  return [sum[0] / ring.length, sum[1] / ring.length];
}

/**
 * 纯计算部分：地形（缺就补）+ 建筑场景 + light2。
 * 给「必须在同一个事务里写回」的调用方（内核工具）用；不碰数据库。
 */
export async function computeStopLight2For(
  options: LightJobOptions,
  input: { stop: Stop; timezone: string; refreshScene?: boolean },
): Promise<{ light2: StopLight2; scene: BuildingScene | null; terrain: StopLight | null }> {
  let terrain: StopLight | null = input.stop.light ?? null;
  if (!terrain?.horizon) {
    const computed = await computeStopLight({
      at: cameraPointOf(input.stop),
      timezone: input.timezone,
      day: input.stop.day,
      ...(options.elevation ? { transport: options.elevation } : {}),
    }).catch(() => null);
    if (computed?.light.horizon) terrain = computed.light;
  }
  let scene: BuildingScene | null = null;
  try {
    const loaded = await loadScene(options, {
      at: cameraPointOf(input.stop),
      ...(input.refreshScene ? { refresh: true } : {}),
    });
    scene = loaded.scene;
  } catch {
    scene = null;
  }
  const light2 = computeLight2({
    scene,
    stop: input.stop,
    day: input.stop.day,
    timezone: input.timezone,
    terrain,
    previousVersion: input.stop.light2?.version ?? 0,
    ...(options.now ? { now: options.now() } : {}),
  });
  return { light2, scene, terrain };
}

export type RefreshOutcome = {
  status: "ok" | "failed";
  light2?: StopLight2;
  scene?: BuildingScene;
  reason?: string;
};

/**
 * 取一个停留点的建筑场景（有缓存就用缓存）。
 * 失败时把 coverage=… 照实带回去，不抛给页面。
 */
export async function loadScene(options: LightJobOptions, input: { at: [number, number]; refresh?: boolean }) {
  return sceneFor({
    origin: input.at,
    radiusM: SCENE_RADIUS_M,
    ...(options.sceneStore ? { store: options.sceneStore } : {}),
    ...(options.overpass ? { transport: options.overpass } : {}),
    ...(options.now ? { now: options.now() } : {}),
    ...(input.refresh ? { refresh: true } : {}),
  });
}

/**
 * 算一个停留点的 light2 并写回计划（不改 revision：light2 是服务端派生字段）。
 * 地形见光缺就现场补一次（和第一版同一个高程源）。
 */
export async function refreshStopLight2(
  options: LightJobOptions,
  input: { account: string; dossier: string; stopId: string; refreshScene?: boolean },
): Promise<RefreshOutcome> {
  const { db } = options;
  const snapshot = await db.withAccount(input.account, async (client) => {
    const { plan } = await loadPlan(client, input.account, input.dossier);
    const stop = plan.document.stops.find((row) => row.id === input.stopId);
    if (!stop) throw new ApiFailure("STOP_NOT_FOUND", 404, "计划里没有这个停留点。");
    return { stop, timezone: plan.document.destination?.timezone ?? null, version: stop.light2?.version ?? 0 };
  });
  if (!snapshot.timezone) return { status: "failed", reason: "先确定拍摄地点时区，受光按时区里的时间算。" };
  const { stop, timezone } = snapshot;

  const { light2, scene, terrain } = await computeStopLight2For(options, {
    stop,
    timezone,
    ...(input.refreshScene ? { refresh: true } : {}),
  });

  const stored = await db.withAccount(input.account, async (client) => {
    const { plan } = await loadPlan(client, input.account, input.dossier, { lock: true });
    const target = plan.document.stops.find((row) => row.id === input.stopId);
    if (!target) return null;
    // 位置 / 日期 / 高度在这一轮算完之后又被改过：这次结果作废，留给下一次重算。
    const same =
      JSON.stringify([target.geometry, target.day, target.subjectPoint, target.areaRef, target.cameraHeightM, target.subjectHeightM]) ===
      JSON.stringify([stop.geometry, stop.day, stop.subjectPoint, stop.areaRef, stop.cameraHeightM, stop.subjectHeightM]);
    if (!same) return null;
    target.light2 = { ...light2, version: (target.light2?.version ?? 0) + 1 };
    if (terrain?.horizon) target.light = terrain;
    await client.query(
      "update explore_plan set document=$3::jsonb, updated_at=now() where account_id=$1 and dossier_id=$2",
      [input.account, input.dossier, JSON.stringify(plan.document)],
    );
    return target.light2;
  });

  if (!stored) return { status: "failed", reason: "这一版计划在重算期间又改过，结果作废。" };
  options.publish?.(input.account, {
    type: "explore.light",
    dossierId: input.dossier,
    stopId: input.stopId,
    version: stored.version,
  });
  if (scene)
    options.publish?.(input.account, {
      type: "explore.scene",
      dossierId: input.dossier,
      stopId: input.stopId,
      sceneId: scene.id,
      status: scene.coverage.status,
    });
  return { status: "ok", light2: stored, ...(scene ? { scene } : {}) };
}

/** 排队重算（ops 提交后 / 手动触发）：不阻塞调用方，失败只留日志。 */
export function queueLightRefresh(account: string, dossier: string, stopIds: string[]) {
  const options = configured;
  if (!options || !stopIds.length) return;
  void (async () => {
    let first = true;
    for (const stopId of [...new Set(stopIds)].slice(0, 8)) {
      // 对公共 Overpass 客气一点：连续几个点之间隔一下，别一口气打完。
      if (!first) await new Promise((resolve) => setTimeout(resolve, 1_200));
      first = false;
      await refreshStopLight2(options, { account, dossier, stopId }).catch((error) => {
        console.error(
          JSON.stringify({
            code: "EXPLORE_LIGHT_FAILED",
            stop: stopId,
            message: String((error as Error)?.message ?? error).slice(0, 160),
          }),
        );
      });
    }
  })();
}
