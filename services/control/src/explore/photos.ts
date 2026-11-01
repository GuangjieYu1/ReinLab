/**
 * 照片：批次、上传登记、EXIF、派生图、相机分组、对时与落位
 * （design/prd/09-explore-v2.md §5、10-explore-v2-contract.md §2.3–2.4）。
 *
 * 几条硬规矩：
 * - 原图只收 JPG、原样保存（一个字节都不改），派生图另存；
 * - 同档案同内容只留一张（sha256），同名不同内容照常并存；
 * - 时间不猜：没有时区依据就标 pending，别把相机钟放到服务器时区上；
 * - 手动归属永不被重算覆盖；AI 挑片标记和用户精选是两列，互不覆盖。
 */
import type pg from "pg";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import type { FieldEventRecord, LngLat, Photo, UploadBatch } from "@reinlab/contracts";
import { ApiFailure } from "../api/errors";
import exifr from "exifr";
import sharp from "sharp";
import type { PhotoStore } from "./photo-store";
import { offsetMinutesAt } from "./sun";
import type { PlanDocument, StoredPlan } from "./plan";
import { listFieldEvents } from "./field";

type Client = pg.PoolClient;

export const PHOTO_MAX_BYTES = 64 * 1024 * 1024;
/** 单张原图之外还要留的余量：派生图和数据库都要地方。 */
const SPACE_MARGIN = 256 * 1024 * 1024;
const THUMB_EDGE = 400;
const PREVIEW_EDGE = 1600;

export type PhotoDeps = {
  store: PhotoStore;
  /** 档案所在磁盘剩余字节；缺省按未知处理（space.ok 照实给 false 并说明）。 */
  freeBytes?: () => Promise<number>;
  now?: () => Date;
};

// ── 批次 ─────────────────────────────────────────────────

type BatchRow = {
  id: string;
  created_at: Date;
  files: number;
  bytes: string | number;
  unsupported: { fileName: string; reason: string }[];
  uploaded: number;
  processed: number;
  failed: number;
};

const batchOf = (row: BatchRow): UploadBatch => ({
  id: row.id,
  createdAt: new Date(row.created_at).toISOString(),
  files: Number(row.files),
  bytes: Number(row.bytes),
  uploaded: Number(row.uploaded),
  processed: Number(row.processed),
  failed: Number(row.failed),
  unsupported: Array.isArray(row.unsupported) ? row.unsupported : [],
});

const BATCH_COLUMNS =
  "id,created_at,files,bytes,unsupported,uploaded,processed,failed";

const isJpegName = (name: string) => /\.jpe?g$/i.test(name);

export async function createBatch(
  client: Client,
  account: string,
  dossier: string,
  input: { files: { name: string; bytes: number; lastModified: number }[] },
  deps: PhotoDeps,
): Promise<{ batch: UploadBatch; uploadUrl: string; space: { freeBytes: number; needBytes: number; ok: boolean } }> {
  const unsupported: { fileName: string; reason: string }[] = [];
  const supported = input.files.filter((file) => {
    if (isJpegName(file.name)) return true;
    unsupported.push({
      fileName: file.name,
      reason: /\.(cr2|cr3|nef|arw|raf|dng|orf|rw2)$/i.test(file.name)
        ? "RAW 本轮不收（只收 JPG 原图）"
        : /\.(heic|heif)$/i.test(file.name)
          ? "HEIC 本轮不收（只收 JPG 原图）"
          : /\.(mp4|mov|avi|mkv)$/i.test(file.name)
            ? "视频本轮不收"
            : "不是 JPG（本轮只收 JPG 原图）",
    });
    return false;
  });
  const needBytes = supported.reduce((total, file) => total + Math.max(0, Number(file.bytes) || 0), 0);
  const freeBytes = deps.freeBytes ? await deps.freeBytes() : 0;
  const row = (
    await client.query(
      `insert into explore_photo_batch(account_id,dossier_id,files,bytes,unsupported)
       values($1,$2,$3,$4,$5::jsonb) returning ${BATCH_COLUMNS}`,
      [account, dossier, supported.length, needBytes, JSON.stringify(unsupported.slice(0, 500))],
    )
  ).rows[0] as BatchRow;
  return {
    batch: batchOf(row),
    uploadUrl: `/v1/explore/uploads`,
    space: {
      freeBytes,
      needBytes,
      ok: freeBytes > 0 && freeBytes - needBytes > SPACE_MARGIN,
    },
  };
}

export async function readBatch(client: Client, account: string, dossier: string, batchId: string): Promise<UploadBatch> {
  const row = (
    await client.query(
      `select ${BATCH_COLUMNS} from explore_photo_batch
        where account_id=$1 and id=$2 and dossier_id=$3`,
      [account, batchId, dossier],
    )
  ).rows[0] as BatchRow | undefined;
  if (!row) throw new ApiFailure("PHOTO_BATCH_NOT_FOUND", 404, "找不到这个上传批次。");
  return batchOf(row);
}

// ── 上传登记（tus 钩子用） ────────────────────────────────

