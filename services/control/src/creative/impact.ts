/**
 * 影响清单（1C 契约 §6.2、§6.3）。
 *
 * 「确定受影响」当场沿引用算：场景引用了改变的事件、正文写到改变的实体/事件、事件的地点或参与者是
 * 改变的实体、父子地点的下级事件、这段行程的路线、交通方式改了的路线。算不到的（规则、关系、以及
 * 正文里没有明确引用的段落）留给「扫正文」由 AI 补线索，标成 maybe。
 *
 * 每部作品给出：现在用这条的哪一版、作者决定了没有、采用新版后的检查试算（按混用后的组合跑）。
 */

import type pg from 'pg';
import type {
  CheckRun,
  ImpactItem,
  ImpactRef,
  ImpactReport,
  ItemChange,
} from '@reinlab/contracts';
import { diffDocuments, itemMapOf, putItem, titleOf } from './items';
import { buildLegs } from './routing';
import { runCheck } from './check';
import { effectiveDocument, settingStateOf } from './settings';
import { ApiFailure } from '../api/errors';
import { computeMarks, paragraphsOf, type WorkDocument } from './work';
import type { CreativeDocument } from './world';

export type ScanStatus = { state: 'none' | 'running' | 'done' | 'failed'; cost: { value: number | null; known: boolean }; error?: string | null };
export type MaybeHit = { itemId: string; ref: ImpactRef & { why: string; quote: string } };

export type ScanDocument = {
  fromVersion: number;
  toVersion: number;
  state: ScanStatus['state'];
  cost: { value: number | null; known: boolean };
  error: string | null;
  hits: MaybeHit[];
};

const norm = (value: string) => value.replace(/\s+/g, '');

export type SceneHit = { sceneId: string; chapterId: string; para: number; quote: string };

/** 一部作品的正文里，每条实体/事件分别在哪里出现（每个场景只算一遍 marks）。 */
export function sceneHitsByItem(document: CreativeDocument, work: WorkDocument): Map<string, SceneHit[]> {
  const byItem = new Map<string, SceneHit[]>();
  for (const chapter of work.chapters) {
    for (const scene of chapter.scenes) {
      if (!scene.text.trim()) continue;
      const marks = computeMarks({
        document: work,
        world: document,
        sceneId: scene.id,
        conflicts: [],
        proposals: [],
      });
      if (!marks.length) continue;
      const paragraphs = paragraphsOf(scene.text);
      for (const mark of marks) {
        if (mark.kind !== 'entity' && mark.kind !== 'event') continue;
        const list = byItem.get(mark.refId) ?? [];
        if (list.some((hit) => hit.sceneId === scene.id && hit.para === mark.para)) continue;
        list.push({
          sceneId: scene.id,
          chapterId: chapter.id,
          para: mark.para,
          quote: (paragraphs[mark.para] ?? '').slice(0, 120),
        });
        byItem.set(mark.refId, list);
      }
    }
  }
  return byItem;
}

/** 每部作品对这条条目的状态：用哪一版、决定了没有。 */
export function usesOf(
  workspace: { baseVersion: number; setting: ReturnType<typeof settingStateOf> },
  itemId: string,
  toVersion: number,
): { uses: 'old' | 'new' | 'override'; decision: 'follow' | 'keep' | null } {
  const { setting } = workspace;
  if (setting.overrides.some((override) => override.itemId === itemId)) return { uses: 'override', decision: null };
  const pick = setting.picks.find((item) => item.itemId === itemId);
  if (pick && pick.fromVersion >= toVersion) return { uses: 'new', decision: 'follow' };
  const decision = setting.decisions.find((item) => item.itemId === itemId && item.toVersion === toVersion);
  if (decision) return { uses: decision.decision === 'follow' ? 'new' : 'old', decision: decision.decision };
  return { uses: workspace.baseVersion >= toVersion ? 'new' : 'old', decision: null };
}

