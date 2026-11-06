/**
 * 世界观账本（design/prd/20-creative-contract.md §1.1）。
 *
 * 整份账本存成一份 document（jsonb），一个批次在同一个事务里改完，revision +1。
 * 这里只做纯计算：不碰数据库、不碰网络，测试直接拿 fixture 跑。
 *
 * 三类东西不落进 document：路网边（pgRouting 表）、检查结果（creative_check）、版本快照。
 * 它们由服务层带着 revision 写，读的时候再拼回快照。
 */

import { randomUUID } from 'node:crypto';
import type {
  CreativeAppliedOp,
  CreativeBasemap,
  Calendar,
  CreativeCny,
  Entity,
  MapEdit,
  NetworkStatus,
  CreativeOp,
  PlaceLevel,
  Proposal,
  Relation,
  CreativeRouteLeg,
  StoryTime,
  TransportMode,
  World,
  WorldEvent,
  WorldRule,
  GeoJSON,
} from '@reinlab/contracts';
import { ApiFailure } from '../api/errors';
import { boundsOf, parseStoryTime, type StoryTimeContext } from './story-time';

export type RoutePathEntry = { legId: string; path: GeoJSON.LineString };

export type InferredRoute = {
  legId: string;
  proposalId: string;
  path: GeoJSON.LineString;
  why: string;
  sources: { title: string; url?: string }[];
};

export type CreativeDocument = {
  title: string;
  basemap: CreativeBasemap;
  calendars: Calendar[];
  entities: Entity[];
  relations: Relation[];
  events: WorldEvent[];
  modes: TransportMode[];
  rules: WorldRule[];
  edits: MapEdit[];
  proposals: Proposal[];
  /** 作者手绘或已确认的路线（正式路线）。 */
  manualRoutes: RoutePathEntry[];
  /** AI 推断出来、作者还没确认的路线：立即参与轨迹和检查，画虚线。 */
  inferredRoutes: InferredRoute[];
  /** 算不出路的原因（人话），按 leg 记。 */
  routeFailures: { legId: string; failure: string }[];
  network: NetworkStatus;
  /** 路网状态是什么时候变的：控制面重启后据此判断哪些导入卡死了（1A 遗留 3）。 */
  networkUpdatedAt?: string | null;
  usage: CreativeCny;
};

export const GREGORIAN: Calendar = { id: 'gregorian', name: '公历', kind: 'gregorian' };
export const CUSTOM_ERA: Calendar = { id: 'custom', name: '自定义纪元', kind: 'custom', note: '第 1 日 = 纪元第一天' };

export function emptyDocument(title: string): CreativeDocument {
  return {
    title,
    basemap: { kind: 'blank', scaleKmPerUnit: null },
    calendars: [{ ...GREGORIAN }, { ...CUSTOM_ERA }],
    entities: [],
    relations: [],
    events: [],
    modes: [
      { id: 'walk', name: '步行', kmPerHour: 4.5, network: 'road' },
      { id: 'horse', name: '骑马', kmPerHour: 12, network: 'road' },
      { id: 'cart', name: '马车', kmPerHour: 8, network: 'road' },
      { id: 'boat', name: '乘船', kmPerHour: 6, network: 'water' },
    ],
    rules: [],
    edits: [],
    proposals: [],
    manualRoutes: [],
    inferredRoutes: [],
    routeFailures: [],
    network: { state: 'none', sources: [] },
    usage: { value: 0, known: true },
  };
}

const PLACE_LEVELS: PlaceLevel[] = ['world', 'region', 'city', 'building', 'floor', 'room', 'site'];
const ENTITY_KINDS = ['person', 'place', 'item', 'org'] as const;
const LIFECYCLE_FIELDS = ['start', 'end', 'place', 'died', 'presence', 'narrative', 'parent'] as const;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const fail = (code: string, status: 400 | 404 | 409 | 422, message: string, extra?: Record<string, unknown>) =>
  new ApiFailure(code, status, message, extra);

/** 原文时间上下文：解析相对时间要能看见已有事件。 */
export function timeContext(document: CreativeDocument, defaultCalendar?: string): StoryTimeContext {
  return {
    calendars: document.calendars,
    events: document.events.map((event) => ({ id: event.id, title: event.title, start: event.start })),
    ...(defaultCalendar ? { defaultCalendar } : {}),
  };
}

