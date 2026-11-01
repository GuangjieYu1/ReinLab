/**
 * 账户级模特与器材（06 §8、07 契约第 1、3 节）。
 *
 * 独立于探索档案、按账户共享：每项有稳定 id、修订与确认来源。
 * 计划选择时存快照（当时那一版），资料改了不偷偷改旧计划；删了之后
 * 后续工具读不到正文，但旧计划里的快照保留（用户已确认该范围）。
 */
import type pg from "pg";
import { randomUUID } from "node:crypto";
import type { Profile, ProfileSnapshot } from "@reinlab/contracts";
import { ApiFailure } from "../api/errors";

type Client = pg.PoolClient;
export type ProfileType = "model" | "gear" | "place";

const isUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

function invalid(message: string) {
  return new ApiFailure("INVALID_INPUT", 400, message);
}

const text = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
};

/** 资料的正文（不含 id/revision，那些由服务端维护）。 */
export type ProfileData =
  | {
      type: "model";
      name: string;
      height?: number;
      style?: string;
      experience?: string;
      wardrobe?: string;
      notes?: string[];
    }
  | {
      type: "gear";
      name: string;
      kind: "body" | "lens";
      focal?: [number, number];
      aperture?: number;
      notes?: string;
      /** 机身传感器尺寸（毫米）；未知就不给，页面按全画幅假设并标明。 */
      sensor?: { wMm: number; hMm: number } | null;
    }
  | {
      /** 地点经验：账户级、带观察日期与依据，不当成全年规律。 */
      type: "place";
      name: string;
      at: [number, number];
      radiusM: number;
      standpoint?: string;
      observedOn: string;
      season?: string;
      timeOfDay?: string;
      text: string;
      evidence: { photoIds?: string[]; eventIds?: string[]; dossierId: string };
      confirmedBy: "user";
    };

/** 只收契约里有的字段；客户端塞别的（id、revision、accountId）一律不认。 */
export function normalizeProfile(type: ProfileType, raw: Record<string, unknown>): ProfileData {
  const name = text(raw.name, 80);
  if (!name) throw invalid(type === "model" ? "模特要有称呼。" : type === "place" ? "地点经验要有地点名。" : "器材要有名称。");
  if (type === "place") {
    const at = raw.at;
    if (
      !Array.isArray(at) ||
      at.length !== 2 ||
      !at.every((value) => typeof value === "number" && Number.isFinite(value)) ||
      Math.abs(Number(at[0])) > 180 ||
      Math.abs(Number(at[1])) > 90
    )
      throw invalid("地点经验要有坐标 [经度, 纬度]。");
    const radiusM =
      typeof raw.radiusM === "number" && Number.isFinite(raw.radiusM)
        ? Math.min(5000, Math.max(30, Math.round(raw.radiusM)))
        : 300;
    const observedOn = text(raw.observedOn, 10);
    if (!observedOn || !/^\d{4}-\d{2}-\d{2}$/.test(observedOn))
      throw invalid("地点经验要有观察日期（YYYY-MM-DD）。");
    const body = text(raw.text, 4000);
    if (!body) throw invalid("地点经验要有正文。");
    const evidenceRaw = (raw.evidence ?? {}) as Record<string, unknown>;
    const dossierId = typeof evidenceRaw.dossierId === "string" ? evidenceRaw.dossierId : "";
    if (!isUuid(dossierId)) throw invalid("地点经验要说明来自哪份档案。");
    const list = (value: unknown) =>
      Array.isArray(value) ? value.filter((item) => typeof item === "string").map(String).slice(0, 100) : undefined;
    const photoIds = list(evidenceRaw.photoIds);
    const eventIds = list(evidenceRaw.eventIds);
    return {
      type: "place",
      name,
      at: [Number(at[0]), Number(at[1])],
      radiusM,
      ...(text(raw.standpoint, 200) ? { standpoint: text(raw.standpoint, 200) } : {}),
      observedOn,
      ...(text(raw.season, 20) ? { season: text(raw.season, 20) } : {}),
      ...(text(raw.timeOfDay, 40) ? { timeOfDay: text(raw.timeOfDay, 40) } : {}),
      text: body,
      evidence: {
        ...(photoIds?.length ? { photoIds } : {}),
        ...(eventIds?.length ? { eventIds } : {}),
        dossierId,
      },
      // 只有用户确认过才会写进来；来源不是模型自己说的。
      confirmedBy: "user",
    };
  }
  if (type === "model") {
    const height = typeof raw.height === "number" && Number.isFinite(raw.height) ? raw.height : undefined;
    if (height !== undefined && (height < 50 || height > 250)) throw invalid("身高超出范围。");
    const notes = Array.isArray(raw.notes)
      ? raw.notes.filter((entry) => typeof entry === "string").map((entry) => String(entry).slice(0, 200)).slice(0, 20)
      : undefined;
    return {
      type: "model",
      name,
      ...(height !== undefined ? { height } : {}),
      ...(text(raw.style, 200) ? { style: text(raw.style, 200) } : {}),
      ...(text(raw.experience, 300) ? { experience: text(raw.experience, 300) } : {}),
      ...(text(raw.wardrobe, 500) ? { wardrobe: text(raw.wardrobe, 500) } : {}),
      ...(notes?.length ? { notes } : {}),
    };
  }
  const kind = raw.kind === "lens" ? "lens" : raw.kind === "body" ? "body" : null;
  if (!kind) throw invalid("器材要说明是机身还是镜头。");
  const focal =
    Array.isArray(raw.focal) &&
    raw.focal.length === 2 &&
    raw.focal.every((value) => typeof value === "number" && Number.isFinite(value) && value > 0)
      ? ([Number(raw.focal[0]), Number(raw.focal[1])] as [number, number])
      : undefined;
  const aperture =
    typeof raw.aperture === "number" && Number.isFinite(raw.aperture) && raw.aperture > 0 && raw.aperture <= 64
      ? raw.aperture
      : undefined;
  const sensorRaw = raw.sensor && typeof raw.sensor === "object" ? (raw.sensor as Record<string, unknown>) : null;
  const sensor =
    sensorRaw &&
    typeof sensorRaw.wMm === "number" &&
    typeof sensorRaw.hMm === "number" &&
    sensorRaw.wMm > 0 &&
    sensorRaw.hMm > 0 &&
    sensorRaw.wMm <= 100 &&
    sensorRaw.hMm <= 100
      ? { wMm: sensorRaw.wMm, hMm: sensorRaw.hMm }
      : undefined;
  if (raw.sensor !== undefined && raw.sensor !== null && !sensor)
    throw invalid("传感器尺寸要给 { wMm, hMm }（毫米）；未知就留空，别猜。");
  return {
    type: "gear",
    name,
    kind,
    ...(focal ? { focal } : {}),
    ...(aperture !== undefined ? { aperture } : {}),
    ...(text(raw.notes, 300) ? { notes: text(raw.notes, 300) } : {}),
    // 只有机身才有传感器；镜头不给。
    ...(kind === "body" && sensor ? { sensor } : {}),
    ...(kind === "body" && raw.sensor === null ? { sensor: null } : {}),
  };
}

