/**
 * 对时与实际时间线（design/prd/09-explore-v2.md §5.3–5.4、10-explore-v2-contract.md §2.4）。
 *
 * 每组照片共用一个常量偏差：校正后时间 = 经确认时区解释的相机时间 + 偏差。
 * 有锚点就按中位数估计并检查残差；没有锚点、时区不明或锚点对不上，就把问题交给用户选，
 * 不靠「时间分布最像」自动认定。手动归属的照片永远不被重算覆盖。
 */
import type pg from "pg";
import type { CameraGroup, FieldEventRecord, LngLat, Photo } from "@reinlab/contracts";
import { ApiFailure } from "../api/errors";
import type { PlanDocument } from "./plan";
import { listFieldEvents } from "./field";
import {
  placementOf,
  refreshGroupStatus,
  timeOf,
  type CameraGroupRow,
  type ParsedExif,
  type PhotoRow,
  wallOfRaw,
  instantOfWall,
} from "./photos";

type Client = pg.PoolClient;

/** 残差超过这个就算「前后对不上」，让用户拆组。 */
export const ANCHOR_TOLERANCE_SEC = 120;

const GROUP_COLUMNS =
  "id,label,fingerprint,timezone,timezone_basis,offset_sec,residual_sec,status";

type AnchorRow = { photo_id: string; event_client_id: string | null; at: Date | null; delta_sec: number };

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};

async function groupRow(client: Client, account: string, dossier: string, groupId: string): Promise<CameraGroupRow> {
  const row = (
    await client.query(
      `select ${GROUP_COLUMNS} from explore_camera_group where account_id=$1 and dossier_id=$2 and id=$3`,
      [account, dossier, groupId],
    )
  ).rows[0] as CameraGroupRow | undefined;
  if (!row) throw new ApiFailure("CLOCK_GROUP_NOT_FOUND", 404, "找不到这个相机组。");
  return row;
}

async function anchorsOf(client: Client, account: string, dossier: string, groupId: string): Promise<AnchorRow[]> {
  return (
    await client.query(
      `select photo_id,event_client_id,at,delta_sec from explore_clock_anchor
        where account_id=$1 and dossier_id=$2 and group_id=$3 order by created_at`,
      [account, dossier, groupId],
    )
  ).rows as AnchorRow[];
}

/**
 * 把组设置应用到这一组照片：重算时间与落位（手动归属不动）。
 * 拿不到时区就保持 pending——不猜。
 */
async function applyGroup(
  client: Client,
  input: { account: string; dossier: string; group: CameraGroupRow; document: PlanDocument },
): Promise<void> {
  const events = await listFieldEvents(client, {
    account: input.account,
    dossier: input.dossier,
    document: input.document,
  });
  const photos = (
    await client.query(
      `select id,exif from explore_photo
        where account_id=$1 and dossier_id=$2 and camera_group_id=$3 and deleted_at is null`,
      [input.account, input.dossier, input.group.id],
    )
  ).rows as { id: string; exif: ParsedExif }[];
  for (const photo of photos) {
    const time = timeOf(photo.exif ?? {}, input.group);
    const placement = placementOf({
      document: input.document,
      events,
      gps: (photo.exif as ParsedExif)?.gps ?? null,
      correctedAt: time.correctedAt,
      timed: time.timed,
    });
    await client.query(
      `update explore_photo set taken_ts=$3, corrected_ts=$4, time_basis=$5, time_trust=$6,
              placement_stop_id=case when placement_manual then placement_stop_id else $7 end,
              placement_basis=case when placement_manual then placement_basis else $8 end,
              placement_lng=case when placement_manual then placement_lng else $9 end,
              placement_lat=case when placement_manual then placement_lat else $10 end,
              updated_at=now()
        where account_id=$1 and id=$2`,
      [
        input.account,
        photo.id,
        time.takenAt,
        time.correctedAt,
        time.basis,
        time.trust,
        placement.stopId,
        placement.basis,
        placement.at?.[0] ?? null,
        placement.at?.[1] ?? null,
      ],
    );
  }
}

