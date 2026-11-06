/**
 * 五类检查（design/prd/19-creative.md §4、20-creative-contract.md §1「检查」）。
 *
 * 判定只用程序能确定的东西：Allen 时间区间 + 边表路程。结果分四档，
 * 另加「本次查过、未发现」：红 hard、黄 suspect（按未确认推断路线算出来的）、
 * 信息不足、未覆盖。未知值不当 0，也不把「没发现」说成「没矛盾」。
 *
 * 每条冲突都带服务端生成的修法（ops + 预览）：页面点接受就提交这批 ops，再重查。
 */

import { createHash } from 'node:crypto';
import type {
  CheckRun,
  CreativeOp,
  CreativeConflict,
  ConflictKind,
  Entity,
  Fix,
  CreativeRouteLeg,
  WorldEvent,
} from '@reinlab/contracts';
import { minutesToHuman, overlapOf } from './allen';
import { boundsOf, labelsOf, narrativeLabel, placeLevelLabel } from './labels';
import { gapsOf, placeChain, type CreativeDocument } from './world';

export type CheckInput = {
  document: CreativeDocument;
  legs: CreativeRouteLeg[];
  revision: number;
  now: string;
  /** 只看这些事件（增量检查）；不传就是全量。 */
  only?: string[];
};

const hash = (value: string) => createHash('sha1').update(value).digest('hex').slice(0, 12);
/** 修法里的 op 用宽松对象写，出口统一按 CreativeOp 收窄（事件时间补丁是原文写法）。 */
const asOp = (value: unknown): CreativeOp => value as CreativeOp;
const conflictId = (kind: ConflictKind, ids: string[]) =>
  `cf_${kind.slice(0, 2)}_${hash(kind + '|' + [...ids].sort().join(','))}`;

/** 只是首尾相接（12:00 结束、12:00 开始）不算同时在两处。 */
const positive = (overlap: { start: number; end: number } | null) =>
  overlap && overlap.end > overlap.start ? overlap : null;

const overlapPositive = (a: { start: number; end: number }, b: { start: number; end: number }) =>
  positive(overlapOf(a, b));

const boundsOfEvent = (event: WorldEvent) => ({
  start: boundsOf(event.start).start,
  end: boundsOf(event.end).end,
});

const physicallyThere = (event: WorldEvent, entityId: string): boolean => {
  const participant = event.participants.find((item) => item.entityId === entityId);
  return Boolean(participant && (participant.as === 'actor' || participant.as === 'present'));
};

const PLACE_ORDER: Record<string, number> = {
  world: 0, region: 1, city: 2, site: 3, building: 4, floor: 5, room: 6,
};
/** 某个层级的下一层；最深的房间没有下一层（那就不提「降一层」这个修法）。 */
const NEXT_LEVEL: Record<string, 'region' | 'city' | 'building' | 'floor' | 'room'> = {
  world: 'region', region: 'city', city: 'building', building: 'floor', floor: 'room',
};

const placeOf = (document: CreativeDocument, id: string | null): Entity | undefined =>
  id ? document.entities.find((item) => item.id === id && item.kind === 'place') : undefined;

const nameOf = (document: CreativeDocument, id: string) =>
  document.entities.find((item) => item.id === id)?.name ?? '已删除的地点';

const eventTitleOf = (document: CreativeDocument) => (id: string) =>
  document.events.find((item) => item.id === id)?.title ?? id;

