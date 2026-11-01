/**
 * 探索台接口的入参形状（design/prd/07-explore-contract.md 第 2、3 节）。
 *
 * 这里只校验「长得对不对」；语义（几何与停留点类型是否匹配、时段是否合理、
 * 哪些字段归服务端）由纯引擎判断，保证页面和 Agent 走同一套规则。
 */
import { z } from "zod";

export const position = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
]);

const point = z.object({ type: z.literal("Point"), coordinates: position }).strict();
const polygon = z
  .object({
    type: z.literal("Polygon"),
    coordinates: z.array(z.array(position).min(4).max(20000)).min(1).max(50),
  })
  .strict();
const line = z
  .object({
    type: z.literal("LineString"),
    coordinates: z.array(position).min(2).max(20000),
  })
  .strict();
const multiLine = z
  .object({
    type: z.literal("MultiLineString"),
    coordinates: z.array(z.array(position).min(2).max(20000)).min(1).max(50),
  })
  .strict();
const geometry = z.union([point, line, polygon, multiLine]);

export const viewport = z
  .object({
    center: position,
    zoom: z.number().finite().min(0).max(24),
    bearing: z.number().finite().min(-360).max(360),
    pitch: z.number().finite().min(0).max(85),
  })
  .strict();

const record = z.record(z.unknown());
const stopId = z.string().min(1).max(64);

/**
 * 一个动作。停留点与草图的正文用宽松对象接住，再交给引擎按字段校验并剥掉
 * 服务端字段（id/state/source/light），这样页面和模型都不必背内部字段名。
 */
export const OpInput = z.discriminatedUnion("op", [
  z.object({ op: z.literal("stop.add"), stop: record }).strict(),
  z.object({ op: z.literal("stop.update"), id: stopId, patch: record }).strict(),
  z.object({ op: z.literal("stop.remove"), id: stopId }).strict(),
  z.object({ op: z.literal("stop.confirm"), ids: z.array(stopId).min(1).max(100) }).strict(),
  z.object({ op: z.literal("plan.set"), patch: record }).strict(),
  // 第一次确认整份计划时允许把账户时区一起带来（契约第 6 节：确认卡里改，确认即保存）。
  z.object({ op: z.literal("plan.confirm"), timezone: z.string().min(1).max(64).optional() }).strict(),
  z.object({ op: z.literal("plan.finish") }).strict(),
  z.object({ op: z.literal("plan.cancel") }).strict(),
  z
    .object({
      op: z.literal("plan.select"),
      people: z.array(z.string().max(64)).max(50).optional(),
      gear: z.array(z.string().max(64)).max(50).optional(),
      refresh: z.boolean().optional(),
    })
    .strict(),
  z.object({ op: z.literal("feel.set"), feel: record }).strict(),
  z.object({ op: z.literal("canvas.add"), object: record }).strict(),
  z.object({ op: z.literal("canvas.update"), id: stopId, patch: record }).strict(),
  z.object({ op: z.literal("canvas.remove"), id: stopId }).strict(),
  z.object({ op: z.literal("canvas.undo") }).strict(),
  z.object({ op: z.literal("view.save"), viewport, basemap: z.enum(["vector", "satellite"]) }).strict(),
]);

export const OpsBody = z
  .object({
    // -1 是页面「不管修订」的写法（拖动视野时用）；负值不做冲突判断。
    baseRevision: z.number().int().optional(),
    // 一次别塞太多动作：大批量参数更容易被模型写成非法 JSON（验收时踩过）。
    ops: z.array(OpInput).min(1).max(20),
    authorization: z.object({ messageId: z.string().min(1).max(200) }).strict().optional(),
  })
  .strict();

export const SettingsBody = z.object({ timezone: z.string().min(1).max(64) }).strict();

// ── 第二版第 1 批：现场记录、离线包（10-explore-v2-contract.md §2.1–2.2）──

const fieldCorrection = z.discriminatedUnion("action", [
  z.object({ action: z.literal("retract") }).strict(),
  z.object({ action: z.literal("edit"), text: z.string().min(1).max(4000) }).strict(),
  z.object({ action: z.literal("relink"), stopId: z.string().min(1).max(64) }).strict(),
]);

const fieldEvent = z
  .object({
    clientId: z.string().min(1).max(100),
    kind: z.enum(["arrived", "shot", "note", "situation", "correction"]),
    stopId: z.string().min(1).max(64).nullable(),
    stopName: z.string().max(200).nullable(),
    planRevision: z.number().int().min(0).max(1_000_000),
    // 带偏移的 ISO：现场那一刻，不是服务器时间。
    at: z.string().datetime({ offset: true }),
    tz: z.string().min(1).max(64),
    text: z.string().max(4000).optional(),
    situation: z.enum(["rain", "late", "crowd", "light", "other"]).optional(),
    position: z
      .object({ at: position, accuracyM: z.number().finite().min(0).max(100_000) })
      .strict()
      .optional(),
    refersTo: z.string().min(1).max(100).optional(),
    correction: fieldCorrection.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === "correction") {
      if (!value.refersTo)
        ctx.addIssue({ code: "custom", message: "更正要指向原记录的 clientId。" });
      if (!value.correction)
        ctx.addIssue({ code: "custom", message: "更正要说明是撤销、改文字还是重新关联。" });
      return;
    }
    if (value.correction || value.refersTo)
      ctx.addIssue({ code: "custom", message: "只有 correction 事件能带更正内容。" });
    if (value.situation && value.kind !== "situation")
      ctx.addIssue({ code: "custom", message: "situation 只属于「情况变了」。" });
  });