function parseInput(
  document: CreativeDocument,
  input: { input: string; calendar?: string },
  field: string,
): StoryTime {
  const parsed = parseStoryTime(input.input, timeContext(document, input.calendar));
  if (!parsed.ok)
    throw fail('TIME_UNPARSED', 422, `${field}：${parsed.failure.message}`, { candidates: [] });
  return parsed.value;
}

/** 改造层的生效时间段：既能接原文写法，也能接已经解析好的 StoryTime，null 就是一直。 */
function parseOptionalTime(
  document: CreativeDocument,
  value: unknown,
  field: string,
): StoryTime | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && 'input' in (value as Record<string, unknown>))
    return parseInput(
      document,
      value as { input: string; calendar?: string },
      field,
    );
  if (typeof value === 'object' && 'certainty' in (value as Record<string, unknown>))
    return value as StoryTime;
  throw fail('INVALID_INPUT', 400, `${field}写法不认识。`);
}

function findEntity(document: CreativeDocument, id: string): Entity {
  const found = document.entities.find((item) => item.id === id);
  if (!found) throw fail('ENTITY_NOT_FOUND', 404, '这个人物或地点已经不在了。');
  return found;
}

function findEvent(document: CreativeDocument, id: string): WorldEvent {
  const found = document.events.find((item) => item.id === id);
  if (!found) throw fail('EVENT_NOT_FOUND', 404, '这条事件已经不在了。');
  return found;
}

/** 事件缺什么会导致检查做不了：服务端写进 gaps，页面照实显示。 */
export function gapsOf(event: WorldEvent, document: CreativeDocument): string[] {
  const gaps: string[] = [];
  const bounds = { start: boundsOf(event.start).start, end: boundsOf(event.end).end };
  if (bounds.start === null || bounds.end === null) gaps.push('起止时间未定');
  if (!event.placeId && event.kind !== 'travel') gaps.push('地点未定');
  if (event.kind === 'travel' && (!event.travel?.fromId || !event.travel?.toId)) gaps.push('起讫地点未定');
  if (event.participants.length === 0) gaps.push('没有参与者');
  for (const participant of event.participants)
    if (!document.entities.some((item) => item.id === participant.entityId))
      gaps.push('参与者已被删除');
  if (event.placeId && !document.entities.some((item) => item.id === event.placeId && item.kind === 'place'))
    gaps.push('地点已被删除');
  return gaps;
}

/** 地点祖先链（含自己），用于父子地点不算同时异地。 */
export function placeChain(document: CreativeDocument, placeId: string | null): string[] {
  const chain: string[] = [];
  let current = document.entities.find((item) => item.id === placeId && item.kind === 'place');
  let guard = 0;
  while (current && guard++ < 16) {
    chain.push(current.id);
    const parent = current.place?.parentId ?? null;
    current = document.entities.find((item) => item.id === parent && item.kind === 'place');
  }
  return chain;
}

function placesRelated(document: CreativeDocument, a: string, b: string): boolean {
  const chainA = placeChain(document, a);
  const chainB = placeChain(document, b);
  return chainA.includes(b) || chainB.includes(a);
}

/** 这批 op 里被改动到的事件：增量检查只看它们和与它们有关的东西。 */
export type ApplyOutcome = {
  next: CreativeDocument;
  applied: CreativeAppliedOp[];
  touchedEvents: string[];
  redraws: { legId: string; hint?: string }[];
};

export type ApplyOptions = {
  actor: 'user' | 'agent';
  ids?: () => string;
  /** 处理结果的时间：作废、接受、拒绝都要记下是什么时候。 */
  at?: string;
};

