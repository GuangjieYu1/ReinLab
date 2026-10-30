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
    ops: z.array(OpInput).min(1).max(200),
    authorization: z.object({ messageId: z.string().min(1).max(200) }).strict().optional(),
  })
  .strict();

export const SettingsBody = z.object({ timezone: z.string().min(1).max(64) }).strict();

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
