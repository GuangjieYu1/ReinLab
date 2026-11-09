/**
 * 提议在看板上的虚影（1D 契约 §11.2、§11.3）。
 *
 * 把提议的 ops 套到当前草稿（按作品看时套到 effective）上，只算、不落库：
 * 新加 / 改动 / 删除的条目、新事件带出来的行程、受影响人物的轨迹、采纳后新出现和消失的冲突、
 * 解析不到的名字。临时 id 用 `pv:` 开头，同一提议同一修订下稳定；结果按（提议，修订）缓存。
 */

import type pg from 'pg';
import type {
  BoardRef,
  Shot,
  WhiteboxPrim,
  CheckRun,
  CreativeConflict,
  CreativeRouteLeg,
  ItemChange,
  Proposal,
  ProposalPreview,
  Track,
} from '@reinlab/contracts';
import { ApiFailure } from '../api/errors';
import { loadWorld } from './service';
import { effectiveWorldOf } from './effective';
import { applyOps, type CreativeDocument } from './world';
import { changedFields, diffDocuments, itemMapOf, titleOf } from './items';
import { buildLegs, routeOnNetwork } from './routing';
import { runCheck } from './check';
import { buildTracks } from './tracks';

const pointOf = (geo: unknown): [number, number] | null => {
  if (!geo || typeof geo !== 'object') return null;
  const coordinates = (geo as { coordinates?: unknown }).coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const [lng, lat] = coordinates;
  return typeof lng === 'number' && typeof lat === 'number' ? [lng, lat] : null;
};

const CACHE = new Map<string, ProposalPreview>();
const CACHE_LIMIT = 64;

const cacheKey = (dossier: string, revision: number, workId: string | null, proposalId: string) =>
  `${dossier}:${revision}:${workId ?? '-'}:${proposalId}`;

/** 用临时 id 把提议套到 base 上；名字解析不到的记进 unresolved，不报错。 */
function applyProposal(base: CreativeDocument, proposal: Proposal): {
  document: CreativeDocument;
  unresolved: string[];
} {
  let counter = 0;
  const ids = () => `pv:${(counter += 1)}`;
  const unresolved = new Set<string>();
  const outcome = applyOps(base, proposal.ops, { actor: 'agent', ids, tolerant: true, unresolved });
  return { document: outcome.next, unresolved: [...unresolved] };
}

const addedOf = (document: CreativeDocument) => ({
  entities: document.entities.filter((item) => item.id.startsWith('pv:')),
  events: document.events.filter((item) => item.id.startsWith('pv:')),
  relations: document.relations.filter((item) => item.id.startsWith('pv:')),
  rules: document.rules.filter((item) => item.id.startsWith('pv:')),
  prims: ((document.whiteboxes ?? []) as { prims: WhiteboxPrim[] }[])
    .flatMap((box) => box.prims)
    .filter((prim) => prim.id.startsWith('pv:')),
  shots: ((document.shots ?? []) as Shot[]).filter((shot) => shot.id.startsWith('pv:')),
});

const timeRange = (document: CreativeDocument) => {
  const times = document.events
    .flatMap((event) => [event.start?.t, event.end?.t])
    .filter((value): value is number => typeof value === 'number');
  return { from: times.length ? Math.min(...times) : 0, to: times.length ? Math.max(...times) : 0 };
};

const conflictIds = (check: CheckRun) => new Set(check.conflicts.map((item) => item.id));

/** 和新版比变了什么（条目级）：按「种类 + 名字/标题」对齐，绕开临时 id 不一致。 */
function compareVersions(previous: CreativeDocument, next: CreativeDocument): ItemChange[] {
  const changes: ItemChange[] = [];
  const keyOf = (item: { id: string } & Record<string, unknown>, kind: string) =>
    `${kind}|${String(item.name ?? item.title ?? item.id)}`;
  const previousMap = new Map(
    [...itemMapOf(previous).values()].map((item) => [keyOf(item.value, item.kind), item]),
  );
  const nextMap = new Map([...itemMapOf(next).values()].map((item) => [keyOf(item.value, item.kind), item]));
  for (const [key, item] of nextMap) {
    const old = previousMap.get(key);
    if (!old) {
      changes.push({
        itemId: item.value.id,
        kind: item.kind,
        title: titleOf(item.kind, item.value),
        change: 'add',
        before: null,
        after: item.value,
        fields: [],
      });
      continue;
    }
    if (JSON.stringify(old.value) === JSON.stringify(item.value)) continue;
    changes.push({
      itemId: item.value.id,
      kind: item.kind,
      title: titleOf(item.kind, item.value),
      change: 'update',
      before: old.value,
      after: item.value,
      fields: changedFields(old.value as never, item.value as never),
    });
  }
  // 名字/标题改过的那一条：按种类把剩下的「新增」和「删除」成对合成 update（不然会读成加一条、删一条）
  const pairedAdds = new Set<string>();
  for (const [key, item] of previousMap) {
    if (nextMap.has(key)) continue;
    const partner = changes.find(
      (change) =>
        change.change === 'add' &&
        change.kind === item.kind &&
        !pairedAdds.has(change.itemId),
    );
    if (partner) {
      pairedAdds.add(partner.itemId);
      partner.change = 'update';
      partner.before = item.value;
      partner.fields = changedFields(item.value, partner.after as never);
      continue;
    }
    changes.push({
      itemId: item.value.id,
      kind: item.kind,
      title: titleOf(item.kind, item.value),
      change: 'remove',
      before: item.value,
      after: null,
      fields: [],
    });
  }
  return changes;
}