export type UploadRow = {
  id: string;
  account_id: string;
  dossier_id: string;
  batch_id: string;
  file_name: string;
  bytes: string | number;
  length: string | number;
  received_bytes: string | number;
  state: "open" | "done" | "cancelled";
};

const UPLOAD_COLUMNS =
  "id,account_id,dossier_id,batch_id,file_name,bytes,length,received_bytes,state";

/** 创建上传：先核对批次、JPG、大小与空间，再让 tus 落盘。 */
export async function registerUpload(
  client: Client,
  input: {
    account: string;
    dossier: string;
    uploadId: string;
    batchId: string;
    fileName: string;
    length: number;
    lastModified: number | null;
  },
  deps: PhotoDeps,
): Promise<void> {
  if (!isJpegName(input.fileName))
    throw new ApiFailure("PHOTO_UNSUPPORTED", 400, "只收 JPG 原图，这个文件不在可上传范围。");
  if (!(input.length > 0) || input.length > PHOTO_MAX_BYTES)
    throw new ApiFailure("PHOTO_TOO_LARGE", 413, "单张照片超过 64 MB，先确认是不是原图。");
  const batch = await client.query(
    "select 1 from explore_photo_batch where account_id=$1 and id=$2 and dossier_id=$3",
    [input.account, input.batchId, input.dossier],
  );
  if (!batch.rowCount) throw new ApiFailure("PHOTO_BATCH_NOT_FOUND", 404, "找不到这个上传批次。");
  if (deps.freeBytes) {
    const free = await deps.freeBytes();
    if (free > 0 && free - input.length < SPACE_MARGIN)
      throw new ApiFailure("PHOTO_NO_SPACE", 413, "磁盘不够了：先清理空间再传，原图不会被压缩。");
  }
  await client.query(
    `insert into explore_photo_upload(id,account_id,dossier_id,batch_id,file_name,bytes,last_modified,length)
     values($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      input.uploadId,
      input.account,
      input.dossier,
      input.batchId,
      input.fileName,
      input.length,
      input.lastModified,
      input.length,
    ],
  );
}

export async function readUpload(client: Client, uploadId: string): Promise<UploadRow | null> {
  const row = (
    await client.query(`select ${UPLOAD_COLUMNS} from explore_photo_upload where id=$1`, [uploadId])
  ).rows[0] as UploadRow | undefined;
  return row ?? null;
}

export async function setUploadOffset(client: Client, uploadId: string, received: number): Promise<void> {
  await client.query(
    "update explore_photo_upload set received_bytes=$2, updated_at=now() where id=$1",
    [uploadId, received],
  );
}

// ── EXIF ─────────────────────────────────────────────────

export type ParsedExif = {
  dateTimeOriginal: string | null;
  offset: string | null;
  subSec: string | null;
  gpsTime: string | null;
  gps: LngLat | null;
  body: string | null;
  lens: string | null;
  focalMm: number | null;
  aperture: number | null;
  shutterS: number | null;
  iso: number | null;
  orientation: number | null;
  /** 内部用：机型与序列号（只用来分组，不进接口）。 */
  make: string | null;
  model: string | null;
  serial: string | null;
};

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** DMS（度分秒数组）→ 十进制度。 */
function dms(value: unknown, ref: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!Array.isArray(value) || value.length < 2) return null;
  const [d, m = 0, s = 0] = value.map((part) => Number(part));
  if (![d, m, s].every((part) => Number.isFinite(part))) return null;
  const sign = ref === "S" || ref === "W" ? -1 : 1;
  return sign * (d + m / 60 + s / 3600);
}

/** EXIF 原始时刻文本 → 当地墙上时间（不解释时区）。 */
export function wallOfRaw(raw: string | null): { day: string; clock: string } | null {
  if (!raw) return null;
  const match = /^(\d{4})[:\-](\d{2})[:\-](\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(raw.trim());
  if (!match) return null;
  return {
    day: `${match[1]}-${match[2]}-${match[3]}`,
    clock: `${match[4]}:${match[5]}:${match[6] ?? "00"}`,
  };
}

/** 把「某时区里的墙上时间」换成真正的时间点（用真实偏移修正一次，跨夏令时也对）。 */
export function instantOfWall(day: string, clock: string, timezone: string): Date | null {
  const [year, month, date] = day.split("-").map(Number);
  const [hour, minute, second] = clock.split(":").map(Number);
  if (![year, month, date, hour, minute, second].every((part) => Number.isFinite(part))) return null;
  const wall = Date.UTC(year, month - 1, date, hour, minute, second);
  let at = new Date(wall - offsetMinutesAt(timezone, new Date(wall)) * 60000);
  at = new Date(wall - offsetMinutesAt(timezone, at) * 60000);
  return at;
}

/** 「+08:00」这类偏移 → 分钟。 */
export function offsetOf(value: string | null): number | null {
  const match = value ? /^([+-])(\d{2}):?(\d{2})$/.exec(value.trim()) : null;
  if (!match) return null;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

export async function parseExif(bytes: Buffer): Promise<ParsedExif> {
  let raw: Record<string, unknown> = {};
  try {
    raw = (await exifr.parse(bytes, {
      tiff: true,
      exif: true,
      gps: true,
      ifd1: false,
      interop: false,
      mergeOutput: true,
      // 关键：不要让解析库按服务器时区把无偏移的 EXIF 时间「解释」成日期对象。
      reviveValues: false,
      translateValues: false,
      sanitize: false,
    })) as Record<string, unknown>;
  } catch {
    raw = {};
  }
  const gpsLng = dms(raw.GPSLongitude ?? raw.longitude, raw.GPSLongitudeRef);
  const gpsLat = dms(raw.GPSLatitude ?? raw.latitude, raw.GPSLatitudeRef);
  const gps = gpsLng !== null && gpsLat !== null && Math.abs(gpsLat) <= 90 && Math.abs(gpsLng) <= 180
    ? ([gpsLng, gpsLat] as LngLat)
    : null;
  const gpsDay = str(raw.GPSDateStamp);
  const gpsClock = Array.isArray(raw.GPSTimeStamp)
    ? (raw.GPSTimeStamp as number[])
        .map((part, index) => String(Math.floor(Number(part))).padStart(index === 0 ? 2 : 2, "0"))
        .join(":")
    : str(raw.GPSTimeStamp);
  const make = str(raw.Make);
  const model = str(raw.Model);
  return {
    dateTimeOriginal: str(raw.DateTimeOriginal) ?? str(raw.CreateDate),
    offset: str(raw.OffsetTimeOriginal) ?? str(raw.OffsetTime) ?? null,
    subSec: str(raw.SubSecTimeOriginal) ?? str(raw.SubSecTime),
    gpsTime:
      gpsDay && gpsClock
        ? `${gpsDay.replace(/^(\d{4})[:\-](\d{2})[:\-](\d{2})$/, "$1-$2-$3")}T${gpsClock}Z`
        : null,
    gps,
    body: [make, model].filter(Boolean).join(" ").trim() || null,
    lens: str(raw.LensModel) ?? str(raw.Lens),
    focalMm: num(raw.FocalLength),
    aperture: num(raw.FNumber) ?? num(raw.ApertureValue),
    // EXIF 快门常写成 1/250 秒的小数
    shutterS: num(raw.ExposureTime),
    iso: num(raw.ISO) ?? num(raw.ISOSpeedRatings as number),
    orientation: num(raw.Orientation),
    make: make ?? null,
    model: model ?? null,
    serial: str(raw.BodySerialNumber) ?? str(raw.SerialNumber) ?? str(raw.CameraSerialNumber),
  };
}

// ── 派生图与可解释统计 ──────────────────────────────────

export type Derivatives = {
  thumb: Buffer;
  preview: Buffer;
  width: number;
  height: number;
  stats: { brightness: number; contrast: number; sharpness: number; note: string };
};

/** 拉普拉斯方差：越小越可能糊（只是提示，不据此淘汰任何照片）。 */
function laplacianVariance(gray: Uint8Array, width: number, height: number): number {
  const values: number[] = [];
  for (let y = 1; y < height - 1; y += 1)
    for (let x = 1; x < width - 1; x += 1) {
      const at = (xx: number, yy: number) => gray[yy * width + xx];
      values.push(at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1) - 4 * at(x, y));
    }
  if (!values.length) return 0;
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  return values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length;
}

export async function derive(buffer: Buffer): Promise<Derivatives> {
  const image = sharp(buffer, { failOn: "none" }).rotate();
  const meta = await image.metadata();
  const width = meta.autoOrient?.width ?? meta.width ?? 0;
  const height = meta.autoOrient?.height ?? meta.height ?? 0;
  if (!width || !height) throw new Error("不是能解析的图片");
  const [thumb, preview] = await Promise.all([
    sharp(buffer, { failOn: "none" }).rotate().resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: "inside" }).jpeg({ quality: 80 }).toBuffer(),
    sharp(buffer, { failOn: "none" }).rotate().resize({ width: PREVIEW_EDGE, height: PREVIEW_EDGE, fit: "inside" }).jpeg({ quality: 85 }).toBuffer(),
  ]);
  const gray = await sharp(buffer, { failOn: "none" })
    .rotate()
    .greyscale()
    .resize({ width: 256, height: 256, fit: "inside" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixels = new Uint8Array(gray.data);
  const brightness = pixels.reduce((total, value) => total + value, 0) / Math.max(1, pixels.length);
  const variance =
    pixels.reduce((total, value) => total + (value - brightness) ** 2, 0) / Math.max(1, pixels.length);
  const sharpness = laplacianVariance(pixels, gray.info.width, gray.info.height);
  return {
    thumb,
    preview,
    width,
    height,
    stats: {
      brightness: Math.round(brightness),
      contrast: Math.round(Math.sqrt(variance)),
      sharpness: Math.round(sharpness),
      // 只当提示：模糊也可能是有意为之，不拿它淘汰照片。
      note:
        sharpness < 8
          ? "清晰度偏低，可能没对上焦或有意虚化；要不要用由你定"
          : brightness < 40
            ? "画面偏暗"
            : brightness > 220
              ? "画面偏亮"
              : "曝光与清晰度没有明显异常",
    },
  };
}

/** 用户要求「看那一块」时的原图裁切（0–1 比例），返回 JPEG。 */
export async function cropOf(original: string, rect: { x: number; y: number; w: number; h: number }): Promise<Buffer> {
  const meta = await sharp(original, { failOn: "none" }).rotate().metadata();
  const width = meta.autoOrient?.width ?? meta.width ?? 0;
  const height = meta.autoOrient?.height ?? meta.height ?? 0;
  if (!width || !height) throw new ApiFailure("PHOTO_CROP_FAILED", 503, "这张原图现在读不了。");
  const left = Math.max(0, Math.min(width - 1, Math.round(rect.x * width)));
  const top = Math.max(0, Math.min(height - 1, Math.round(rect.y * height)));
  const w = Math.max(16, Math.min(width - left, Math.round(rect.w * width)));
  const h = Math.max(16, Math.min(height - top, Math.round(rect.h * height)));
  return sharp(original, { failOn: "none" })
    .rotate()
    .extract({ left, top, width: w, height: h })
    // 局部本来就小的时候不放大充数：清晰是清晰，放大只是虚胖。
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toBuffer();
}

const sha256Of = (file: string) =>
  new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });

// ── 分组、对时、落位 ────────────────────────────────────

export type CameraGroupRow = {
  id: string;
  label: string;
  fingerprint: string;
  timezone: string | null;
  timezone_basis: string | null;
  offset_sec: number | null;
  residual_sec: number | null;
  status: string;
};

/** 同一台机身（型号 + 序列号）一组；认不出序列号时只能靠型号，页面会让人确认。 */
export async function groupFor(
  client: Client,
  account: string,
  dossier: string,
  exif: ParsedExif,
  planTimezone: string | null,
): Promise<CameraGroupRow> {
  const label = exif.body ?? "未知机身";
  const fingerprint = [exif.make ?? "", exif.model ?? "", exif.serial ?? ""].join("|");
  const existing = (
    await client.query(
      `select id,label,fingerprint,timezone,timezone_basis,offset_sec,residual_sec,status
         from explore_camera_group where account_id=$1 and dossier_id=$2 and fingerprint=$3`,
      [account, dossier, fingerprint],
    )
  ).rows[0] as CameraGroupRow | undefined;
  if (existing) return existing;
  // 时区依据：EXIF 自带偏移就不用猜；否则等用户确认（计划所在地只是提示，不当成结论）。
  const basis = exif.offset ? "offset_tag" : null;
  const timezone = exif.offset ? null : null;
  void planTimezone;
  const created = (
    await client.query(
      `insert into explore_camera_group(account_id,dossier_id,label,fingerprint,timezone,timezone_basis,status)
       values($1,$2,$3,$4,$5,$6,'auto') returning id,label,fingerprint,timezone,timezone_basis,offset_sec,residual_sec,status`,
      [account, dossier, label, fingerprint, timezone, basis],
    )
  ).rows[0] as CameraGroupRow;
  return created;
}

export type TimeResult = {
  takenAt: Date | null;
  correctedAt: Date | null;
  basis: "offset_tag" | "gps" | "clock_fix" | "unknown";
  trust: "certain" | "estimated" | "pending";
  /** 分组本身还能不能算（没时区依据又没过用户确认时是 false）。 */
  timed: boolean;
};

/**
 * 照片时间：EXIF 原文 + 已确认的组设置。
 * 有偏移标签或 GPS UTC 就直接解释；组里确认过时区就用它；都没有就 pending，不假装知道。
 */
export function timeOf(exif: ParsedExif, group: CameraGroupRow): TimeResult {
  const wall = wallOfRaw(exif.dateTimeOriginal);
  const offsetMin = offsetOf(exif.offset);
  if (wall && offsetMin !== null) {
    const taken =
      instantOfWall(wall.day, wall.clock, "UTC") &&
      new Date(Date.parse(`${wall.day}T${wall.clock}Z`) - offsetMin * 60000);
    const corrected = taken && group.offset_sec !== null ? new Date(taken.getTime() + group.offset_sec * 1000) : taken;
    return {
      takenAt: taken,
      correctedAt: corrected,
      basis: group.offset_sec !== null ? "clock_fix" : "offset_tag",
      trust: group.offset_sec !== null ? "certain" : "certain",
      timed: true,
    };
  }
  if (exif.gpsTime) {
    const taken = new Date(exif.gpsTime);
    if (!Number.isNaN(taken.getTime())) {
      const corrected = group.offset_sec !== null ? new Date(taken.getTime() + group.offset_sec * 1000) : taken;
      return { takenAt: taken, correctedAt: corrected, basis: "gps", trust: "certain", timed: true };
    }
  }
  if (wall && group.timezone) {
    const taken = instantOfWall(wall.day, wall.clock, group.timezone);
    if (taken) {
      const corrected = group.offset_sec !== null ? new Date(taken.getTime() + group.offset_sec * 1000) : taken;
      return {
        takenAt: taken,
        correctedAt: corrected,
        basis: group.offset_sec !== null ? "clock_fix" : "unknown",
        trust: group.offset_sec !== null ? "certain" : "estimated",
        timed: true,
      };
    }
  }
  return { takenAt: null, correctedAt: null, basis: "unknown", trust: "pending", timed: false };
}

const EARTH_RADIUS = 6_371_000;
export function distanceMeters(a: LngLat, b: LngLat): number {
  const rad = (value: number) => (value * Math.PI) / 180;
  const dLat = rad(b[1] - a[1]);
  const dLng = rad(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h))));
}

const pointOf = (stop: PlanDocument["stops"][number]): LngLat =>
  stop.geometry.type === "Point" ? (stop.geometry.coordinates as LngLat) : null as never;

function insidePolygon(point: LngLat, ring: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

/** 固定点 50 米内、街区在区域内才算这个停留点。 */
function stopNear(document: PlanDocument, at: LngLat, radiusM = 50): string | null {
  for (const stop of document.stops) {
    if (stop.geometry.type === "Point") {
      if (distanceMeters(at, stop.geometry.coordinates as LngLat) <= radiusM) return stop.id;
    } else if (stop.geometry.type === "Polygon") {
      const ring = (stop.geometry.coordinates[0] ?? []) as LngLat[];
      if (ring.length >= 4 && insidePolygon(at, ring)) return stop.id;
      if (ring.length >= 4 && distanceMeters(at, ring[0]) <= radiusM) return stop.id;
    }
  }
  return null;
}

export type Placement = {
  stopId: string | null;
  basis: "gps" | "event" | "plan_time" | "manual" | "unplanned" | "pending";
  at: LngLat | null;
};

/**
 * 落位：GPS > 打卡 > 按计划时间推定，按这个顺序取第一个说得通的。
 * 说不清就 pending（页面显示"待确认"），不硬塞最近的机位。
 */
export function placementOf(input: {
  document: PlanDocument;
  events: FieldEventRecord[];
  gps: LngLat | null;
  correctedAt: Date | null;
  timed: boolean;
}): Placement {
  if (input.gps) {
    const stopId = stopNear(input.document, input.gps);
    return { stopId, basis: stopId ? "gps" : "unplanned", at: input.gps };
  }
  if (input.correctedAt && input.timed) {
    const at = input.correctedAt.getTime();
    // 打卡：这张照片的校正时间落在某次「到了 / 拍到了」前后 10 分钟内。
    let best: { stopId: string | null; at: LngLat | null; gap: number } | null = null;
    for (const event of input.events) {
      if (event.status !== "ok") continue;
      if (event.kind !== "arrived" && event.kind !== "shot") continue;
      const when = Date.parse(event.at);
      if (Number.isNaN(when)) continue;
      const gap = Math.abs(when - at);
      if (gap > 10 * 60_000) continue;
      if (!best || gap < best.gap)
        best = {
          stopId: event.stopId,
          at: event.position?.at ?? null,
          gap,
        };
    }
    if (best) return { stopId: best.stopId, basis: "event", at: best.at };
    // 计划时段：推定，页面标"按时间推定"，不当原生定位。
    for (const stop of input.document.stops) {
      if (!stop.window) continue;
      const start = Date.parse(stop.window.start);
      const end = Date.parse(stop.window.end);
      if (Number.isNaN(start) || Number.isNaN(end)) continue;
      if (at >= start - 20 * 60_000 && at <= end + 20 * 60_000)
        return { stopId: stop.id, basis: "plan_time", at: null };
    }
  }
  return { stopId: null, basis: "pending", at: null };
}

// ── 处理一张照片 ─────────────────────────────────────────

export type PhotoRow = {
  id: string;
  batch_id: string;
  file_name: string;
  bytes: string | number;
  sha256: string;
  status: string;
  error: string | null;
  original_path: string | null;
  thumb_path: string | null;
  preview_path: string | null;
  exif: ParsedExif | Record<string, unknown>;
  taken_raw: string | null;
  corrected_ts: Date | null;
  time_basis: string | null;
  time_trust: string | null;
  camera_group_id: string | null;
  placement_stop_id: string | null;
  placement_basis: string | null;
  placement_lng: number | null;
  placement_lat: number | null;
  placement_manual: boolean;
  ai_mark: string | null;
  ai_reason: string | null;
  ai_inspected: string;
  picked: boolean;
  stats: Record<string, unknown> | null;
  created_at: Date;
};

const PHOTO_COLUMNS =
  "id,batch_id,file_name,bytes,sha256,status,error,original_path,thumb_path,preview_path,exif,taken_raw," +
  "corrected_ts,time_basis,time_trust,camera_group_id,placement_stop_id,placement_basis,placement_lng," +
  "placement_lat,placement_manual,ai_mark,ai_reason,ai_inspected,picked,stats,created_at";

const MEDIA = (dossier: string, id: string, kind: string) =>
  `/v1/explore/plans/${dossier}/photos/${id}/${kind}`;

export function photoOf(dossier: string, row: PhotoRow): Photo {
  const exif = (row.exif ?? {}) as Partial<ParsedExif>;
  const exifView = {
    dateTimeOriginal: exif.dateTimeOriginal ?? null,
    offset: exif.offset ?? null,
    subSec: exif.subSec ?? null,
    gpsTime: exif.gpsTime ?? null,
    gps: (exif.gps as LngLat | null) ?? null,
    body: exif.body ?? null,
    lens: exif.lens ?? null,
    focalMm: exif.focalMm ?? null,
    aperture: exif.aperture ?? null,
    shutterS: exif.shutterS ?? null,
    iso: exif.iso ?? null,
    orientation: exif.orientation ?? null,
  };
  return {
    id: row.id,
    batchId: row.batch_id,
    fileName: row.file_name,
    bytes: Number(row.bytes),
    sha256: row.sha256,
    status: row.status as Photo["status"],
    ...(row.error ? { error: row.error } : {}),
    exif: exifView,
    cameraGroupId: row.camera_group_id,
    time: {
      corrected: row.corrected_ts ? new Date(row.corrected_ts).toISOString() : null,
      basis: (row.time_basis as Photo["time"]["basis"]) ?? "unknown",
      trust: (row.time_trust as Photo["time"]["trust"]) ?? "pending",
    },
    placement: {
      stopId: row.placement_stop_id,
      basis: (row.placement_basis as Photo["placement"]["basis"]) ?? "pending",
      at: row.placement_lng !== null && row.placement_lat !== null ? [row.placement_lng, row.placement_lat] : null,
    },
    ai: {
      mark: (row.ai_mark as Photo["ai"]["mark"]) ?? null,
      ...(row.ai_reason ? { reason: row.ai_reason } : {}),
      inspected: (row.ai_inspected as Photo["ai"]["inspected"]) ?? "none",
    },
    picked: row.picked,
    thumb: MEDIA(dossier, row.id, "thumb"),
    preview: MEDIA(dossier, row.id, "preview"),
  };
}

const isJpeg = (bytes: Buffer) => bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

/**
 * 一个上传完成：校验是 JPG、算摘要去重、入库存原图、派生图、分组、对时、落位。
 * 返回这张照片的 id 和状态（重复的文件返回已有那张）。
 */
export async function finishUpload(
  client: Client,
  input: { account: string; dossier: string; uploadId: string; document: PlanDocument; plan?: StoredPlan },
  deps: PhotoDeps,
): Promise<{ photoId: string; duplicate: boolean; status: "ready" | "failed"; error?: string }> {
  const upload = await readUpload(client, input.uploadId);
  if (!upload || upload.account_id !== input.account || upload.dossier_id !== input.dossier)
    throw new ApiFailure("PHOTO_UPLOAD_MISSING", 404, "这次上传不在了。");
  if (upload.state === "done") throw new ApiFailure("PHOTO_UPLOAD_DONE", 409, "这次上传已经处理过了。");

  const photoId = randomUUID();
  await deps.store.adoptUpload(input.dossier, photoId, input.uploadId);
  const file = deps.store.originalPath(input.dossier, photoId);
  const sha256 = await sha256Of(file);
  const bytes = Number(upload.bytes);

  // 同档案同内容：复用已有那张，分片删掉（不改原图、不重复占空间）。
  const existing = (
    await client.query(
      `select ${PHOTO_COLUMNS} from explore_photo
        where account_id=$1 and dossier_id=$2 and sha256=$3 and deleted_at is null`,
      [input.account, input.dossier, sha256],
    )
  ).rows[0] as PhotoRow | undefined;
  if (existing) {
    await deps.store.remove(input.dossier, photoId);
    await client.query("update explore_photo_upload set state='done', updated_at=now() where id=$1", [input.uploadId]);
    await client.query(
      "update explore_photo_batch set uploaded=uploaded+1, processed=processed+1 where account_id=$1 and id=$2",
      [input.account, upload.batch_id],
    );
    return { photoId: existing.id, duplicate: true, status: "ready" };
  }

  const header = await deps.store.read(input.dossier, photoId, "original.jpg");
  if (!header || !isJpeg(header)) {
    await deps.store.remove(input.dossier, photoId);
    await client.query("update explore_photo_upload set state='done', updated_at=now() where id=$1", [input.uploadId]);
    await client.query(
      "update explore_photo_batch set uploaded=uploaded+1, failed=failed+1 where account_id=$1 and id=$2",
      [input.account, upload.batch_id],
    );
    return { photoId, duplicate: false, status: "failed", error: "不是有效的 JPG 文件" };
  }

  const exif = await parseExif(header);
  const photo = (
    await client.query(
      `insert into explore_photo(id,account_id,dossier_id,batch_id,file_name,bytes,sha256,status,original_path,exif,taken_raw)
       values($1,$2,$3,$4,$5,$6,$7,'processing','original.jpg',$8::jsonb,$9)
       returning ${PHOTO_COLUMNS}`,
      [
        photoId,
        input.account,
        input.dossier,
        upload.batch_id,
        upload.file_name,
        bytes,
        sha256,
        JSON.stringify(exif),
        exif.dateTimeOriginal,
      ],
    )
  ).rows[0] as PhotoRow;

  try {
    const group = await groupFor(client, input.account, input.dossier, exif, input.document.destination?.timezone ?? null);
    const derivatives = await derive(header);
    await deps.store.write(input.dossier, photo.id, "thumb.jpg", derivatives.thumb);
    await deps.store.write(input.dossier, photo.id, "preview.jpg", derivatives.preview);
    const time = timeOf(exif, group);
    const events = await listFieldEvents(client, { account: input.account, dossier: input.dossier, document: input.document });
    const placement = placementOf({
      document: input.document,
      events,
      gps: exif.gps,
      correctedAt: time.correctedAt,
      timed: time.timed,
    });
    await client.query(
      `update explore_photo set status='ready', thumb_path='thumb.jpg', preview_path='preview.jpg',
              camera_group_id=$3, taken_ts=$4, corrected_ts=$5, time_basis=$6, time_trust=$7,
              placement_stop_id=$8, placement_basis=$9, placement_lng=$10, placement_lat=$11,
              stats=$12::jsonb, updated_at=now()
        where account_id=$1 and id=$2`,
      [
        input.account,
        photo.id,
        group.id,
        time.takenAt,
        time.correctedAt,
        time.basis,
        time.trust,
        placement.stopId,
        placement.basis,
        placement.at?.[0] ?? null,
        placement.at?.[1] ?? null,
        JSON.stringify({ ...derivatives.stats, width: derivatives.width, height: derivatives.height }),
      ],
    );
    // 相机组里没有任何时间依据、也没有锚点时，明说「需要一个参照」。
    await refreshGroupStatus(client, input.account, input.dossier, group.id);
  } catch (error) {
    const message = String((error as Error)?.message ?? "处理失败").slice(0, 200);
    await client.query(
      "update explore_photo set status='failed', error=$3, updated_at=now() where account_id=$1 and id=$2",
      [input.account, photo.id, message],
    );
    await client.query("update explore_photo_upload set state='done', updated_at=now() where id=$1", [input.uploadId]);
    await client.query(
      "update explore_photo_batch set uploaded=uploaded+1, processed=processed+1, failed=failed+1 where account_id=$1 and id=$2",
      [input.account, upload.batch_id],
    );
    return { photoId: photo.id, duplicate: false, status: "failed", error: message };
  }

  await client.query("update explore_photo_upload set state='done', updated_at=now() where id=$1", [input.uploadId]);
  await client.query(
    "update explore_photo_batch set uploaded=uploaded+1, processed=processed+1 where account_id=$1 and id=$2",
    [input.account, upload.batch_id],
  );
  return { photoId: photo.id, duplicate: false, status: "ready" };
}

/** 组的可信状态：有时区依据/锚点就是 auto，否则 needs_anchor。 */
export async function refreshGroupStatus(client: Client, account: string, dossier: string, groupId: string) {
  const row = (
    await client.query(
      `select g.id,g.timezone,g.offset_sec,g.status,
              (select count(*)::int from explore_clock_anchor a
                where a.account_id=g.account_id and a.dossier_id=g.dossier_id and a.group_id=g.id) anchors,
              (select count(*)::int from explore_photo p
                where p.account_id=g.account_id and p.dossier_id=g.dossier_id
                  and p.camera_group_id=g.id and p.deleted_at is null) photos,
              (select count(*)::int from explore_photo p
                where p.account_id=g.account_id and p.dossier_id=g.dossier_id
                  and p.camera_group_id=g.id and p.deleted_at is null
                  and p.time_trust='certain') certain
         from explore_camera_group g where g.account_id=$1 and g.dossier_id=$2 and g.id=$3`,
      [account, dossier, groupId],
    )
  ).rows[0];
  if (!row) return;
  let status = row.status;
  if (row.status !== "inconsistent" && (row.anchors > 0 || row.certain > 0)) status = "auto";
  else if (row.status === "auto" || row.status === "needs_anchor") status = row.timezone ? "auto" : "needs_anchor";
  if (status !== row.status)
    await client.query(
      "update explore_camera_group set status=$3, updated_at=now() where account_id=$1 and id=$2",
      [account, groupId, status],
    );
}

// ── 读照片 ──────────────────────────────────────────────

export async function listPhotos(
  client: Client,
  input: { account: string; dossier: string; cursor?: string; stopId?: string; group?: string; limit?: number },
): Promise<{ items: Photo[]; cursor: string | null }> {
  const limit = Math.min(200, Math.max(1, input.limit ?? 60));
  const after = input.cursor ? new Date(input.cursor) : null;
  const params: unknown[] = [input.account, input.dossier];
  const where = ["account_id=$1", "dossier_id=$2", "deleted_at is null"];
  if (input.stopId === "__none") where.push("placement_stop_id is null");
  else if (input.stopId) {
    params.push(input.stopId);
    where.push(`placement_stop_id=$${params.length}`);
  }
  if (input.group === "unplanned") where.push("placement_basis='unplanned'");
  else if (input.group === "pending") where.push("placement_basis='pending'");
  if (after) {
    params.push(after.toISOString());
    where.push(`created_at > $${params.length}::timestamptz`);
  }
  params.push(limit + 1);
  const rows = (
    await client.query(
      `select ${PHOTO_COLUMNS} from explore_photo where ${where.join(" and ")}
        order by created_at asc limit $${params.length}`,
      params,
    )
  ).rows as PhotoRow[];
  const items = rows.slice(0, limit);
  return {
    items: items.map((row) => photoOf(input.dossier, row)),
    cursor:
      rows.length > limit && items.length
        ? new Date(items[items.length - 1].created_at).toISOString()
        : null,
  };
}

export async function photoRow(client: Client, account: string, dossier: string, photoId: string): Promise<PhotoRow> {
  if (!/^[0-9a-f-]{36}$/i.test(photoId)) throw new ApiFailure("PHOTO_NOT_FOUND", 404, "找不到这张照片。");
  const row = (
    await client.query(
      `select ${PHOTO_COLUMNS} from explore_photo
        where account_id=$1 and dossier_id=$2 and id=$3 and deleted_at is null`,
      [account, dossier, photoId],
    )
  ).rows[0] as PhotoRow | undefined;
  if (!row) throw new ApiFailure("PHOTO_NOT_FOUND", 404, "找不到这张照片。");
  return row;
}

/** 批量改归属：手动归属记下来，之后任何重算都不覆盖。 */
export async function assignPhotos(
  client: Client,
  input: { account: string; dossier: string; photoIds: string[]; stopId: string | null; document: PlanDocument },
): Promise<number> {
  const stop = input.stopId ? input.document.stops.find((row) => row.id === input.stopId) : null;
  if (input.stopId && !stop) throw new ApiFailure("STOP_NOT_FOUND", 404, "计划里没有这个停留点。");
  const ids = input.photoIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id)).slice(0, 500);
  if (!ids.length) throw new ApiFailure("INVALID_INPUT", 400, "要给出照片 id。");
  const result = await client.query(
    `update explore_photo set placement_stop_id=$3,
            placement_basis=case when $3::text is null then 'unplanned' else 'manual' end,
            placement_manual=true, updated_at=now()
      where account_id=$1 and dossier_id=$2 and id = any($4::uuid[]) and deleted_at is null`,
    [input.account, input.dossier, input.stopId, ids],
  );
  return result.rowCount ?? 0;
}

/** 用户精选：和 AI 标记分开存，互不覆盖。 */
export async function pickPhotos(
  client: Client,
  input: { account: string; dossier: string; photoIds: string[]; picked: boolean },
): Promise<number> {
  const ids = input.photoIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id)).slice(0, 500);
  if (!ids.length) throw new ApiFailure("INVALID_INPUT", 400, "要给出照片 id。");
  const result = await client.query(
    `update explore_photo set picked=$3, updated_at=now()
      where account_id=$1 and dossier_id=$2 and id = any($4::uuid[]) and deleted_at is null`,
    [input.account, input.dossier, input.picked, ids],
  );
  return result.rowCount ?? 0;
}

/** AI 标记：只写 ai_* 三列，不动 picked。 */
export async function markPhotos(
  client: Client,
  input: {
    account: string;
    dossier: string;
    photoIds: string[];
    mark: "recommend" | "alternate" | null;
    reason?: string;
    inspected?: "none" | "preview" | "detail";
  },
): Promise<number> {
  const ids = input.photoIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id)).slice(0, 200);
  if (!ids.length) throw new ApiFailure("INVALID_INPUT", 400, "要给出照片 id。");
  const result = await client.query(
    `update explore_photo set ai_mark=$3, ai_reason=$4,
            ai_inspected=coalesce($5, ai_inspected), updated_at=now()
      where account_id=$1 and dossier_id=$2 and id = any($6::uuid[]) and deleted_at is null`,
    [input.account, input.dossier, input.mark, input.reason ?? null, input.inspected ?? null, ids],
  );
  return result.rowCount ?? 0;
}

/** 用户明确删除才删；掉落版本里的照片只是 delected_at，原图文件同时删掉。 */
export async function deletePhoto(
  client: Client,
  input: { account: string; dossier: string; photoId: string },
  deps: PhotoDeps,
): Promise<void> {
  const row = await photoRow(client, input.account, input.dossier, input.photoId);
  await client.query(
    "update explore_photo set deleted_at=now(), updated_at=now() where account_id=$1 and id=$2",
    [input.account, row.id],
  );
  await deps.store.remove(input.dossier, row.id);
}

export async function storageUsage(deps: PhotoDeps, dossier: string): Promise<{ dossierBytes: number; freeBytes: number }> {
  return {
    dossierBytes: await deps.store.usedBytes(dossier),
    freeBytes: deps.freeBytes ? await deps.freeBytes() : 0,
  };
}