/** 一条条目牵出的「同一原因」分组名。 */
export function groupOf(item: ItemChange): string {
  const verb =
    item.change === 'add' ? '是新增的' : item.change === 'remove' ? '被删掉了' : '有改动';
  if (item.change !== 'update') return `${item.title}${verb}`;
  if (item.fields.some((field) => ['开始时间', '结束时间'].includes(field))) return `${item.title}的时间变了`;
  if (item.fields.some((field) => ['地点信息', '坐标', '地点', '上级地点'].includes(field)))
    return `${item.title}的位置或归属变了`;
  if (item.fields.includes('速度') || item.fields.includes('所用路网')) return `${item.title}的规则变了`;
  if (item.fields.includes('名称')) return `${item.title}改了名`;
  return `${item.title}有改动（${item.fields.slice(0, 3).join('、') || '内容'}）`;
}

export type ImpactInput = {
  /** 跨试算共享的路由缓存（见 computeImpact）。 */
  routeCache?: Map<string, unknown>;
  client: pg.PoolClient;
  account: string;
  dossier: string;
  fromVersion: number;
  toVersion: number;
  fromDocument: CreativeDocument;
  toDocument: CreativeDocument;
  works: { id: string; document: WorkDocument }[];
  /** 各作品基准版本 / picks 用到的版本快照。 */
  versionDocuments: Map<number, CreativeDocument>;
  /** 最近一次扫正文的结果（没有就是 none）。 */
  scan: ScanDocument | null;
};