export async function previewOf(
  client: pg.PoolClient,
  account: string,
  dossier: string,
  proposalId: string,
  workId?: string | null,
): Promise<ProposalPreview> {
  const worldState = await loadWorld(client, account, dossier);
  const proposal = worldState.document.proposals.find((item: Proposal) => item.id === proposalId);
  if (!proposal) throw new ApiFailure('PROPOSAL_NOT_FOUND', 404, '这条提议已经不在了。');
  if (proposal.status !== 'pending' && proposal.status !== 'deferred')
    throw new ApiFailure('PROPOSAL_SETTLED', 409, '这条提议已经处理过了。');
  if (proposal.kind === 'text_edit')
    throw new ApiFailure('INVALID_INPUT', 400, '正文改稿不在世界观看板上预览。');

  const key = cacheKey(dossier, worldState.revision, workId ?? null, proposalId);
  const cached = CACHE.get(key);
  if (cached) return cached;

  const base = workId
    ? (await effectiveWorldOf(client, account, dossier, workId)).document
    : worldState.document;
  const { document: applied, unresolved } = applyProposal(base, proposal);
  const added = addedOf(applied);

  const baseLegs = await buildLegs(client, { account, dossier, document: base });
  const legs = await buildLegs(client, { account, dossier, document: applied });
  const baseLegIds = new Set(baseLegs.map((item: CreativeRouteLeg) => item.id));
  const touchedEvents = new Set([
    ...added.events.map((item) => item.id),
    ...diffDocuments(base, applied)
      .filter((item) => item.kind === 'event' && item.change === 'update')
      .map((item) => item.itemId),
  ]);
  const newLegs = legs.filter(
    (leg) =>
      !baseLegIds.has(leg.id) || touchedEvents.has(leg.fromEventId) || touchedEvents.has(leg.toEventId),
  );
  // 出行事件自带起点/终点时，预览按路网补一段（单条出行事件没有「上一条事件」，标准 legs 里不会生成）
  const covered = new Set(newLegs.map((leg) => `${leg.fromEventId}→${leg.toEventId}`));
  for (const event of added.events) {
    if (event.kind !== 'travel' || !event.travel?.fromId || !event.travel?.toId) continue;
    // 标准 legs 里已经有「上一处 → 这条出行事件」的那一段，就不再补一段（否则画两遍）
    if (legs.some((leg) => leg.toEventId === event.id || leg.fromEventId === event.id)) continue;
    const pair = `${event.id}→${event.id}`;
    if (covered.has(pair)) continue;
    const modeId = event.travel.modeId ?? applied.modes[0]?.id ?? null;
    const routed = await routeOnNetwork(
      client,
      { account, dossier, document: applied },
      {
        from: {
          placeId: event.travel.fromId,
          point: pointOf(applied.entities.find((item) => item.id === event.travel!.fromId)?.place?.geo),
          label: applied.entities.find((item) => item.id === event.travel!.fromId)?.name ?? '起点',
        },
        to: {
          placeId: event.travel.toId,
          point: pointOf(applied.entities.find((item) => item.id === event.travel!.toId)?.place?.geo),
          label: applied.entities.find((item) => item.id === event.travel!.toId)?.name ?? '终点',
        },
        modeId,
        at: event.start?.t ?? 0,
      },
    );
    newLegs.push({
      id: `leg_preview_${event.id.slice(3)}`,
      entityId: event.participants[0]?.entityId ?? '',
      fromEventId: event.id,
      toEventId: event.id,
      modeId,
      kind: routed.kind,
      path: routed.path,
      distanceKm: routed.distanceKm,
      durationMin: routed.durationMin,
      failure: routed.failure,
      inferred: null,
    });
    covered.add(pair);
  }

  const personIds = new Set<string>([
    ...added.entities.filter((item) => item.kind === 'person').map((item) => item.id),
    ...added.events.flatMap((event) => event.participants.map((item) => item.entityId)),
    ...diffDocuments(base, applied)
      .filter((item) => item.kind === 'event')
      .flatMap((item) => ((item.after as { participants?: { entityId: string }[] } | null)?.participants ?? []).map((p) => p.entityId)),
  ]);
  const range = timeRange(applied);
  const tracks: Track[] = personIds.size
    ? buildTracks(applied, legs, range, [...personIds], { ignoreDeath: true })
    : [];

  const baseCheck = runCheck({ document: base, legs: baseLegs, revision: worldState.revision, now: new Date().toISOString() });
  const appliedCheck = runCheck({ document: applied, legs, revision: worldState.revision, now: new Date().toISOString() });
  const baseIds = conflictIds(baseCheck);
  const appliedIds = conflictIds(appliedCheck);
  // 规则判定（rule_model）按「事件 + 规则」指纹缓存，事件一变就失效：它不算「被这条提议修好了」，
  // 也不该在虚影里当成新冲突（接受后需要重判）。预览里两边都不列。
  const conflictsNew: CreativeConflict[] = appliedCheck.conflicts.filter(
    (item) => !baseIds.has(item.id) && item.kind !== 'rule_model',
  );
  const conflictsGone = [...baseIds].filter(
    (id) => !appliedIds.has(id) && baseCheck.conflicts.find((item) => item.id === id)?.kind !== 'rule_model',
  );

  const diff = diffDocuments(base, applied);
  const changed = diff.filter((item) => item.change === 'update');
  const removed = diff
    .filter((item) => item.change === 'remove')
    .map((item) => ({ kind: item.kind, id: item.itemId, title: item.title }));

  let vsPrevious: ItemChange[] | null = null;
  if (proposal.supersedes) {
    const previous = worldState.document.proposals.find((item: Proposal) => item.id === proposal.supersedes);
    if (previous) {
      const prevApplied = applyProposal(base, previous).document;
      vsPrevious = compareVersions(prevApplied, applied);
    }
  }

  const preview: ProposalPreview = {
    proposalId,
    baseRevision: worldState.revision,
    workId: workId ?? null,
    added: {
      entities: added.entities,
      events: added.events,
      relations: added.relations,
      rules: added.rules,
      prims: added.prims,
      shots: added.shots,
    },
    changed,
    removed,
    legs: newLegs,
    tracks,
    conflictsNew,
    conflictsGone,
    // 已经是整句话（重名那类）就原样给；只是名字的才包一层
    unresolved: unresolved.map((name) =>
      name.includes('（') ? name : `「${name}」还没有入账，接受后需要先建出来`,
    ),
    vsPrevious,
  };
  CACHE.set(key, preview);
  if (CACHE.size > CACHE_LIMIT) CACHE.delete(CACHE.keys().next().value as string);
  return preview;
}