export function runCheck(input: CheckInput): CheckRun {
  const { document, legs } = input;
  const conflicts: CreativeConflict[] = [];
  const eventTitle = eventTitleOf(document);

  const persons = document.entities.filter((entity) => entity.kind === 'person');
  const eventsOfPerson = (entityId: string) =>
    document.events
      .filter((event) => physicallyThere(event, entityId))
      .map((event) => ({ event, ...boundsOfEvent(event) }))
      .sort((a, b) => (a.start ?? Number.MAX_SAFE_INTEGER) - (b.start ?? Number.MAX_SAFE_INTEGER));

  const checkable = new Set<ConflictKind>();
  for (const person of persons) if (eventsOfPerson(person.id).length > 1) checkable.add('double_location');
  if (legs.some((leg) => leg.kind !== 'none' && leg.durationMin !== null)) checkable.add('travel_time');
  if (persons.some((person) => person.person?.died)) checkable.add('dead_appearance');
  if (document.events.some((event) => event.kind === 'interaction')) checkable.add('presence');
  if (document.entities.some((entity) => entity.kind === 'place')) checkable.add('place_hierarchy');

  // ── 1 同时异地：同一人物在重叠时间被要求处于不相容的位置 ──
  for (const person of persons) {
    const items = eventsOfPerson(person.id).filter(
      (item) => item.event.placeId && item.start !== null && item.end !== null,
    );
    for (let i = 0; i < items.length; i += 1)
      for (let j = i + 1; j < items.length; j += 1) {
        const a = items[i];
        const b = items[j];
        const overlap = overlapPositive({ start: a.start!, end: a.end! }, { start: b.start!, end: b.end! });
        if (!overlap) continue;
        if (a.event.placeId === b.event.placeId) continue;
        // 互动活动里的「要求在场」归在场互动那一类，两处都报就成了同一个问题报两次。
        if (a.event.kind === 'interaction' || b.event.kind === 'interaction') continue;
        const chainA = placeChain(document, a.event.placeId);
        const chainB = placeChain(document, b.event.placeId);
        // 父子地点本身不算同时异地（PRD §4）。
        if (chainA.includes(b.event.placeId!) || chainB.includes(a.event.placeId!)) continue;
        const ids = [person.id, a.event.id, b.event.id];
        const span = overlap.end - overlap.start;
        conflicts.push({
          id: conflictId('double_location', ids),
          kind: 'double_location',
          severity: 'hard',
          entityIds: [person.id],
          eventIds: [a.event.id, b.event.id],
          why: `${person.name}在 ${minutesToHuman(span)} 里同时被写成在「${nameOf(document, a.event.placeId!)}」和「${nameOf(document, b.event.placeId!)}」。`,
          numbers: { haveMin: span },
          fixes: [
            moveFix('move_this', b.event, b.start! + span + 60, labelsOf(document.calendars, b.event.start.calendar), eventTitle),
            {
              id: `fx_${hash(b.event.id + ':place-drop')}`,
              label: `把「${b.event.title}」的地点留空（删掉这条位置约束）`,
              kind: 'drop_constraint',
              ops: [{ op: 'constraint.drop', eventId: b.event.id, field: 'place', reason: '作者确认这段时间的地点待定' }],
              preview: [
                {
                  eventId: b.event.id,
                  field: '地点',
                  before: nameOf(document, b.event.placeId ?? ''),
                  after: '空',
                },
              ],
            },
          ],
        });
      }
  }

  // ── 2 路程耗时：相邻两件事之间沿可用路线来不来得及 ──
  for (const leg of legs) {
    const fromEvent = document.events.find((item) => item.id === leg.fromEventId);
    const toEvent = document.events.find((item) => item.id === leg.toEventId);
    if (!fromEvent || !toEvent) continue;
    if (leg.kind === 'none' || leg.durationMin === null) continue;
    const departure = boundsOf(fromEvent.end).end ?? boundsOf(fromEvent.end).start;
    const arrival = boundsOf(toEvent.start).start;
    if (departure === null || arrival === null) continue;
    const haveMin = arrival - departure;
    if (haveMin >= leg.durationMin) continue;
    const needMin = leg.durationMin;
    const entity = document.entities.find((item) => item.id === leg.entityId);
    const ids = [leg.entityId, leg.fromEventId, leg.toEventId];
    const fixes: Fix[] = [
      moveFix('move_this', toEvent, departure + needMin + 30, labelsOf(document.calendars, toEvent.start.calendar), eventTitle),
      {
        id: `fx_${hash(fromEvent.id + ':end:' + (arrival - needMin - 30))}`,
        label: `把「${fromEvent.title}」的结束时间提前到 ${labelsOf(document.calendars, fromEvent.end.calendar).say(arrival - needMin - 30)}`,
        kind: 'move_other',
        ops: [
          asOp({
            op: 'event.update',
            id: fromEvent.id,
            patch: { end: { input: labelsOf(document.calendars, fromEvent.end.calendar).input(arrival - needMin - 30) } },
          }),
        ],
        preview: [
          {
            eventId: fromEvent.id,
            field: '结束时间',
            before: fromEvent.end.label,
            after: labelsOf(document.calendars, fromEvent.end.calendar).say(arrival - needMin - 30),
          },
        ],
      },
    ];
    if (leg.kind === 'inferred' && leg.inferred)
      fixes.push({
        id: `fx_${hash(ids.join(',') + ':confirm')}`,
        label: '确认这条推断路线（确认后按正式路网复查）',
        kind: 'other',
        ops: [{ op: 'proposal.decide', id: leg.inferred.proposalId, decision: 'accepted' }],
        preview: [{ field: '路线', before: '推断路线（虚线）', after: '正式路线' }],
      });
    conflicts.push({
      id: conflictId('travel_time', ids),
      kind: 'travel_time',
      severity: leg.kind === 'inferred' ? 'suspect' : 'hard',
      entityIds: [leg.entityId],
      eventIds: [leg.fromEventId, leg.toEventId],
      legIds: [leg.id],
      why: `${entity?.name ?? '这个人'}从「${eventTitle(leg.fromEventId)}」到「${eventTitle(leg.toEventId)}」需要 ${minutesToHuman(needMin)}，中间只有 ${minutesToHuman(Math.max(0, haveMin))}${leg.kind === 'inferred' ? '（按推断路线估算，还没有确认）' : ''}。`,
      numbers: { needMin, haveMin: Math.max(0, haveMin) },
      fixes,
    });
  }

  // ── 3 生死状态：死亡之后的实际出场（回忆、传闻、梦境不算复活）──
  for (const person of persons) {
    const deathEventId = person.person?.died ?? null;
    if (!deathEventId) continue;
    const deathEvent = document.events.find((event) => event.id === deathEventId);
    const deathT = deathEvent ? boundsOf(deathEvent.start).start : null;
    if (deathT === null) continue;
    const resurrection = document.rules.find((rule) => {
      if (rule.machine?.kind !== 'resurrection') return false;
      const from = Number(rule.machine.params?.from ?? Number.NaN);
      return Number.isFinite(from) ? from <= deathT : true;
    });
    if (resurrection) continue;
    for (const event of document.events) {
      if (!physicallyThere(event, person.id) || event.narrative !== 'fact') continue;
      const start = boundsOf(event.start).start;
      if (start === null || start <= deathT) continue;
      const ids = [person.id, deathEventId, event.id];
      conflicts.push({
        id: conflictId('dead_appearance', ids),
        kind: 'dead_appearance',
        severity: 'hard',
        entityIds: [person.id],
        eventIds: [deathEventId, event.id],
        why: `${person.name}在「${deathEvent ? deathEvent.title : '死亡'}」之后又实际出场（「${event.title}」）。`,
        fixes: [
          {
            id: `fx_${hash(ids.join(',') + ':flashback')}`,
            label: '把这次出场标成回忆',
            kind: 'other',
            ops: [{ op: 'event.update', id: event.id, patch: { narrative: 'flashback' } }],
            preview: [
              {
                eventId: event.id,
                field: '叙述性质',
                before: narrativeLabel(event.narrative),
                after: narrativeLabel('flashback'),
              },
            ],
          },
          {
            id: `fx_${hash(ids.join(',') + ':no-death')}`,
            label: '不把那条事件当作死亡（删掉这个约束）',
            kind: 'drop_constraint',
            ops: [{ op: 'constraint.drop', eventId: deathEventId, field: 'died', reason: '作者确认这不是死亡' }],
            preview: [
              {
                eventId: deathEventId,
                field: '人物死亡',
                before: `${person.name}死于这条事件`,
                after: '不记死亡',
              },
            ],
          },
        ],
      });
    }
  }

  // ── 4 在场互动：要求在场的互动参与者与位置记录不相容 ──
  for (const event of document.events) {
    if (event.kind !== 'interaction' && event.kind !== 'stay') continue;
    const here = boundsOfEvent(event);
    const hereStart = here.start;
    const hereEnd = here.end;
    if (hereStart !== null && hereEnd !== null)
      for (const participant of event.participants) {
        if (participant.as !== 'present') continue;
        const person = document.entities.find((item) => item.id === participant.entityId);
        if (!person) continue;
        for (const other of eventsOfPerson(person.id)) {
          if (other.event.id === event.id) continue;
          if (!other.event.placeId || other.start === null || other.end === null) continue;
          if (other.event.placeId === event.placeId) continue;
          const overlap = overlapPositive({ start: hereStart, end: hereEnd }, { start: other.start, end: other.end });
          if (!overlap) continue;
          const chainHere = placeChain(document, event.placeId);
          const chainOther = placeChain(document, other.event.placeId);
          if (chainHere.includes(other.event.placeId) || chainOther.includes(event.placeId!)) continue;
          const ids = [person.id, event.id, other.event.id];
          conflicts.push({
            id: conflictId('presence', ids),
            kind: 'presence',
            severity: 'hard',
            entityIds: [person.id],
            eventIds: [event.id, other.event.id],
            why: `「${event.title}」要求${person.name}在场，但同一时间他被记录在「${nameOf(document, other.event.placeId)}」。`,
            fixes: [
              moveFix('move_this', event, other.end + 30, labelsOf(document.calendars, event.start.calendar), eventTitle),
              {
                id: `fx_${hash(ids.join(',') + ':mention')}`,
                label: `把${person.name}改成「被提及」，不算在场`,
                kind: 'other',
                ops: [
                  {
                    op: 'event.update',
                    id: event.id,
                    patch: {
                      participants: event.participants.map((item) =>
                        item.entityId === person.id ? { ...item, as: 'mentioned' as const } : item,
                      ),
                    },
                  },
                ],
                preview: [{ eventId: event.id, field: `${person.name}的参与方式`, before: '在场', after: '被提及' }],
              },
            ],
          });
        }
      }
    if (event.participants.some((item) => item.as === 'remote')) {
      const hasRemoteRule = document.rules.some((rule) => rule.machine?.kind === 'remote_presence');
      if (!hasRemoteRule)
        conflicts.push({
          id: conflictId('presence', [event.id, 'remote']),
          kind: 'presence',
          severity: 'hard',
          entityIds: event.participants
            .filter((item) => item.as === 'remote')
            .map((item) => item.entityId)
            .filter((value): value is string => Boolean(value)),
          eventIds: [event.id],
          why: `「${event.title}」里有远程参与，但世界观还没有一条说明远程方式的规则，程序判不了。`,
          fixes: [
            {
              id: `fx_${hash(event.id + ':remote-rule')}`,
              label: '加一条远程参与规则',
              kind: 'other',
              ops: [
                {
                  op: 'rule.set',
                  rule: {
                    id: 'rule-remote',
                    text: '远程参与：借传声或托梦在同一时间出现，不算本人到场。',
                    machine: { kind: 'remote_presence', params: {} },
                  },
                },
              ],
              preview: [{ field: '规则', before: '没有远程规则', after: '远程参与规则' }],
            },
          ],
        });
    }
  }

  // ── 5 地点层级与连接（房间归属、空间连接）──
  for (const place of document.entities) {
    if (place.kind !== 'place' || !place.place) continue;
    const level = place.place.level;
    const parent = placeOf(document, place.place.parentId);
    if (place.place.parentId && !parent) {
      const ids = [place.id, 'parent-missing'];
      conflicts.push({
        id: conflictId('place_hierarchy', ids),
        kind: 'place_hierarchy',
        severity: 'hard',
        entityIds: [place.id],
        eventIds: [],
        why: `「${place.name}」的上级地点不在了，归属对不上。`,
        fixes: [
          {
            id: `fx_${hash(ids.join(',') + ':clear')}`,
            label: '先把它当作没有上级',
            kind: 'drop_constraint',
            ops: [{ op: 'entity.update', id: place.id, patch: { place: { ...place.place, parentId: null } } }],
            preview: [{ field: '上级地点', before: '已删除的地点', after: '空' }],
          },
        ],
      });
      continue;
    }
    if (parent?.place && level !== 'site') {
      const childRank = PLACE_ORDER[level] ?? 3;
      const parentRank = PLACE_ORDER[parent.place.level] ?? 3;
      if (childRank <= parentRank) {
        const ids = [place.id, parent.id, 'level'];
        conflicts.push({
          id: conflictId('place_hierarchy', ids),
          kind: 'place_hierarchy',
          severity: 'hard',
          entityIds: [place.id, parent.id],
          eventIds: [],
          why: `「${place.name}」（${placeLevelLabel(level)}）挂在「${parent.name}」（${placeLevelLabel(parent.place.level)}）下面，层级反了。`,
          fixes: (() => {
            const next = NEXT_LEVEL[parent.place.level];
            // 最深的层级（房间）没有「下一层」：这种反挂就给不出自动修法，交给作者。
            if (!next) return [];
            return [
              {
                id: `fx_${hash(ids.join(',') + ':level')}`,
                label: `把「${place.name}」改成「${parent.name}」的下一层（${placeLevelLabel(next)}）`,
                kind: 'other' as const,
                ops: [
                  {
                    op: 'entity.update' as const,
                    id: place.id,
                    patch: { place: { ...place.place, level: next } },
                  },
                ],
                preview: [
                  {
                    field: '层级',
                    before: placeLevelLabel(level),
                    after: placeLevelLabel(next),
                  },
                ],
              },
            ];
          })(),
        });
      }
    }
    for (const connect of place.place.connects ?? []) {
      const target = connect.to === place.id ? place : placeOf(document, connect.to);
      if (target && connect.to !== place.id) {
        if (target.place) continue;
      }
      const ids = [place.id, connect.to];
      const self = connect.to === place.id;
      conflicts.push({
        id: conflictId('place_hierarchy', ids),
        kind: 'place_hierarchy',
        severity: 'hard',
        entityIds: [place.id],
        eventIds: [],
        why: self
          ? `「${place.name}」被写成和自己相通。`
          : `「${place.name}」连着一个不存在的地点。`,
        fixes: [
          {
            id: `fx_${hash(ids.join(',') + ':drop')}`,
            label: self ? '删掉这条自己的连接' : '删掉这条对不上的连接',
            kind: 'drop_constraint',
            ops: [
              {
                op: 'entity.update',
                id: place.id,
                patch: {
                  place: {
                    ...place.place,
                    connects: (place.place.connects ?? []).filter((item) => item.to !== connect.to),
                  },
                },
              },
            ],
            preview: [{ field: '连接', before: self ? `${place.name} ↔ ${place.name}` : '已删除的地点', after: '空' }],
          },
        ],
      });
    }
    // 房间要有归属：没写上级时，人物进了房间也归不到建筑（PRD §3）。
    if (level === 'room' && !parent) {
      const ids = [place.id, 'room-parent'];
      const building = nearestBuilding(document, place.id);
      conflicts.push({
        id: conflictId('place_hierarchy', ids),
        kind: 'place_hierarchy',
        severity: 'hard',
        entityIds: [place.id],
        eventIds: [],
        why: `房间「${place.name}」还没写属于哪栋楼，人物进了房间也归不到建筑。`,
        fixes: building
          ? [
              {
                id: `fx_${hash(ids.join(',') + ':building')}`,
                label: `把「${building.name}」设为它的上级`,
                kind: 'other',
                ops: [
                  { op: 'entity.update', id: place.id, patch: { place: { ...place.place, parentId: building.id } } },
                ],
                preview: [{ field: '上级地点', before: '空', after: building.name }],
              },
            ]
          : [],
      });
    }
  }

  // ── 信息不足与未覆盖 ──
  const insufficient = document.events
    .map((event) => ({ eventId: event.id, gaps: gapsOf(event, document) }))
    .filter((item) => item.gaps.length > 0);
  for (const leg of legs) {
    if (leg.kind !== 'none' || !leg.failure) continue;
    const gap = `路线待定：${leg.failure}`;
    const entry = insufficient.find((item) => item.eventId === leg.toEventId);
    if (entry) {
      if (!entry.gaps.includes(gap)) entry.gaps.push(gap);
    } else insufficient.push({ eventId: leg.toEventId, gaps: [gap] });
  }
  const uncovered = document.rules
    .filter((rule) => !rule.machine)
    .map((rule) => ({ ruleId: rule.id, why: '这条规则还是自然语言，程序判不了，检查里按「未覆盖」显示。' }));

  const kinds: ConflictKind[] = ['double_location', 'travel_time', 'dead_appearance', 'presence', 'place_hierarchy'];
  const conflicted = new Set(conflicts.map((item) => item.kind));
  const only = input.only?.length ? new Set(input.only) : null;
  const scoped = only
    ? conflicts.filter((item) => !item.eventIds.length || item.eventIds.some((id) => only.has(id)))
    : conflicts;
  return {
    id: `ck_${hash(String(input.revision) + '|' + input.now)}`,
    at: input.now,
    revision: input.revision,
    conflicts: scoped,
    insufficient,
    uncovered,
    clean: kinds.filter((kind) => checkable.has(kind) && !conflicted.has(kind)),
  };
}