function summaryOf(op: CreativeOp, document: CreativeDocument): string {
  switch (op.op) {
    case 'entity.add':
      return `建了${labelKind(op.entity.kind)}「${op.entity.name}」`;
    case 'entity.update': {
      const found = document.entities.find((item) => item.id === op.id);
      return `改了「${found?.name ?? op.id}」`;
    }
    case 'entity.remove': {
      const found = document.entities.find((item) => item.id === op.id);
      return `删了「${found?.name ?? op.id}」`;
    }
    case 'event.add':
      return `记了一条事件「${op.event.title}」`;
    case 'event.update': {
      const found = document.events.find((item) => item.id === op.id);
      return `改了事件「${found?.title ?? op.id}」`;
    }
    case 'event.remove': {
      const found = document.events.find((item) => item.id === op.id);
      return `删了事件「${found?.title ?? op.id}」`;
    }
    case 'mode.set':
      return `交通方式「${op.mode.name}」`;
    case 'mode.remove':
      return '删了一个交通方式';
    case 'rule.set':
      return '改了一条规则';
    case 'rule.remove':
      return '删了一条规则';
    case 'edit.add':
      return `加了改造「${op.edit.title}」`;
    case 'edit.update':
      return '改了改造层';
    case 'edit.remove':
      return '删了改造层';
    case 'route.draw':
      return '画了一段路线';
    case 'route.redraw':
      return '让 AI 重画路线';
    case 'proposal.decide':
      return op.decision === 'accepted' ? '接受了一条提议' : op.decision === 'rejected' ? '拒绝了一条提议' : '暂缓了一条提议';
    case 'constraint.drop':
      return '删掉了一条约束';
    case 'world.set':
      return '改了世界设定';
    default:
      return '改了一处';
  }
}

const labelKind = (kind: Entity['kind']) =>
  ({ person: '人物', place: '地点', item: '物件', org: '组织' })[kind];

/**
 * 同一段路只能有一条结论：手绘或重画以后，这段路原来那条推断提议作废（1A 遗留 1）。
 * 返回作废的提议，调用方写进 applied 让页面知道发生了什么，并且不能再确认它。
 */
export function voidRouteProposals(
  document: CreativeDocument,
  legId: string,
  reason: string,
  at: string,
): Proposal[] {
  const voided: Proposal[] = [];
  document.proposals = document.proposals.map((proposal) => {
    if (proposal.kind !== 'route') return proposal;
    if (proposal.status !== 'pending' && proposal.status !== 'deferred') return proposal;
    const belongs =
      document.inferredRoutes.some((route) => route.proposalId === proposal.id && route.legId === legId) ||
      proposal.ops.some((op) => op.op === 'route.draw' && op.legId === legId);
    if (!belongs) return proposal;
    const next: Proposal = {
      ...proposal,
      status: 'rejected',
      resolution: { decision: 'rejected', reason, at, by: 'user' },
    };
    voided.push(next);
    return next;
  });
  return voided;
}