/** 库里的一行 → 契约里的 Profile。 */
export function profileOf(row: any): Profile {
  const data = (row.data ?? {}) as Record<string, unknown>;
  const base = { id: row.id, revision: Number(row.revision), name: String(data.name ?? "未命名") };
  if (row.type === "place")
    return {
      ...base,
      type: "place",
      at: Array.isArray(data.at) ? (data.at as [number, number]) : [0, 0],
      radiusM: typeof data.radiusM === "number" ? data.radiusM : 300,
      ...(typeof data.standpoint === "string" ? { standpoint: data.standpoint } : {}),
      observedOn: String(data.observedOn ?? ""),
      ...(typeof data.season === "string" ? { season: data.season } : {}),
      ...(typeof data.timeOfDay === "string" ? { timeOfDay: data.timeOfDay } : {}),
      text: String(data.text ?? ""),
      evidence: (data.evidence as Record<string, unknown>) ?? { dossierId: "" },
      confirmedBy: "user",
    } as Profile;
  if (row.type === "model")
    return {
      ...base,
      type: "model",
      ...(typeof data.height === "number" ? { height: data.height } : {}),
      ...(typeof data.style === "string" ? { style: data.style } : {}),
      ...(typeof data.experience === "string" ? { experience: data.experience } : {}),
      ...(typeof data.wardrobe === "string" ? { wardrobe: data.wardrobe } : {}),
      ...(Array.isArray(data.notes) ? { notes: data.notes as string[] } : {}),
    } as Profile;
  return {
    ...base,
    type: "gear",
    kind: data.kind === "lens" ? "lens" : "body",
    ...(Array.isArray(data.focal) ? { focal: data.focal as [number, number] } : {}),
    ...(typeof data.aperture === "number" ? { aperture: data.aperture } : {}),
    ...(typeof data.notes === "string" ? { notes: data.notes } : {}),
    ...(data.sensor && typeof data.sensor === "object" ? { sensor: data.sensor as { wMm: number; hMm: number } } : {}),
    ...(data.sensor === null ? { sensor: null } : {}),
  } as Profile;
}

export async function listProfiles(client: Client, account: string, type?: string): Promise<Profile[]> {
  const wanted = type === "model" || type === "gear" || type === "place" ? type : null;
  const rows = (
    await client.query(
      `select id,type,revision,data from account_profile
        where account_id=$1 and deleted_at is null and ($2::text is null or type=$2)
        order by created_at desc limit 200`,
      [account, wanted],
    )
  ).rows;
  return rows.map(profileOf);
}