/** 组的状态与偏差：有锚点取中位数并算残差，没锚点就看有没有时区依据。 */
async function recomputeGroup(
  client: Client,
  input: { account: string; dossier: string; group: CameraGroupRow; document: PlanDocument },
): Promise<CameraGroupRow> {
  const anchors = await anchorsOf(client, input.account, input.dossier, input.group.id);
  let offset = input.group.offset_sec;
  let residual: number | null = input.group.residual_sec;
  let status = input.group.status;
  if (anchors.length) {
    const estimate = median(anchors.map((anchor) => Number(anchor.delta_sec)));
    offset = estimate;
    residual = anchors.reduce(
      (worst, anchor) => Math.max(worst, Math.abs(Number(anchor.delta_sec) - estimate)),
      0,
    );
    status = residual > ANCHOR_TOLERANCE_SEC ? "inconsistent" : "auto";
  }
  const updated = (
    await client.query(
      `update explore_camera_group set offset_sec=$3, residual_sec=$4, status=$5, updated_at=now()
        where account_id=$1 and id=$2 returning ${GROUP_COLUMNS}`,
      [input.account, input.group.id, offset, residual, status],
    )
  ).rows[0] as CameraGroupRow;
  await applyGroup(client, { ...input, group: updated });
  await refreshGroupStatus(client, input.account, input.dossier, updated.id);
  const final = await groupRow(client, input.account, input.dossier, updated.id);
  await applyGroup(client, { ...input, group: final });
  return final;
}

/** 每个相机组一行：张数、时区依据、偏差与残差、锚点、建议锚点。 */
export async function cameraGroups(
  client: Client,
  input: { account: string; dossier: string; document: PlanDocument },
): Promise<CameraGroup[]> {
  const rows = (
    await client.query(
      `select g.id,g.label,g.fingerprint,g.timezone,g.timezone_basis,g.offset_sec,g.residual_sec,g.status,
              (select count(*)::int from explore_photo p
                where p.account_id=g.account_id and p.dossier_id=g.dossier_id
                  and p.camera_group_id=g.id and p.deleted_at is null) photos
         from explore_camera_group g
        where g.account_id=$1 and g.dossier_id=$2
        order by g.created_at`,
      [input.account, input.dossier],
    )
  ).rows;
  const events = await listFieldEvents(client, { ...input });
  const anchorable = events.filter(
    (event) => event.status === "ok" && (event.kind === "arrived" || event.kind === "shot"),
  );
  const groups: CameraGroup[] = [];
  for (const row of rows) {
    const anchors = await anchorsOf(client, input.account, input.dossier, row.id);
    const suggestion = await suggestAnchor(client, {
      account: input.account,
      dossier: input.dossier,
      groupId: row.id,
      timezone: row.timezone ?? input.document.destination?.timezone ?? null,
      events: anchorable,
    });
    groups.push({
      id: row.id,
      label: row.label,
      photos: Number(row.photos),
      timezone: row.timezone,
      timezoneBasis: (row.timezone_basis as CameraGroup["timezoneBasis"]) ?? null,
      offsetSec: row.offset_sec === null ? null : Number(row.offset_sec),
      residualSec: row.residual_sec === null ? null : Number(row.residual_sec),
      status: row.status as CameraGroup["status"],
      anchors: anchors.map((anchor) => ({
        photoId: anchor.photo_id,
        ...(anchor.event_client_id ? { eventClientId: anchor.event_client_id } : {}),
        ...(anchor.at ? { time: new Date(anchor.at).toISOString() } : {}),
        deltaSec: Number(anchor.delta_sec),
      })),
      ...(suggestion ? { suggestion } : {}),
    });
  }
  return groups;
}

/**
 * 建议锚点：找一张照片和一次打卡，两者在（按计划所在地时区估算的）时间上最接近。
 * 这只是「推荐让用户确认」，不是自动认定。
 */