export const FieldEventsBody = z
  .object({ events: z.array(fieldEvent).min(1).max(200) })
  .strict();

export const OfflinePackBody = z
  .object({
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    detail: z.enum(["full", "low"]).optional(),
  })
  .strict();

/**
 * 模特 / 器材：字段按契约给，服务端只认这些键。
 * 具体的数值范围与「机身还是镜头」由资料层再校验一次。
 */
/** 页面保存资料时会把整条资料带回来（含 id / revision / confirmedBy）：认下但不用。 */
const profileCarried = {
  id: z.string().max(64).optional(),
  revision: z.number().int().min(0).optional(),
  confirmedBy: z.literal("user").optional(),
};

const profileFields = {
  name: z.string().min(1).max(80),
  height: z.number().finite().min(50).max(250).optional(),
  style: z.string().max(200).optional(),
  experience: z.string().max(300).optional(),
  wardrobe: z.string().max(500).optional(),
  notes: z.union([z.array(z.string().max(200)).max(20), z.string().max(300)]).optional(),
  kind: z.enum(["body", "lens"]).optional(),
  focal: z.tuple([z.number().finite().positive(), z.number().finite().positive()]).optional(),
  aperture: z.number().finite().positive().max(64).optional(),
};

/** 地点经验：账户级资料的新类型（契约 §2.5）。 */
const placeFields = {
  type: z.literal("place"),
  name: z.string().min(1).max(80),
  at: position,
  radiusM: z.number().finite().min(30).max(5000).optional(),
  standpoint: z.string().max(200).optional(),
  observedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  season: z.string().max(20).optional(),
  timeOfDay: z.string().max(40).optional(),
  text: z.string().min(1).max(4000),
  evidence: z
    .object({
      photoIds: z.array(z.string().uuid()).max(100).optional(),
      eventIds: z.array(z.string().min(1).max(100)).max(100).optional(),
      dossierId: z.string().uuid(),
    })
    .strict()
    .optional(),
};

export const ProfileBody = z.union([
  z
  .object({
    ...profileCarried,
    type: z.enum(["model", "gear"]),
    name: z.string().min(1).max(80),
    height: z.number().finite().min(50).max(250).optional(),
    style: z.string().max(200).optional(),
    experience: z.string().max(300).optional(),
    wardrobe: z.string().max(500).optional(),
    notes: z.union([z.array(z.string().max(200)).max(20), z.string().max(300)]).optional(),
    kind: z.enum(["body", "lens"]).optional(),
    focal: z.tuple([z.number().finite().positive(), z.number().finite().positive()]).optional(),
    aperture: z.number().finite().positive().max(64).optional(),
  })
    .strict(),
  z.object({ ...profileCarried, ...placeFields }).strict(),
]);

/** 修改：带 baseRevision（乐观并发），其余字段可选。 */
export const ProfilePatchBody = z.union([
  z
  .object({
    ...profileCarried,
    baseRevision: z.number().int().nonnegative(),
    name: z.string().min(1).max(80).optional(),
    height: z.number().finite().min(50).max(250).optional(),
    style: z.string().max(200).optional(),
    experience: z.string().max(300).optional(),
    wardrobe: z.string().max(500).optional(),
    notes: z.union([z.array(z.string().max(200)).max(20), z.string().max(300)]).optional(),
    kind: z.enum(["body", "lens"]).optional(),
    focal: z.tuple([z.number().finite().positive(), z.number().finite().positive()]).optional(),
    aperture: z.number().finite().positive().max(64).optional(),
  })
    .strict(),
  z
    .object({
      ...profileCarried,
      baseRevision: z.number().int().nonnegative(),
      ...placeFields,
    })
    .partial({ type: true, name: true, at: true, observedOn: true, text: true })
    .strict(),
]);

/** geometry 的导出形状给引擎类型用。 */
export const geometrySchema = geometry;

/** 浏览器 / Node 都认的 IANA 时区名；认不出来就退回默认时区，页面据此提示。 */
export function isIanaTimezone(value: string): boolean {
  if (!value.includes("/")) return value === "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// ── 第二版第 3 批：照片、对时、回顾（契约 §2.3–2.5）──

export const PhotoBatchBody = z
  .object({
    files: z
      .array(
        z
          .object({
            name: z.string().min(1).max(300),
            bytes: z.number().int().min(0).max(1_000_000_000),
            lastModified: z.number().int().min(0).max(1_000_000_000_000_000),
          })
          .strict(),
      )
      .min(1)
      .max(2000),
  })
  .strict();

const photoIds = z.array(z.string().uuid()).min(1).max(500);

export const AssignBody = z
  .object({
    photoIds,
    stopId: z.string().min(1).max(64).nullable(),
    basis: z.literal("manual").optional(),
  })
  .strict();

export const PickBody = z.object({ photoIds, picked: z.boolean() }).strict();

export const AnchorBody = z
  .object({
    photoId: z.string().uuid(),
    eventClientId: z.string().min(1).max(100).optional(),
    time: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.eventClientId || value.time), {
    message: "锚点要给一次打卡，或一个已知时刻。",
  });

export const ConfirmClockBody = z
  .object({
    timezone: z.string().min(1).max(64),
    offsetSec: z.number().int().min(-400 * 86_400).max(400 * 86_400),
  })
  .strict();

export const SplitClockBody = z.object({ beforePhotoId: z.string().uuid() }).strict();

export const TravelogueBody = z
  .object({
    baseRevision: z.number().int().min(0),
    markdown: z.string().min(1).max(200_000),
  })
  .strict();
