/**
 * 创作台接口的入参形状（20-creative-contract.md §1.1、§2）。
 *
 * 这里只校验「长得对不对」；语义（时间写法、引用是否存在、能不能删）由
 * creative/world.ts 和 creative/check.ts 判断，保证页面和 Agent 走同一套规则。
 */

import { z } from 'zod';

const position = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
]);

const point = z.object({ type: z.literal('Point'), coordinates: position }).strict();
const line = z.object({ type: z.literal('LineString'), coordinates: z.array(position).min(2).max(20000) }).strict();
const polygon = z
  .object({ type: z.literal('Polygon'), coordinates: z.array(z.array(position).min(4).max(2000)).min(1).max(50) })
  .strict();
const multiPolygon = z
  .object({
    type: z.literal('MultiPolygon'),
    coordinates: z.array(z.array(z.array(position).min(4).max(2000)).min(1).max(50)).min(1).max(20),
  })
  .strict();
const multiLine = z
  .object({ type: z.literal('MultiLineString'), coordinates: z.array(z.array(position).min(2).max(20000)).min(1).max(50) })
  .strict();
const geometry = z.union([point, line, polygon, multiPolygon, multiLine]);

const record = z.record(z.unknown());
const entityId = z.string().min(1).max(64);

const timeInput = z.object({ input: z.string().min(1).max(200), calendar: z.string().min(1).max(64).optional() }).strict();

/**
 * 一个操作。正文用宽松对象接住，再交给纯引擎按字段校验并剥掉服务端字段，
 * 这样页面不必背内部字段名。
 */
export const OpInput = z.discriminatedUnion('op', [
  z.object({ op: z.literal('entity.add'), entity: record }).strict(),
  z.object({ op: z.literal('entity.update'), id: entityId, patch: record }).strict(),
  z.object({ op: z.literal('entity.remove'), id: entityId }).strict(),
  z.object({ op: z.literal('relation.add'), relation: record }).strict(),
  z.object({ op: z.literal('relation.update'), id: entityId, patch: record }).strict(),
  z.object({ op: z.literal('relation.remove'), id: entityId }).strict(),
  z.object({ op: z.literal('event.add'), event: record }).strict(),
  z.object({ op: z.literal('event.update'), id: entityId, patch: record }).strict(),
  z.object({ op: z.literal('event.remove'), id: entityId }).strict(),
  z.object({ op: z.literal('mode.set'), mode: record }).strict(),
  z.object({ op: z.literal('mode.remove'), id: entityId }).strict(),
  z.object({ op: z.literal('rule.set'), rule: record }).strict(),
  z.object({ op: z.literal('rule.remove'), id: entityId }).strict(),
  z.object({ op: z.literal('edit.add'), edit: record }).strict(),
  z.object({ op: z.literal('edit.update'), id: entityId, patch: record }).strict(),
  z.object({ op: z.literal('edit.remove'), id: entityId }).strict(),
  z.object({ op: z.literal('route.draw'), legId: entityId, path: line }).strict(),
  z.object({ op: z.literal('route.redraw'), legId: entityId, hint: z.string().max(2000).optional() }).strict(),
  z
    .object({
      op: z.literal('proposal.decide'),
      id: entityId,
      decision: z.enum(['accepted', 'rejected', 'deferred']),
      ops: z.array(z.unknown()).max(20).optional(),
      candidate: z.number().int().min(0).max(20).optional(),
    })
    .strict(),
  z.object({ op: z.literal('constraint.drop'), eventId: entityId, field: z.string().min(1).max(32), reason: z.string().min(1).max(500) }).strict(),
  z.object({ op: z.literal('world.set'), patch: record }).strict(),
]);

export const OpsBody = z
  .object({
    baseRevision: z.number().int().min(-1).optional(),
    // 一次别塞太多：大批量更容易被写成非法 JSON（探索台验收时踩过）。
    ops: z.array(OpInput).min(1).max(40),
  })
  .strict();

export const ImportBody = z.union([
  z
    .object({
      source: z.literal('osm'),
      bbox: z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]),
    })
    .strict(),
  z.object({ source: z.literal('azgaar'), assetId: z.string().uuid() }).strict(),
]);

export const AssetBody = z
  .object({
    name: z.string().min(1).max(200),
    // Azgaar 导出的 Routes GeoJSON 文本；超过这个长度先拆，不要塞进一个请求。
    content: z.string().min(2).max(8_000_000),
    format: z.enum(['geojson', 'map']).default('geojson'),
  })
  .strict();

export const VersionBody = z.object({ summary: z.string().max(300).default('') }).strict();

export const TracksQuery = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  entityIds: z.string().optional(),
});

export { geometry, timeInput };