/** 沿引用和依赖算「确定受影响」，加上每部作品的状态与检查试算。 */
export async function computeImpact(input: ImpactInput): Promise<ImpactReport> {
  const changes = diffDocuments(input.fromDocument, input.toDocument);
  // 一次请求内共享路由缓存：每条试算只改一条条目，绝大多数路段可以复用（验收 C1）
  const routeCache = new Map();
  const withCache: ImpactInput = { ...input, routeCache };
  const currentLegs = await buildLegs(input.client, {
    account: input.account,
    dossier: input.dossier,
    document: input.toDocument,
    cache: routeCache,
  });
  // 每部作品的正文标注只算一遍（验收 C1：以前是每条条目 × 每部作品都重算一次 marks）
  const hitsByWork = new Map<string, Map<string, SceneHit[]>>();
  for (const work of input.works) hitsByWork.set(work.id, sceneHitsByItem(input.toDocument, work.document));
  const items: ImpactItem[] = [];
  for (const change of changes) {
    const sure: ImpactItem['sure'] = [];
    const pushRef = (ref: ImpactRef & { why: string }) => {
      const key = JSON.stringify([ref.kind, (ref as { sceneId?: string }).sceneId ?? (ref as { eventId?: string }).eventId ?? (ref as { legId?: string }).legId, ref.why]);
      if (sure.some((item) => JSON.stringify([item.kind, (item as { sceneId?: string }).sceneId ?? (item as { eventId?: string }).eventId ?? (item as { legId?: string }).legId, item.why]) === key)) return;
      sure.push(ref);
    };

    if (change.kind === 'event' || change.kind === 'entity') {
      // 1) 场景引用了这条事件 / 正文写到了这条实体
      for (const work of input.works) {
        if (change.kind === 'event') {
          for (const chapter of work.document.chapters)
            for (const scene of chapter.scenes)
              if (scene.eventIds.includes(change.itemId))
                pushRef({ kind: 'scene', workId: work.id, chapterId: chapter.id, sceneId: scene.id, why: '场景引用了这条事件' });
        } else {
          for (const hit of hitsByWork.get(work.id)?.get(change.itemId) ?? [])
            pushRef({
              kind: 'scene',
              workId: work.id,
              chapterId: hit.chapterId,
              sceneId: hit.sceneId,
              para: hit.para,
              quote: hit.quote,
              why: `正文这里写到了「${change.title.replace(/（.*）$/, '')}」`,
            });
        }
      }
    }

    // 2) 事件引用这条实体（作为地点/参与者），以及父子地点的下级事件
    if (change.kind === 'entity') {
      const childPlaces = new Set(
        input.toDocument.entities
          .filter((entity) => entity.kind === 'place' && entity.place?.parentId === change.itemId)
          .map((entity) => entity.id),
      );
      for (const event of input.toDocument.events) {
        if (event.placeId === change.itemId)
          pushRef({ kind: 'event', eventId: event.id, why: `事件地点是「${titleOf('entity', (input.toDocument.entities.find((item) => item.id === change.itemId) ?? {}) as never).replace(/（.*）$/, '')}」` });
        else if (event.placeId && childPlaces.has(event.placeId))
          pushRef({ kind: 'event', eventId: event.id, why: '事件在它的下级地点' });
        if (event.participants.some((participant) => participant.entityId === change.itemId))
          pushRef({ kind: 'event', eventId: event.id, why: '这条事件里有这个人' });
      }
    }

    // 3) 路线：涉及这条事件 / 这条实体所在地点 / 这条交通方式
    for (const leg of currentLegs) {
      if (change.kind === 'event' && (leg.fromEventId === change.itemId || leg.toEventId === change.itemId))
        pushRef({ kind: 'leg', legId: leg.id, why: '这段行程从这条事件出发 / 到这条事件' });
      if (change.kind === 'mode' && leg.modeId === change.itemId)
        pushRef({ kind: 'leg', legId: leg.id, why: '这段行程用的就是这条交通方式' });
    }
    if (change.kind === 'entity') {
      const relatedEvents = new Set(
        sure.filter((ref) => ref.kind === 'event').map((ref) => (ref as { eventId: string }).eventId),
      );
      for (const leg of currentLegs)
        if (relatedEvents.has(leg.fromEventId) || relatedEvents.has(leg.toEventId))
          pushRef({ kind: 'leg', legId: leg.id, why: '这段行程连着受影响的事件' });
    }

    // 4) 每部作品的试算放到后面并发算（验收 C1：以前串行，13 条 × 5 部作品要十几秒）
    const scanHits = (input.scan?.hits ?? []).filter((hit) => hit.itemId === change.itemId);
    items.push({
      change,
      group: groupOf(change),
      sure,
      maybe: scanHits.map((hit) => hit.ref),
      works: input.works.map((work) => {
        const state = settingStateOf(work.document);
        const status = usesOf({ baseVersion: work.document.baseVersion, setting: state }, change.itemId, input.toVersion);
        return { workId: work.id, uses: status.uses, decision: status.decision, checkAfter: null as CheckRun | null };
      }),
    });
  }
  // 试算：每部作品 × 每条条目，限并发跑（每条一次 buildLegs，串行会拖到十几秒）
  const tasks: { item: ImpactItem; index: number }[] = [];
  for (const item of items) item.works.forEach((_, index) => tasks.push({ item, index }));
  await mapLimit(tasks, 4, async (task) => {
    const work = input.works[task.index];
    task.item.works[task.index].checkAfter = await trialCheck(withCache, work, task.item.change);
  });
  return {
    fromVersion: input.fromVersion,
    toVersion: input.toVersion,
    items,
    maybeScan: input.scan
      ? { state: input.scan.state, cost: input.scan.cost, ...(input.scan.error ? { error: input.scan.error } : {}) }
      : { state: 'none', cost: { value: 0, known: true } },
  };
}

async function mapLimit<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await run(items[index]);
    }
  });
  await Promise.all(workers);
}

/** 采用这条新版以后的检查试算：按这部作品「基准 + picks + 这条换成新版」跑一遍。 */
async function trialCheck(
  input: ImpactInput,
  work: { id: string; document: WorkDocument },
  change: ItemChange,
): Promise<CheckRun | null> {
  const state = settingStateOf(work.document);
  const base =
    input.versionDocuments.get(work.document.baseVersion) ??
    input.versionDocuments.get(0) ??
    input.toDocument;
  const effective = effectiveDocument({ base, versions: input.versionDocuments, setting: state }).document;
  const item = itemMapOf(input.toDocument).get(change.itemId);
  if (item) putItem(effective, item.kind, change.itemId, item.value as never);
  else putItem(effective, change.kind, change.itemId, null);
  try {
    const legs = await buildLegs(input.client, {
      account: input.account,
      dossier: input.dossier,
      document: effective,
      cache: input.routeCache as Map<string, never> | undefined,
    });
    return runCheck({ document: effective, legs, revision: 0, now: new Date().toISOString() });
  } catch {
    return null;
  }
}

