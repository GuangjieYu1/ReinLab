/**
 * 设定条目与版本差异（1C 契约 §6.1、§6.2）。
 *
 * 条目就是带稳定 id 的一样东西：实体、关系、事件、交通方式、规则、改造层。
 * 版本差异按 id 比两份文档，得出新增 / 修改 / 删除，并列出改了哪些字段（人话）。
 * 纯计算，不碰数据库。
 */

import type { CreativeDocument } from './world';
import type { ItemChange, ItemKind } from '@reinlab/contracts';

export const ITEM_KINDS: ItemKind[] = ['entity', 'relation', 'event', 'mode', 'rule', 'edit'];

const ARRAY_FIELD: Record<ItemKind, keyof CreativeDocument> = {
  entity: 'entities',
  relation: 'relations',
  event: 'events',
  mode: 'modes',
  rule: 'rules',
  edit: 'edits',
};

type AnyItem = { id: string } & Record<string, unknown>;

export type ItemRecord = { kind: ItemKind; value: AnyItem };

export function itemsOf(document: CreativeDocument): ItemRecord[] {
  const out: ItemRecord[] = [];
  for (const kind of ITEM_KINDS)
    for (const value of document[ARRAY_FIELD[kind]] as unknown as AnyItem[]) out.push({ kind, value });
  return out;
}

export function itemMapOf(document: CreativeDocument): Map<string, ItemRecord> {
  return new Map(itemsOf(document).map((item) => [item.value.id, item]));
}

const KIND_LABEL: Record<ItemKind, string> = {
  entity: '实体',
  relation: '关系',
  event: '事件',
  mode: '交通方式',
  rule: '规则',
  edit: '改造层',
};

const ENTITY_KIND_LABEL: Record<string, string> = { person: '人物', place: '地点', item: '物件', org: '组织' };

/** 给人看的标题。 */
export function titleOf(kind: ItemKind, value: AnyItem): string {
  if (kind === 'entity')
    return `${String(value.name ?? value.id)}（${ENTITY_KIND_LABEL[String(value.kind)] ?? '实体'}）`;
  if (kind === 'event') return `${String(value.title ?? value.id)}（事件）`;
  if (kind === 'relation') return `${String(value.label ?? value.id)}（关系）`;
  if (kind === 'mode') return `${String(value.name ?? value.id)}（交通方式）`;
  if (kind === 'rule') return `${String(value.text ?? value.id).slice(0, 14)}（规则）`;
  return `${String(value.title ?? value.id)}（改造层）`;
}

/** 字段名 → 人话。没登记的按原名给，不编。 */
const FIELD_LABELS: Record<string, string> = {
  name: '名称',
  title: '标题',
  what: '经过',
  aliases: '别名',
  summary: '简介',
  kind: '种类',
  status: '确认状态',
  origin: '出处',
  place: '地点信息',
  placeId: '地点',
  placeName: '地点',
  person: '人物信息',
  participants: '参与者',
  start: '开始时间',
  end: '结束时间',
  travel: '行程',
  narrative: '叙述性质',
  workRefs: '作品引用',
  gaps: '缺口',
  a: '一方',
  b: '另一方',
  label: '名称',
  from: '起始',
  to: '结束',
  kmPerHour: '速度',
  network: '所用路网',
  note: '备注',
  text: '规则正文',
  machine: '可判定条件',
  effect: '改造效果',
  target: '改造目标',
  geometry: '几何',
  props: '样式与名称',
  passable: '通行性',
  valid: '生效时间',
  needsRemap: '目标是否对不上',
};

/** 两个条目里哪些顶层字段变了（人话，去重，按固定顺序）。 */
export function changedFields(before: AnyItem | null, after: AnyItem | null): string[] {
  if (!before || !after) return [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const fields: string[] = [];
  for (const key of keys) {
    if (key === 'setting') continue;
    if (JSON.stringify(before[key] ?? null) === JSON.stringify(after[key] ?? null)) continue;
    const label = FIELD_LABELS[key] ?? key;
    if (!fields.includes(label)) fields.push(label);
  }
  return fields;
}

/** 两份世界观文档之间的条目差异；顺序按「先事件/实体，后其它」方便人读。 */
export function diffDocuments(from: CreativeDocument, to: CreativeDocument): ItemChange[] {
  const before = itemMapOf(from);
  const after = itemMapOf(to);
  const changes: ItemChange[] = [];
  for (const kind of ITEM_KINDS) {
    const ids = new Set(
      [...before.values(), ...after.values()].filter((item) => item.kind === kind).map((item) => item.value.id),
    );
    for (const id of ids) {
      const a = before.get(id);
      const b = after.get(id);
      if (!a && !b) continue;
      if (a && b) {
        if (JSON.stringify(a.value) === JSON.stringify(b.value)) continue;
        changes.push({
          itemId: id,
          kind,
          title: titleOf(kind, b.value),
          change: 'update',
          before: a.value,
          after: b.value,
          fields: changedFields(a.value, b.value),
        });
        continue;
      }
      const value = (b ?? a)!.value;
      changes.push({
        itemId: id,
        kind,
        title: titleOf(kind, value),
        change: b ? 'add' : 'remove',
        before: a ? a.value : null,
        after: b ? b.value : null,
        fields: [],
      });
    }
  }
  // 事件和实体在前：作者最关心它们
  const order: Record<ItemKind, number> = { event: 0, entity: 1, mode: 2, rule: 3, edit: 4, relation: 5 };
  return changes.sort((x, y) => order[x.kind] - order[y.kind] || x.title.localeCompare(y.title));
}

/** 把一条条目的某一版内容写进文档（value=null 表示这一版里没有它，即删除）。 */
export function putItem(document: CreativeDocument, kind: ItemKind, itemId: string, value: AnyItem | null): void {
  const field = ARRAY_FIELD[kind];
  const list = document[field] as unknown as AnyItem[];
  const index = list.findIndex((item) => item.id === itemId);
  if (value === null) {
    if (index >= 0) (document[field] as unknown as AnyItem[]).splice(index, 1);
    return;
  }
  if (index >= 0) list[index] = value;
  else list.push(value);
}

/** 一批条目的简易指纹：用来判「两个版本在这条条目上是不是同一份内容」。 */
export function fingerprint(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export { KIND_LABEL };