async function suggestAnchor(
  client: Client,
  input: {
    account: string;
    dossier: string;
    groupId: string;
    timezone: string | null;
    events: FieldEventRecord[];
  },
): Promise<CameraGroup["suggestion"] | undefined> {
  if (!input.timezone || !input.events.length) return undefined;
  const photos = (
    await client.query(
      `select id,exif from explore_photo
        where account_id=$1 and dossier_id=$2 and camera_group_id=$3 and deleted_at is null
        order by created_at limit 40`,
      [input.account, input.dossier, input.groupId],
    )
  ).rows as { id: string; exif: ParsedExif }[];
  let best: { photoId: string; eventClientId: string; gap: number; label: string } | null = null;
  for (const photo of photos) {
    const wall = wallOfRaw(photo.exif?.dateTimeOriginal ?? null);
    if (!wall) continue;
    const guess = instantOfWall(wall.day, wall.clock, input.timezone);
    if (!guess) continue;
    for (const event of input.events) {
      const when = Date.parse(event.at);
      if (Number.isNaN(when)) continue;
      const gap = Math.abs(when - guess.getTime());
      if (gap > 45 * 60_000) continue;
      if (!best || gap < best.gap)
        best = {
          photoId: photo.id,
          eventClientId: event.clientId,
          gap,
          label: `${event.kind === "arrived" ? "到了" : "拍到了"} · ${event.stopName ?? "行程外"}`,
        };
    }
  }
  if (!best) return undefined;
  const minutes = Math.round(best.gap / 60000);
  return {
    photoId: best.photoId,
    eventClientId: best.eventClientId,
    // 明确说这是「按计划所在地时区估算」的建议，不是已确认的对应。
    note: `按计划所在地时区估算，相机记录的这一刻离「${best.label}」大约 ${minutes} 分钟；如果你确定这张就是那次打卡，确认后按它校正整组。`,
  };
}

/** 加锚点：这张照片 = 这个打卡 / 这个时刻。之后整组按中位数校正。 */
export async function addAnchor(
  client: Client,
  input: {
    account: string;
    dossier: string;
    groupId: string;
    photoId: string;
    eventClientId?: string;
    time?: string;
    document: PlanDocument;
  },
): Promise<CameraGroup> {
  const group = await groupRow(client, input.account, input.dossier, input.groupId);
  const photo = (
    await client.query(
      "select id,camera_group_id,exif from explore_photo where account_id=$1 and dossier_id=$2 and id=$3 and deleted_at is null",
      [input.account, input.dossier, input.photoId],
    )
  ).rows[0] as { id: string; camera_group_id: string | null; exif: ParsedExif } | undefined;
  if (!photo) throw new ApiFailure("PHOTO_NOT_FOUND", 404, "找不到这张照片。");
  if (photo.camera_group_id !== group.id)
    throw new ApiFailure("CLOCK_GROUP_MISMATCH", 400, "这张照片不在这个相机组里。");

  let target: Date | null = input.time ? new Date(input.time) : null;
  if (input.eventClientId) {
    const events = await listFieldEvents(client, { ...input });
    const event = events.find((row) => row.clientId === input.eventClientId);
    if (!event) throw new ApiFailure("FIELD_EVENT_MISSING", 404, "找不到这次现场记录。");
    target = new Date(event.at);
  }
  if (!target || Number.isNaN(target.getTime()))
    throw new ApiFailure("INVALID_INPUT", 400, "锚点要给一次打卡，或一个已知时刻。");

  const timezone = group.timezone ?? input.document.destination?.timezone ?? null;
  if (!timezone)
    throw new ApiFailure(
      "CLOCK_TIMEZONE_REQUIRED",
      409,
      "先确定这组照片的时区（计划所在地），才能算出相机钟差了多少。",
    );
  const wall = wallOfRaw(photo.exif?.dateTimeOriginal ?? null);
  if (!wall) throw new ApiFailure("CLOCK_NO_TIME", 409, "这张照片没有拍摄时间，换个有时间的当锚点。");
  const taken = instantOfWall(wall.day, wall.clock, timezone);
  if (!taken) throw new ApiFailure("CLOCK_NO_TIME", 409, "这张照片的拍摄时间读不出来，换个当锚点。");

  const deltaSec = Math.round((target.getTime() - taken.getTime()) / 1000);
  await client.query(
    `insert into explore_clock_anchor(account_id,dossier_id,group_id,photo_id,event_client_id,at,delta_sec)
     values($1,$2,$3,$4,$5,$6,$7)
     on conflict (account_id,dossier_id,group_id,photo_id) do update set
       event_client_id=excluded.event_client_id, at=excluded.at, delta_sec=excluded.delta_sec`,
    [
      input.account,
      input.dossier,
      group.id,
      photo.id,
      input.eventClientId ?? null,
      target,
      deltaSec,
    ],
  );
  // 组里还没有时区时，用计划所在地记下来（basis 标 plan，页面能看到依据）。
  const current = group.timezone
    ? group
    : ((await client.query(
        `update explore_camera_group set timezone=$3, timezone_basis=coalesce(timezone_basis,'plan'), updated_at=now()
          where account_id=$1 and id=$2 returning ${GROUP_COLUMNS}`,
        [input.account, group.id, timezone],
      )).rows[0] as CameraGroupRow);
  const recomputed = await recomputeGroup(client, {
    account: input.account,
    dossier: input.dossier,
    group: current,
    document: input.document,
  });
  return (await cameraGroups(client, input)).find((row) => row.id === recomputed.id) as CameraGroup;
}