/** 挪事件：开始和结束一起挪，保住原来那段时长（只改开始会让结束早于开始）。 */
function moveFix(
  kind: 'move_this' | 'move_other',
  event: WorldEvent,
  to: number,
  labels: ReturnType<typeof labelsOf>,
  eventTitle: (id: string) => string,
): Fix {
  const start = boundsOf(event.start).start;
  const end = boundsOf(event.end).end;
  const duration = start !== null && end !== null ? Math.max(0, end - start) : null;
  const patch: Record<string, unknown> = { start: { input: labels.input(to) } };
  const preview = [
    { eventId: event.id, field: '开始时间', before: event.start.label, after: labels.say(to) },
  ];
  if (duration !== null) {
    patch.end = { input: labels.input(to + duration) };
    preview.push({ eventId: event.id, field: '结束时间', before: event.end.label, after: labels.say(to + duration) });
  }
  return {
    id: `fx_${hash(event.id + ':' + kind + ':' + to)}`,
    label: `把「${eventTitle(event.id)}」挪到 ${labels.say(to)}`,
    kind,
    ops: [asOp({ op: 'event.update', id: event.id, patch })],
    preview,
  };
}

function nearestBuilding(document: CreativeDocument, placeId: string): Entity | undefined {
  const chain = placeChain(document, placeId);
  for (const id of chain.slice(1)) {
    const found = document.entities.find((item) => item.id === id);
    if (found?.place?.level === 'building') return found;
  }
  // 没写上级时只能给一个候选：世界里有且只有一个建筑才提出这个修法，
  // 多个建筑就留空（那就是「不知道属于哪栋」，不该乱猜）。
  const buildings = document.entities.filter((item) => item.kind === 'place' && item.place?.level === 'building');
  return buildings.length === 1 ? buildings[0] : undefined;
}