/** 一个批次的纯计算：要么全成，要么抛错（调用方回滚事务）。 */
export function applyOps(
  document: CreativeDocument,
  ops: CreativeOp[],
  options: ApplyOptions,
): ApplyOutcome {
  const next = clone(document);
  const applied: CreativeAppliedOp[] = [];
  const touchedEvents = new Set<string>();
  const redraws: { legId: string; hint?: string }[] = [];
  const ids = options.ids ?? randomUUID;
  const at = options.at ?? new Date().toISOString();

  for (const op of ops) {
    const summary = summaryOf(op, next);
    const opId = ids();
    const push = (result: CreativeAppliedOp['result'], summaryOverride?: string) =>
      applied.push({
        ...(op as CreativeOp),
        opId,
        actor: options.actor,
        summary: summaryOverride ?? summary,
        result,
      });

    switch (op.op) {
      case 'entity.add': {
        if (!ENTITY_KINDS.includes(op.entity.kind))
          throw fail('INVALID_INPUT', 400, '实体的种类只能是人物、地点、物件或组织。');
        if (!op.entity.name?.trim()) throw fail('INVALID_INPUT', 400, '实体要有名字。');
        const entity: Entity = {
          ...(op.entity as Entity),
          id: ids(),
          origin: { basis: 'author', by: 'user' },
          status: 'accepted',
          workRefs: [],
        };
        if (entity.kind === 'place') {
          const place = entity.place ?? {
            level: 'site' as PlaceLevel, parentId: null, geo: null, geoCertainty: 'unlocated' as const, connects: [],
          };
          if (!PLACE_LEVELS.includes(place.level))
            throw fail('INVALID_INPUT', 400, '地点层级只能是世界、区域、城市、建筑、楼层、房间或场所。');
          entity.place = {
            ...place,
            connects: Array.isArray(place.connects) ? place.connects : [],
            geoCertainty: place.geo ? place.geoCertainty ?? 'area' : 'unlocated',
          };
        }
        if (entity.kind === 'person' && !entity.person) entity.person = { born: null, died: null };
        next.entities.push(entity);
        push({ entity });
        break;
      }
      case 'entity.update': {
        const index = next.entities.findIndex((item) => item.id === op.id);
        if (index < 0) throw fail('ENTITY_NOT_FOUND', 404, '这个人物或地点已经不在了。');
        const patch = clone(op.patch ?? {}) as Partial<Entity> & Record<string, unknown>;
        next.entities[index] = {
          ...next.entities[index],
          ...patch,
          id: next.entities[index].id,
          origin: next.entities[index].origin,
          status: patch.status ?? next.entities[index].status,
        };
        push({ entity: next.entities[index] });
        break;
      }
      case 'entity.remove': {
        const entity = findEntity(next, op.id);
        const used: string[] = [];
        for (const event of next.events)
          if (event.placeId === entity.id || event.participants.some((item) => item.entityId === entity.id))
            used.push(`事件「${event.title}」`);
        for (const other of next.entities)
          if (other.place?.parentId === entity.id) used.push(`地点「${other.name}」的上级`);
        for (const relation of next.relations)
          if (relation.a === entity.id || relation.b === entity.id) used.push(`关系「${relation.label}」`);
        if (used.length)
          throw fail('IN_USE', 409, `「${entity.name}」还被引用：${used.slice(0, 5).join('、')}${used.length > 5 ? ` 等 ${used.length} 处` : ''}。先改掉这些再删。`, { references: used.slice(0, 20) });
        next.entities = next.entities.filter((item) => item.id !== entity.id);
        next.edits = next.edits.filter((edit) => edit.target?.placeId !== entity.id);
        push({ removedId: entity.id });
        break;
      }
      case 'relation.add': {
        const relation: Relation = {
          ...(op.relation as Relation),
          id: ids(),
          origin: { basis: 'author', by: 'user' },
          status: 'accepted',
        };
        findEntity(next, relation.a);
        findEntity(next, relation.b);
        next.relations.push(relation);
        push({});
        break;
      }
      case 'relation.update': {
        const index = next.relations.findIndex((item) => item.id === op.id);
        if (index < 0) throw fail('RELATION_NOT_FOUND', 404, '这条关系已经不在了。');
        next.relations[index] = { ...next.relations[index], ...clone(op.patch), id: next.relations[index].id };
        push({});
        break;
      }
      case 'relation.remove': {
        next.relations = next.relations.filter((item) => item.id !== op.id);
        push({ removedId: op.id });
        break;
      }
      case 'event.add': {
        const input = op.event;
        if (!input.title?.trim()) throw fail('INVALID_INPUT', 400, '事件要有标题。');
        if (!input.participants?.length)
          throw fail('INVALID_INPUT', 400, '事件至少要有一个参与者。');
        for (const participant of input.participants) findEntity(next, participant.entityId);
        if (input.placeId) findEntity(next, input.placeId);
        const start = parseInput(next, input.start, '开始时间');
        const end = parseInput(next, input.end, '结束时间');
        const event: WorldEvent = {
          ...(input as unknown as WorldEvent),
          id: ids(),
          start,
          end,
          origin: { basis: 'author', by: 'user' },
          status: 'accepted',
          gaps: [],
          workRefs: [],
        };
        if (boundsOf(start).start !== null && boundsOf(end).end !== null && boundsOf(end).end! < boundsOf(start).start!)
          throw fail('INVALID_INPUT', 400, '结束时间早于开始时间。');
        event.gaps = gapsOf(event, next);
        next.events.push(event);
        touchedEvents.add(event.id);
        push({ event });
        break;
      }
      case 'event.update': {
        const index = next.events.findIndex((item) => item.id === op.id);
        if (index < 0) throw fail('EVENT_NOT_FOUND', 404, '这条事件已经不在了。');
        const patch = clone(op.patch ?? {}) as Record<string, unknown>;
        const startPatch = patch.start as { input: string; calendar?: string } | undefined;
        const endPatch = patch.end as { input: string; calendar?: string } | undefined;
        delete patch.start;
        delete patch.end;
        delete patch.gaps;
        if (Array.isArray(patch.participants))
          for (const participant of patch.participants as { entityId: string }[])
            findEntity(next, participant.entityId);
        if (typeof patch.placeId === 'string') findEntity(next, patch.placeId);
        const merged: WorldEvent = {
          ...next.events[index],
          ...(patch as Partial<WorldEvent>),
          id: next.events[index].id,
        };
        if (startPatch) merged.start = parseInput(next, startPatch, '开始时间');
        if (endPatch) merged.end = parseInput(next, endPatch, '结束时间');
        const s = boundsOf(merged.start).start;
        const e = boundsOf(merged.end).end;
        if (s !== null && e !== null && e < s) throw fail('INVALID_INPUT', 400, '结束时间早于开始时间。');
        merged.gaps = gapsOf(merged, next);
        next.events[index] = merged;
        touchedEvents.add(merged.id);
        push({ event: merged });
        break;
      }
      case 'event.remove': {
        next.events = next.events.filter((item) => item.id !== op.id);
        next.proposals = next.proposals.filter(
          (proposal) => !proposal.ops.some((item) => item.op === 'event.add' && (item as { event?: { title?: string } }).event?.title === op.id),
        );
        push({ removedId: op.id });
        break;
      }
      case 'mode.set': {
        if (!op.mode.name?.trim()) throw fail('INVALID_INPUT', 400, '交通方式要有名字。');
        if (!Number.isFinite(op.mode.kmPerHour) || op.mode.kmPerHour <= 0)
          throw fail('INVALID_INPUT', 400, '速度要大于 0（每小时多少公里）。');
        if (!['road', 'water', 'any', 'none'].includes(op.mode.network))
          throw fail('INVALID_INPUT', 400, '交通方式用的路网只能是道路、水路、任意或不用路网。');
        const index = next.modes.findIndex((item) => item.id === op.mode.id);
        if (index >= 0) next.modes[index] = { ...op.mode };
        else next.modes.push({ ...op.mode });
        push({});
        break;
      }
      case 'mode.remove': {
        next.modes = next.modes.filter((item) => item.id !== op.id);
        push({ removedId: op.id });
        break;
      }
      case 'rule.set': {
        if (!op.rule.text?.trim()) throw fail('INVALID_INPUT', 400, '规则要有正文。');
        const rule: WorldRule = {
          ...op.rule,
          origin: { basis: 'author', by: 'user' },
          status: 'accepted',
        };
        const index = next.rules.findIndex((item) => item.id === rule.id);
        if (index >= 0) next.rules[index] = rule;
        else next.rules.push(rule);
        push({});
        break;
      }
      case 'rule.remove': {
        next.rules = next.rules.filter((item) => item.id !== op.id);
        push({ removedId: op.id });
        break;
      }
      case 'edit.add': {
        const raw = op.edit as MapEdit & { valid?: { from?: unknown; to?: unknown } };
        const edit: MapEdit = {
          ...(op.edit as MapEdit),
          valid: {
            from: parseOptionalTime(next, raw.valid?.from, '生效开始时间'),
            to: parseOptionalTime(next, raw.valid?.to, '生效结束时间'),
          },
          id: ids(),
          origin: { basis: 'author', by: 'user' },
          status: 'accepted',
          needsRemap: needsRemap(op.edit.target, op.edit.effect),
        };
        if (edit.effect === 'add' && !edit.geometry)
          throw fail('INVALID_INPUT', 400, '新增改造要有几何。');
        if (edit.target?.placeId) findEntity(next, edit.target.placeId);
        next.edits.push(edit);
        push({ edit });
        break;
      }
      case 'edit.update': {
        const index = next.edits.findIndex((item) => item.id === op.id);
        if (index < 0) throw fail('EDIT_NOT_FOUND', 404, '这条改造已经不在了。');
        const patch = clone(op.patch) as Partial<MapEdit> & { valid?: { from?: unknown; to?: unknown } };
        if (patch.valid)
          patch.valid = {
            from: parseOptionalTime(next, patch.valid.from, '生效开始时间'),
            to: parseOptionalTime(next, patch.valid.to, '生效结束时间'),
          };
        next.edits[index] = {
          ...next.edits[index],
          ...patch,
          id: next.edits[index].id,
          needsRemap: needsRemap(next.edits[index].target, next.edits[index].effect),
        };
        push({ edit: next.edits[index] });
        break;
      }
      case 'edit.remove': {
        next.edits = next.edits.filter((item) => item.id !== op.id);
        push({ removedId: op.id });
        break;
      }
      case 'route.draw': {
        if (op.path?.type !== 'LineString' || op.path.coordinates.length < 2)
          throw fail('INVALID_INPUT', 400, '手绘路线至少要有两个点。');
        const voided = voidRouteProposals(next, op.legId, '这段路你手绘了，这条推断提议作废。', at);
        next.manualRoutes = [...next.manualRoutes.filter((item) => item.legId !== op.legId), { legId: op.legId, path: clone(op.path) }];
        next.inferredRoutes = next.inferredRoutes.filter((item) => item.legId !== op.legId);
        next.routeFailures = next.routeFailures.filter((item) => item.legId !== op.legId);
        push(
          voided[0] ? { proposal: voided[0] } : {},
          voided.length ? `画了一段路线，作废了同一段的 ${voided.length} 条推断提议` : undefined,
        );
        break;
      }
      case 'route.redraw': {
        redraws.push({ legId: op.legId, ...(op.hint ? { hint: op.hint } : {}) });
        const voided = voidRouteProposals(next, op.legId, '这段路重新让 AI 画，旧推断提议作废。', at);
        next.inferredRoutes = next.inferredRoutes.filter((item) => item.legId !== op.legId);
        next.routeFailures = next.routeFailures.filter((item) => item.legId !== op.legId);
        push(
          voided[0] ? { proposal: voided[0] } : {},
          voided.length ? `让 AI 重画路线，作废了旧的 ${voided.length} 条推断提议` : undefined,
        );
        break;
      }
      case 'proposal.decide': {
        const index = next.proposals.findIndex((item) => item.id === op.id);
        if (index < 0) throw fail('PROPOSAL_NOT_FOUND', 404, '这条提议已经不在了。');
        const proposal = next.proposals[index];
        if (proposal.status !== 'pending' && proposal.status !== 'deferred')
          throw fail('PROPOSAL_SETTLED', 409, '这条提议已经处理过了。');
        const chosen = op.candidate !== undefined ? proposal.candidates?.[op.candidate] : undefined;
        if (op.candidate !== undefined && !chosen) throw fail('INVALID_INPUT', 400, '没有这个候选。');
        const decideOps = op.ops ?? chosen?.ops ?? [];
        next.proposals[index] = {
          ...proposal,
          status: op.decision,
          resolution: {
            decision: op.decision,
            reason:
              op.decision === 'accepted' ? '作者接受了这条提议。' : op.decision === 'rejected' ? '作者拒绝了这条提议。' : '作者暂缓了这条提议。',
            at,
            by: options.actor,
          },
        };
        // 「修改后接受」：页面改过的 ops 先执行，再把提议标成接受。
        if (op.decision === 'accepted' && decideOps.length) {
          const nested = applyOps(next, decideOps, options);
          Object.assign(next, nested.next);
          applied.push(...nested.applied);
          for (const id of nested.touchedEvents) touchedEvents.add(id);
        }
        if (op.decision === 'accepted' && proposal.kind === 'route') {
          const inferred = next.inferredRoutes.find((item) => item.proposalId === proposal.id);
          if (inferred) {
            next.manualRoutes = [
              ...next.manualRoutes.filter((item) => item.legId !== inferred.legId),
              { legId: inferred.legId, path: inferred.path },
            ];
            next.inferredRoutes = next.inferredRoutes.filter((item) => item.proposalId !== proposal.id);
          }
        }
        push({ proposal: next.proposals[index] });
        break;
      }
      case 'constraint.drop': {
        const event = findEvent(next, op.eventId);
        if (!LIFECYCLE_FIELDS.includes(op.field as (typeof LIFECYCLE_FIELDS)[number]))
          throw fail('INVALID_INPUT', 400, '只能删时间、地点、参与方式、叙述性质、父级这几类约束。');
        const field = op.field;
        if (field === 'start')
          event.start = { t: null, label: '未定', certainty: 'unknown', calendar: event.start.calendar, relative: null };
        else if (field === 'end')
          event.end = { t: null, label: '未定', certainty: 'unknown', calendar: event.end.calendar, relative: null };
        else if (field === 'place') event.placeId = null;
        else if (field === 'parent' && event.placeId) {
          const place = next.entities.find((item) => item.id === event.placeId);
          if (place?.place) place.place = { ...place.place, parentId: null };
        } else if (field === 'narrative') event.narrative = 'hypothetical';
        else if (field === 'presence')
          event.participants = event.participants.map((item) => ({ ...item, as: 'mentioned' as const }));
        else if (field === 'died')
          for (const participant of event.participants) {
            const person = next.entities.find((item) => item.id === participant.entityId);
            if (person?.person) person.person = { ...person.person, died: null };
          }
        event.gaps = gapsOf(event, next);
        touchedEvents.add(event.id);
        push({ event });
        break;
      }
      case 'world.set': {
        if (op.patch.title !== undefined && !String(op.patch.title).trim())
          throw fail('INVALID_INPUT', 400, '世界观要有名字。');
        if (op.patch.title !== undefined) next.title = String(op.patch.title);
        if (op.patch.basemap !== undefined) next.basemap = clone(op.patch.basemap);
        push({});
        break;
      }
      default:
        throw fail('INVALID_INPUT', 400, '不认识这个操作。');
    }
  }

  return { next, applied, touchedEvents: [...touchedEvents], redraws };
}