export async function createProfile(client: Client, account: string, raw: Record<string, unknown>): Promise<Profile> {
  const type: ProfileType =
    raw.type === "gear" ? "gear" : raw.type === "model" ? "model" : raw.type === "place" ? "place" : (null as never);
  if (!type) throw invalid("资料要么是模特、器材，要么是地点经验。");
  const data = normalizeProfile(type, raw);
  const { name: _name, type: _type, ...rest } = data as any;
  const created = (
    await client.query(
      `insert into account_profile(id,account_id,type,revision,data) values($1,$2,$3,1,$4::jsonb)
       returning id,type,revision,data`,
      [randomUUID(), account, type, JSON.stringify({ name: data.name, ...rest })],
    )
  ).rows[0];
  return profileOf(created);
}

export async function updateProfile(
  client: Client,
  account: string,
  id: string,
  raw: Record<string, unknown>,
): Promise<Profile> {
  if (!isUuid(id)) throw new ApiFailure("PROFILE_NOT_FOUND", 404, "找不到这条资料。");
  const row = (
    await client.query(
      "select id,type,revision,data from account_profile where account_id=$1 and id=$2 and deleted_at is null",
      [account, id],
    )
  ).rows[0];
  if (!row) throw new ApiFailure("PROFILE_NOT_FOUND", 404, "找不到这条资料。");
  const baseRevision = Number(raw.baseRevision);
  if (!Number.isSafeInteger(baseRevision) || baseRevision !== Number(row.revision))
    throw new ApiFailure("VERSION_CONFLICT", 409, "这条资料刚被改过，请用最新版本再改。", {
      latest: profileOf(row),
    });
  const merged = normalizeProfile(row.type, { ...(row.data ?? {}), ...raw, type: row.type });
  const { name: _name, type: _type, ...rest } = merged as any;
  const updated = (
    await client.query(
      `update account_profile set data=$3::jsonb, revision=revision+1, updated_at=now()
        where account_id=$1 and id=$2 returning id,type,revision,data`,
      [account, id, JSON.stringify({ name: merged.name, ...rest })],
    )
  ).rows[0];
  return profileOf(updated);
}

/** 删除是逻辑删除：旧计划快照保留，后续工具读不到正文。 */
export async function deleteProfile(client: Client, account: string, id: string): Promise<void> {
  if (!isUuid(id)) throw new ApiFailure("PROFILE_NOT_FOUND", 404, "找不到这条资料。");
  const removed = await client.query(
    "update account_profile set deleted_at=now(), updated_at=now(), revision=revision+1 where account_id=$1 and id=$2 and deleted_at is null",
    [account, id],
  );
  if (!removed.rowCount) throw new ApiFailure("PROFILE_NOT_FOUND", 404, "找不到这条资料。");
}

/**
 * 计划选择资料时取快照。
 * refresh=true 采用最新修订；否则计划里已经有这条的快照就沿用当时那一版。
 */
export async function profileSnapshots(
  client: Client,
  account: string,
  ids: string[],
  type: ProfileType,
  options: { refresh?: boolean; existing?: ProfileSnapshot[] } = {},
): Promise<ProfileSnapshot[]> {
  const wanted = [...new Set(ids)].filter((id) => typeof id === "string" && id !== "");
  if (!wanted.length) return [];
  // 显式选择的资料必须还在：删掉的不能再选（旧计划里的快照仍然保留）。
  const aliveRows = (
    await client.query(
      `select id,type,revision,data from account_profile
        where account_id=$1 and deleted_at is null and type=$2 and id = any($3::uuid[])`,
      [account, type, wanted],
    )
  ).rows;
  const alive = new Map(aliveRows.map((row) => [row.id, row]));
  const unreadable = wanted.filter((id) => !alive.has(id));
  if (unreadable.length)
    throw new ApiFailure("PROFILE_NOT_FOUND", 404, "计划里有资料已经删掉了，先重新选一次。", {
      missing: unreadable,
    });
  // 已经选过的沿用当时那一版快照；refresh=true 才采用最新修订。
  const previous = new Map(
    (options.existing ?? []).map((snapshot) => [snapshot.profileId, snapshot]),
  );
  const kept = new Map<string, ProfileSnapshot>();
  for (const id of wanted) {
    const old = previous.get(id);
    if (old && !options.refresh) kept.set(id, old);
    else {
      const row = alive.get(id)!;
      kept.set(id, { profileId: row.id, revision: Number(row.revision), data: profileOf(row) });
    }
  }
  // 保持用户选择的顺序。
  return wanted.map((id) => kept.get(id)!);
}