/** 取两个版本的世界快照 + 作品 + 扫正文结果，算一份完整的影响清单。 */
export async function impactOf(
  client: pg.PoolClient,
  account: string,
  dossier: string,
  fromVersion: number,
  toVersion: number,
): Promise<ImpactReport> {
  const versions = (
    await client.query<{ n: number; world: CreativeDocument }>(
      'select n, world from creative_version where account_id=$1 and dossier_id=$2 and n = any($3::int[])',
      [account, dossier, [fromVersion, toVersion]],
    )
  ).rows;
  const fromDocument = versions.find((row) => Number(row.n) === fromVersion)?.world;
  const toDocument = versions.find((row) => Number(row.n) === toVersion)?.world;
  if (!fromDocument || !toDocument) throw new ApiFailure('VERSION_NOT_FOUND', 404, '没有这两个版本。');
  const works = (
    await client.query<{ work_id: string; document: WorkDocument }>(
      'select work_id, document from creative_work where account_id=$1 and dossier_id=$2',
      [account, dossier],
    )
  ).rows.map((row) => ({ id: row.work_id, document: row.document }));
  // 作品 picks / 基准版本用到的版本快照
  const needed = new Set<number>([fromVersion, toVersion]);
  for (const work of works) {
    needed.add(work.document.baseVersion);
    for (const pick of settingStateOf(work.document).picks) needed.add(pick.fromVersion);
  }
  const versionRows = (
    await client.query<{ n: number; world: CreativeDocument }>(
      'select n, world from creative_version where account_id=$1 and dossier_id=$2 and n = any($3::int[])',
      [account, dossier, [...needed].filter((n) => n > 0)],
    )
  ).rows;
  const versionDocuments = new Map<number, CreativeDocument>(
    versionRows.map((row) => [Number(row.n), row.world]),
  );
  const scan = await readScan(client, account, dossier, fromVersion, toVersion);
  return computeImpact({
    client,
    account,
    dossier,
    fromVersion,
    toVersion,
    fromDocument,
    toDocument,
    works,
    versionDocuments,
    scan,
  });
}

/** 这条条目改了以后，哪些场景确定受影响（用于 setting.follow 标待同步）。 */
export async function scenesAffectedBy(
  client: pg.PoolClient,
  account: string,
  dossier: string,
  workId: string,
  itemId: string,
  toVersion: number,
): Promise<{ sceneId: string; para?: number }[]> {
  const report = await impactOf(client, account, dossier, Math.max(1, toVersion - 1), toVersion);
  const item = report.items.find((entry) => entry.change.itemId === itemId);
  if (!item) return [];
  const seen = new Set<string>();
  const scenes: { sceneId: string; para?: number }[] = [];
  for (const ref of item.sure) {
    if (ref.kind !== 'scene' || (ref as { workId?: string }).workId !== workId) continue;
    const scene = ref as { sceneId: string; para?: number };
    const key = `${scene.sceneId}:${scene.para ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    scenes.push({ sceneId: scene.sceneId, ...(scene.para !== undefined ? { para: scene.para } : {}) });
  }
  return scenes;
}

/** 读最近一次扫正文的结果。 */
export async function readScan(
  client: pg.PoolClient,
  account: string,
  dossier: string,
  from: number,
  to: number,
): Promise<ScanDocument | null> {
  const row = (
    await client.query<{ document: ScanDocument }>(
      'select document from creative_impact_scan where account_id=$1 and dossier_id=$2 and from_version=$3 and to_version=$4',
      [account, dossier, from, to],
    )
  ).rows[0];
  return row?.document ?? null;
}