/** 用户确认时区与偏差：之后整组按这个解释，照片时间和落位重算（手动归属不动）。 */
export async function confirmGroup(
  client: Client,
  input: { account: string; dossier: string; groupId: string; timezone: string; offsetSec: number; document: PlanDocument },
): Promise<CameraGroup> {
  const group = await groupRow(client, input.account, input.dossier, input.groupId);
  const updated = (
    await client.query(
      `update explore_camera_group set timezone=$3, timezone_basis='user', offset_sec=$4,
              status='confirmed', updated_at=now()
        where account_id=$1 and id=$2 returning ${GROUP_COLUMNS}`,
      [input.account, group.id, input.timezone, input.offsetSec],
    )
  ).rows[0] as CameraGroupRow;
  await applyGroup(client, { account: input.account, dossier: input.dossier, group: updated, document: input.document });
  return (await cameraGroups(client, input)).find((row) => row.id === group.id) as CameraGroup;
}

/** 拆组：时钟变过的话，前后两段的偏差不一样，拆开各自对。 */
export async function splitGroup(
  client: Client,
  input: { account: string; dossier: string; groupId: string; beforePhotoId: string; document: PlanDocument },
): Promise<CameraGroup[]> {
  const group = await groupRow(client, input.account, input.dossier, input.groupId);
  const before = (
    await client.query(
      "select id,created_at from explore_photo where account_id=$1 and dossier_id=$2 and id=$3 and deleted_at is null",
      [input.account, input.dossier, input.beforePhotoId],
    )
  ).rows[0] as { id: string; created_at: Date } | undefined;
  if (!before) throw new ApiFailure("PHOTO_NOT_FOUND", 404, "找不到要拆开的这张照片。");
  const moved = await client.query(
    `select id from explore_photo
      where account_id=$1 and dossier_id=$2 and camera_group_id=$3 and deleted_at is null
        and created_at < $4::timestamptz`,
    [input.account, input.dossier, group.id, before.created_at],
  );
  if (!moved.rowCount) throw new ApiFailure("CLOCK_SPLIT_EMPTY", 409, "没有比它更早的照片可拆。");
  // 新组：同一台机身、同一套设置，只把名字标出「第 N 段」；指纹加后缀避免又并回去。
  const suffix = String((await client.query(
    "select count(*)::int n from explore_camera_group where account_id=$1 and dossier_id=$2 and fingerprint like $3",
    [input.account, input.dossier, `${group.fingerprint}#%`],
  )).rows[0].n + 2);
  const created = (
    await client.query(
      `insert into explore_camera_group(account_id,dossier_id,label,fingerprint,timezone,timezone_basis,offset_sec,residual_sec,status)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning ${GROUP_COLUMNS}`,
      [
        input.account,
        input.dossier,
        `${group.label}（第 ${suffix} 段）`,
        `${group.fingerprint}#${suffix}`,
        group.timezone,
        group.timezone_basis,
        group.offset_sec,
        group.residual_sec,
        group.status,
      ],
    )
  ).rows[0] as CameraGroupRow;
  await client.query(
    `update explore_photo set camera_group_id=$3, updated_at=now()
      where account_id=$1 and dossier_id=$2 and id = any($4::uuid[])`,
    [input.account, input.dossier, created.id, moved.rows.map((row) => row.id)],
  );
  await refreshGroupStatus(client, input.account, input.dossier, group.id);
  return cameraGroups(client, input);
}