/** 事件流里「正在看」用的一行字（服务端写，不靠模型）。 */
export function focusStep(tool: string, args: Record<string, unknown>, detail?: string): { step: string; refs: BoardRef[] } {
  switch (tool) {
    case 'world_snapshot':
      return { step: `看了一遍世界观${detail ? `（${detail}）` : ''}`, refs: [] };
    case 'event_search':
      return {
        step: `正在找「${String(args.query ?? '').slice(0, 12)}」相关的事件${detail ? `（${detail} 条）` : ''}`,
        refs: [],
      };
    case 'check_run':
      return { step: '正在看检查结果', refs: [] };
    case 'work_scene':
      return { step: `正在读这一场正文${detail ? `（${detail}）` : ''}`, refs: [] };
    case 'version_diff':
      return { step: `正在看 v${String(args.from ?? '?')}→v${String(args.to ?? '?')} 的改动`, refs: [] };
    case 'read_file':
      return { step: `正在读「${String(args.path ?? '').slice(-24)}」`, refs: [] };
    case 'propose_setting':
      return { step: '交了提议，画在看板上', refs: [] };
    case 'propose_text_edit':
      return { step: '交了改稿', refs: [] };
    default:
      return { step: '在做事', refs: [] };
  }
}

export { applyProposal };