/** 目标对不上就显示待确认，不静默改别的（19 §3）。 */
export function needsRemap(target: MapEdit['target'], effect: MapEdit['effect']): boolean {
  if (effect === 'add') return false;
  if (!target) return true;
  return !target.osm && !target.area && !target.placeId;
}

/** 快照里的 World 投影：修订号、版本、时间轴默认范围、路网状态。 */
export function worldOf(
  dossierId: string,
  document: CreativeDocument,
  revision: number,
  versions: { latest: number; changes: number },
): World {
  const withTime = document.events.filter(
    (event) => boundsOf(event.start).start !== null && boundsOf(event.end).end !== null,
  );
  const timeSpan = withTime.length
    ? (() => {
        const sorted = [...withTime].sort((a, b) => boundsOf(a.start).start! - boundsOf(b.start).start!);
        const first = sorted[0];
        const last = [...withTime].sort((a, b) => boundsOf(b.end).end! - boundsOf(a.end).end!)[0];
        return { from: first.start, to: last.end };
      })()
    : null;
  return {
    id: dossierId,
    dossierId,
    title: document.title,
    revision,
    version: versions,
    basemap: document.basemap,
    timeSpan,
    calendars: document.calendars,
    network: document.network,
  };
}

/** 已经被引用到的 id：删之前先看（服务端生成修法也用它）。 */
export function referencesOf(document: CreativeDocument, entityId: string): string[] {
  const used: string[] = [];
  for (const event of document.events) {
    if (event.placeId === entityId) used.push(`事件「${event.title}」的地点`);
    if (event.participants.some((item) => item.entityId === entityId)) used.push(`事件「${event.title}」的参与者`);
    if (event.travel?.fromId === entityId || event.travel?.toId === entityId) used.push(`事件「${event.title}」的起讫`);
  }
  for (const entity of document.entities)
    if (entity.place?.parentId === entityId) used.push(`地点「${entity.name}」的上级`);
  for (const relation of document.relations)
    if (relation.a === entityId || relation.b === entityId) used.push(`关系「${relation.label}」`);
  for (const edit of document.edits)
    if (edit.target?.placeId === entityId) used.push(`改造「${edit.title}」`);
  return used;
}

export function legIdFor(entityId: string, fromEventId: string, toEventId: string): string {
  // 稳定 id：同一段行程每次算出来都一样，页面手绘、AI 重画都按它对齐。
  return `leg_${entityId.replace(/-/g, '').slice(0, 8)}_${fromEventId.replace(/-/g, '').slice(0, 8)}_${toEventId.replace(/-/g, '').slice(0, 8)}`;
}

export function legPathOf(document: CreativeDocument, leg: CreativeRouteLeg): CreativeRouteLeg['path'] {
  const manual = document.manualRoutes.find((item) => item.legId === leg.id);
  if (manual) return manual.path;
  const inferred = document.inferredRoutes.find((item) => item.legId === leg.id);
  return inferred ? inferred.path : null;
}

export function modeOf(document: CreativeDocument, modeId: string | null): TransportMode | null {
  if (!modeId) return null;
  return document.modes.find((item) => item.id === modeId) ?? null;
}

export { fail as creativeFailure };