// ── 实际时间线 ───────────────────────────────────────────

export type ActualItem =
  | { type: "event"; record: FieldEventRecord }
  | {
      type: "cluster";
      stopId: string | null;
      start: string;
      end: string;
      photoIds: string[];
      basis: Photo["placement"]["basis"];
    };

const CLUSTER_GAP_MS = 45 * 60_000;

/**
 * 实际时间线：现场记录 + 照片簇。照片簇只按已校正的时间拼，
 * 没有时间的照片不进来（不拿接收时间冒充拍摄时间）。
 */
export async function actualTimeline(
  client: Client,
  input: { account: string; dossier: string; document: { stops: PlanDocument["stops"] } },
): Promise<ActualItem[]> {
  const events = await listFieldEvents(client, { ...input });
  const photos = (
    await client.query(
      `select id,corrected_ts,placement_stop_id,placement_basis,placement_manual
         from explore_photo
        where account_id=$1 and dossier_id=$2 and deleted_at is null
          and corrected_ts is not null and status='ready'
        order by corrected_ts asc limit 2000`,
      [input.account, input.dossier],
    )
  ).rows as {
    id: string;
    corrected_ts: Date;
    placement_stop_id: string | null;
    placement_basis: string;
    placement_manual: boolean;
  }[];

  const clusters: ActualItem[] = [];
  let current: { stopId: string | null; ids: string[]; start: number; end: number; basis: Map<string, number> } | null = null;
  const flush = () => {
    if (!current || !current.ids.length) return;
    const basis = [...current.basis.entries()].sort((a, b) => b[1] - a[1])[0][0];
    clusters.push({
      type: "cluster",
      stopId: current.stopId,
      start: new Date(current.start).toISOString(),
      end: new Date(current.end).toISOString(),
      photoIds: current.ids,
      basis: basis as Photo["placement"]["basis"],
    });
    current = null;
  };
  for (const photo of photos) {
    const at = new Date(photo.corrected_ts).getTime();
    const sameStop = current && current.stopId === photo.placement_stop_id;
    if (!current || !sameStop || at - current.end > CLUSTER_GAP_MS) {
      flush();
      current = { stopId: photo.placement_stop_id, ids: [photo.id], start: at, end: at, basis: new Map([[photo.placement_basis, 1]]) };
      continue;
    }
    current.ids.push(photo.id);
    current.end = at;
    current.basis.set(photo.placement_basis, (current.basis.get(photo.placement_basis) ?? 0) + 1);
  }
  flush();
  return [...events.map((record) => ({ type: "event" as const, record })), ...clusters];
}

/** 照片坐标（GPS 或落位点中心）——回顾对照用。 */
export function photoPoint(row: PhotoRow, document: PlanDocument): LngLat | null {
  if (row.placement_lng !== null && row.placement_lat !== null) return [row.placement_lng, row.placement_lat];
  const stop = row.placement_stop_id ? document.stops.find((item) => item.id === row.placement_stop_id) : null;
  if (!stop) return null;
  return stop.geometry.type === "Point" ? (stop.geometry.coordinates as LngLat) : null;
}
