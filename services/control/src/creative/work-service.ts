/**
 * 作品服务（design/prd/20-creative-contract.md §5.2）：
 * 建作品、读作品、WorkOp 原子批次、正文接受、正文标注、导出。
 *
 * 作品行按 (档案, 作品) 存一份 jsonb，revision 自己走；世界观那边只多一条
 * 「提议被接受了」的记录。正文改完推 creative.text，作品结构改完推 creative.work。
 */

import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import type {
  CreativeAppliedOp,
  CreativeOp,
  ItemChange,
  Proposal,
  TextEdit,
  Work,
  WorkOp,
} from '@reinlab/contracts';
import { ApiFailure } from '../api/errors';
import { appendEvents } from './events';
import { loadWorld, requireCreativeDossier } from './service';
import { effectiveWorldOf } from './effective';
import { worldOf } from './world';
import { buildLegs } from './routing';
import { runCheck } from './check';
import { cursorOf } from './events';
import type { CreativeDocument } from './world';
import { diffDocuments, itemMapOf } from './items';
import {
  dismissSync,
  followItem,
  followVersion,
  keepItem,
  removeOverride,
  resolveSync,
  setOverride,
  settingStateOf,
} from './settings';
import { impactOf, scenesAffectedBy } from './impact';
import { startGenerate } from './writer';
import { buildDocx } from './docx';
import {
  applyTextEdit,
  applyWorkOps,
  computeMarks,
  emptyWork,
  markConflicts,
  paragraphsOf,
  sceneOf,
  workOf,
  wordsOf,
  type WorkDocument,
} from './work';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type WorkState = { document: WorkDocument; revision: number };

async function requireWorkId(value: string): Promise<string> {
  if (!UUID.test(value)) throw new ApiFailure('WORK_NOT_FOUND', 404, '找不到这部作品。');
  return value;
}

async function latestVersion(client: pg.PoolClient, account: string, dossier: string): Promise<number> {
  const row = (
    await client.query<{ n: string | null }>(
      'select max(n)::text n from creative_version where account_id=$1 and dossier_id=$2',
      [account, dossier],
    )
  ).rows[0];
  return Number(row?.n ?? 0);
}

async function loadWorkState(
  client: pg.PoolClient,
  account: string,
  dossier: string,
  workId: string,
  options: { lock?: boolean } = {},
): Promise<WorkState> {
  await requireWorkId(workId);
  await requireCreativeDossier(client, account, dossier);
  const row = (
    await client.query<{ revision: number; document: WorkDocument }>(
      `select revision, document from creative_work
        where account_id=$1 and dossier_id=$2 and work_id=$3${options.lock ? ' for update' : ''}`,
      [account, dossier, workId],
    )
  ).rows[0];
  if (!row) throw new ApiFailure('WORK_NOT_FOUND', 404, '找不到这部作品。');
  return { document: row.document, revision: Number(row.revision) };
}

/** 正文标注要尾巴上的检查结果：冲突落在哪一段，标在哪一段。 */
async function currentConflicts(
  client: pg.PoolClient,
  account: string,
  dossier: string,
): Promise<{ id: string; entityIds: string[]; eventIds: string[] }[]> {
  const row = (
    await client.query<{ run: { conflicts?: { id: string; entityIds: string[]; eventIds: string[] }[] } }>(
      'select run from creative_check where account_id=$1 and dossier_id=$2',
      [account, dossier],
    )
  ).rows[0];
  return row?.run?.conflicts ?? [];
}

function project(
  document: WorkDocument,
  revision: number,
  options: { withText: boolean; world?: Awaited<ReturnType<typeof loadWorld>>['document']; conflicts?: { id: string; entityIds: string[]; eventIds: string[] }[] },
): Work {
  const work = workOf(document, revision, {
    withText: options.withText,
    ...(options.withText
      ? {
          marks: (sceneId: string) => {
            if (!options.world) return [];
            const base = computeMarks({
              document,
              world: options.world,
              sceneId,
              conflicts: options.conflicts ?? [],
              proposals: options.world.proposals,
            });
            const { scene } = sceneOf(document, sceneId);
            const paragraphs = paragraphsOf(scene.text);
            const withConflicts = [
              ...base,
              ...markConflicts(base, scene.text, options.conflicts ?? [], options.world),
            ];
            // 段落下标越界的一律丢掉（正文改过的旧标注）
            return withConflicts.filter((mark) => mark.para >= 0 && mark.para < paragraphs.length);
          },
        }
      : {}),
  });
  return work;
}

/**
 * 事件 → 作品的双向引用（契约 §5.1：`WorldEvent.workRefs` 要跟着场景的 eventIds 走）。
 * 只改事件上的 workRefs，不动 revision：这是投影，不是作者的改动；但要在世界观行锁里做，
 * 免得和世界观的批次互相覆盖。
 */
export async function syncWorkRefs(
  client: pg.PoolClient,
  account: string,
  dossier: string,
): Promise<void> {
  const works = (
    await client.query<{ work_id: string; document: WorkDocument }>(
      'select work_id, document from creative_work where account_id=$1 and dossier_id=$2',
      [account, dossier],
    )
  ).rows;
  const links = new Map<string, { workId: string; chapterId: string; sceneId: string }[]>();
  for (const work of works)
    for (const chapter of work.document.chapters)
      for (const scene of chapter.scenes)
        for (const eventId of scene.eventIds ?? []) {
          const list = links.get(eventId) ?? [];
          if (!list.some((item) => item.workId === work.work_id && item.chapterId === chapter.id && item.sceneId === scene.id))
            list.push({ workId: work.work_id, chapterId: chapter.id, sceneId: scene.id });
          links.set(eventId, list);
        }
  const world = await loadWorld(client, account, dossier, { lock: true });
  let changed = false;
  const events = world.document.events.map((event) => {
    const next = links.get(event.id) ?? [];
    const current = event.workRefs ?? [];
    const same =
      next.length === current.length &&
      next.every(
        (ref, index) =>
          ref.workId === current[index]?.workId &&
          ref.chapterId === current[index]?.chapterId &&
          ref.sceneId === current[index]?.sceneId,
      );
    if (same) return event;
    changed = true;
    return { ...event, workRefs: next };
  });
  if (!changed) return;
  await client.query(
    'update creative_world set document=$3::jsonb, updated_at=now() where account_id=$1 and dossier_id=$2',
    [account, dossier, JSON.stringify({ ...world.document, events })],
  );
}

/** 作品列表：不带正文（左栏用）。 */
export async function listWorks(
  client: pg.PoolClient,
  account: string,
  dossier: string,
): Promise<Work[]> {
  await requireCreativeDossier(client, account, dossier);
  const rows = (
    await client.query<{ work_id: string; revision: number; document: WorkDocument }>(
      'select work_id, revision, document from creative_work where account_id=$1 and dossier_id=$2 order by created_at',
      [account, dossier],
    )
  ).rows;
  return rows.map((row) => project(row.document, Number(row.revision), { withText: false }));
}

/** 建作品：锁定当前最新的已确认版本（没有版本就 0，页面照实显示）。 */
export async function createWork(
  client: pg.PoolClient,
  account: string,
  dossier: string,
  input: { kind: Work['kind']; title: string; targetWords?: number | null },
): Promise<Work> {
  await requireCreativeDossier(client, account, dossier);
  const baseVersion = await latestVersion(client, account, dossier);
  const document = emptyWork({
    kind: input.kind,
    title: input.title.trim(),
    targetWords: input.targetWords ?? null,
    baseVersion,
  });
  await client.query(
    `insert into creative_work(account_id,dossier_id,work_id,revision,document)
     values($1,$2,$3,1,$4::jsonb)`,
    [account, dossier, document.id, JSON.stringify(document)],
  );
  await appendEvents(client, { account, dossier }, [
    { type: 'creative.work', data: { workId: document.id, revision: 1 } },
  ]);
  return project(document, 1, { withText: true });
}

/** 作品详情：带正文和标注。 */
export async function readWork(
  client: pg.PoolClient,
  account: string,
  dossier: string,
  workId: string,
): Promise<Work> {
  const state = await loadWorkState(client, account, dossier, workId);
  const world = await loadWorld(client, account, dossier);
  const conflicts = await currentConflicts(client, account, dossier);
  return project(state.document, state.revision, {
    withText: true,
    world: world.document,
    conflicts,
  });
}

/** 两个版本之间某条条目的变化（找不到就是 null）。 */
async function itemChangeBetween(
  client: pg.PoolClient,
  account: string,
  dossier: string,
  fromVersion: number,
  toVersion: number,
  itemId: string,
): Promise<{ change: import('@reinlab/contracts').ItemChange | null; toDocument: CreativeDocument | null }> {
  const rows = (
    await client.query<{ n: number; world: CreativeDocument }>(
      'select n, world from creative_version where account_id=$1 and dossier_id=$2 and n = any($3::int[])',
      [account, dossier, [...new Set([fromVersion, toVersion])].filter((n) => n > 0)],
    )
  ).rows;
  const toDocument = rows.find((row) => Number(row.n) === toVersion)?.world ?? null;
  if (!toDocument) return { change: null, toDocument: null };
  const fromDocument = rows.find((row) => Number(row.n) === fromVersion)?.world ?? null;
  const base = fromDocument ?? { entities: [], relations: [], events: [], modes: [], rules: [], edits: [] } as unknown as CreativeDocument;
  const change = diffDocuments(base, toDocument).find((item) => item.itemId === itemId) ?? null;
  return { change, toDocument };
}

/**
 * 1C 的设定组合操作（契约 §6.3）。要读版本差异、有的还要生成改稿或推一条世界观提议，
 * 所以放在服务层；纯状态变化在 settings.ts 里。
 */
async function applySettingOp(
  client: pg.PoolClient,
  account: string,
  dossier: string,
  workId: string,
  document: WorkDocument,
  op: WorkOp,
  at: string,
): Promise<{
  document: WorkDocument;
  summary: string;
  generateJobId?: string;
  worldTouched?: boolean;
  worldSummary?: string;
}> {
  const state = settingStateOf(document);
  const withSetting = (setting: ReturnType<typeof settingStateOf>, summary: string) => ({
    document: { ...document, setting },
    summary,
  });

  switch (op.op) {
    case 'setting.follow': {
      const { change } = await itemChangeBetween(client, account, dossier, document.baseVersion, op.toVersion, op.itemId);
      const scenes = await scenesAffectedBy(client, account, dossier, workId, op.itemId, op.toVersion);
      const next = followItem(state, { itemId: op.itemId, toVersion: op.toVersion, scenes, at });
      return withSetting(
        next,
        `「${change?.title ?? op.itemId}」跟着改成 v${op.toVersion}${scenes.length ? `，${scenes.length} 处正文待同步` : ''}`,
      );
    }
    case 'setting.keep': {
      const { change } = await itemChangeBetween(client, account, dossier, document.baseVersion, op.toVersion, op.itemId);
      return withSetting(keepItem(state, { itemId: op.itemId, toVersion: op.toVersion, at }), `「${change?.title ?? op.itemId}」保留旧版（不用 v${op.toVersion} 的改动）`);
    }
    case 'setting.follow_version': {
      const from = document.baseVersion > 0 ? document.baseVersion : 1;
      const report = await impactOf(client, account, dossier, from, op.toVersion);
      const scenesByItem = new Map<string, { sceneId: string; para?: number }[]>();
      for (const item of report.items) {
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
        if (scenes.length) scenesByItem.set(item.change.itemId, scenes);
      }
      const decidedItems = new Set(state.decisions.filter((decision) => decision.toVersion === op.toVersion).map((decision) => decision.itemId));
      const next = followVersion(state, { toVersion: op.toVersion, scenesByItem, decidedItems, at });
      return {
        document: { ...document, baseVersion: op.toVersion, setting: next },
        summary: `整版跟进到 v${op.toVersion}（${scenesByItem.size} 条条目有正文要跟着看）`,
      };
    }
    case 'override.set': {
      const next = setOverride(state, { itemId: op.itemId, kind: op.kind, patch: op.patch, note: op.note, at });
      return withSetting(next, `对「${op.itemId}」做了本作品改写：${op.note.slice(0, 40)}`);
    }
    case 'override.remove': {
      return withSetting(removeOverride(state, op.itemId), `取消了对「${op.itemId}」的本作品改写`);
    }
    case 'override.promote': {
      const override = state.overrides.find((item) => item.itemId === op.itemId);
      if (!override) throw new ApiFailure('OVERRIDE_NOT_FOUND', 404, '这条本作品改写已经不在了。');
      const world = await loadWorld(client, account, dossier, { lock: true });
      const map = itemMapOf(world.document);
      const current = map.get(op.itemId);
      if (!current) throw new ApiFailure('ITEM_NOT_FOUND', 404, '这条设定在世界观里已经不在了。');
      const patch = (override.patch ?? {}) as Record<string, unknown>;
      const merged = { ...current.value, ...patch } as Record<string, unknown>;
      const opValue: CreativeOp =
        override.kind === 'mode'
          ? ({ op: 'mode.set', mode: merged } as unknown as CreativeOp)
          : override.kind === 'rule'
            ? ({ op: 'rule.set', rule: merged } as unknown as CreativeOp)
            : ({ op: `${override.kind}.update`, id: op.itemId, patch } as unknown as CreativeOp);
      const proposal: Proposal = {
        id: randomUUID(),
        kind:
          override.kind === 'entity'
            ? 'entity'
            : override.kind === 'event'
              ? 'event'
              : override.kind === 'relation'
                ? 'relation'
                : override.kind === 'rule' || override.kind === 'mode'
                  ? 'rule'
                  : 'map_edit',
        title: `推广本作品改写：${String(current.value.name ?? current.value.title ?? op.itemId)}`,
        summary: override.note || '把这部作品的局部改写推广到共享世界观。',
        ops: [opValue],
        origin: { basis: 'author', by: 'user', why: override.note },
        doubts: [],
        dependsOn: [],
        conflicts: [],
        status: 'pending',
      };
      const worldNext: CreativeDocument = { ...world.document, proposals: [...world.document.proposals, proposal] };
      const revision = world.revision + 1;
      await client.query(
        'update creative_world set revision=$3, document=$4::jsonb, updated_at=now() where account_id=$1 and dossier_id=$2',
        [account, dossier, revision, JSON.stringify(worldNext)],
      );
      await appendEvents(client, { account, dossier }, [
        { type: 'creative.proposal', data: proposal },
        { type: 'creative.op', data: { revision, applied: [] } },
      ]);
      return {
        document,
        summary: `把「${proposal.title}」推广到共享世界观（进待确认）`,
        worldTouched: true,
        worldSummary: `世界观多了一条提议：${proposal.title}`,
      };
    }
    case 'sync.suggest': {
      const { change } = await itemChangeBetween(client, account, dossier, document.baseVersion, Math.max(1, document.baseVersion), op.itemId);
      // 每场只改「标了待同步」的那一段（验收 C2）
      const syncParas: Record<string, number> = {};
      for (const sceneId of op.sceneIds) {
        const pair = state.sync.find((item) => item.itemId === op.itemId && item.sceneId === sceneId);
        if (pair?.para !== undefined) syncParas[sceneId] = pair.para;
      }
      const hint = change
        ? `这条设定变了：${change.title}（改了：${change.fields.join('、') || '内容'}）。请按新设定改这一场，只改需要改的地方，别动别的。`
        : `按新设定重看这一场，只改需要改的地方。`;
      const job = await startGenerate(client, account, dossier, workId, {
        sceneIds: op.sceneIds,
        mode: 'rewrite',
        hint,
        syncItem: op.itemId,
        ...(Object.keys(syncParas).length ? { syncParas } : {}),
      });
      return { document, summary: `让助手按新设定改 ${op.sceneIds.length} 场（任务 ${job.id.slice(0, 8)}）`, generateJobId: job.id };
    }
    case 'sync.dismiss': {
      return withSetting(
        dismissSync(state, { itemId: op.itemId, sceneId: op.sceneId, reason: op.reason, at }),
        `「这一处不用改」记下了：${op.reason.slice(0, 40)}`,
      );
    }
    default:
      throw new ApiFailure('INVALID_INPUT', 400, '不认识这个设定组合操作。');
  }
}

export type WorkBatchOutcome = {
  revision: number;
  work: Work;
  applied: { op: string; summary: string }[];
  /** 1C：sync.suggest 起的生成任务，提交后由调用方去跑。 */
  pendingGenerates: string[];
};

/** 作品的一批改动：原子、revision +1、正文改动推 creative.text。 */
export async function applyWorkBatch(
  client: pg.PoolClient,
  account: string,
  dossier: string,
  workId: string,
  request: { baseRevision?: number; ops: WorkOp[] },
): Promise<WorkBatchOutcome> {
  const state = await loadWorkState(client, account, dossier, workId, { lock: true });
  if (
    request.baseRevision !== undefined &&
    request.baseRevision >= 0 &&
    request.baseRevision !== state.revision
  ) {
    const world = await loadWorld(client, account, dossier);
    throw new ApiFailure('REVISION_STALE', 409, '这部作品刚被改过，请按最新状态再来一次。', {
      revision: state.revision,
      work: project(state.document, state.revision, { withText: false, world: world.document }),
    });
  }

  const SETTING_OPS = new Set([
    'setting.follow',
    'setting.keep',
    'setting.follow_version',
    'override.set',
    'override.remove',
    'override.promote',
    'sync.suggest',
    'sync.dismiss',
  ]);
  const acceptOps = request.ops.filter((op): op is Extract<WorkOp, { op: 'text.accept' }> => op.op === 'text.accept');
  const settingOps = request.ops.filter((op) => SETTING_OPS.has(op.op));
  const restOps = request.ops.filter((op) => op.op !== 'text.accept' && !SETTING_OPS.has(op.op));

  // 1C 的设定组合操作先做（要读版本差异、可能要生成改稿），再走 1B 的作品操作
  const at = new Date().toISOString();
  const applied: { op: string; summary: string }[] = [];
  const pendingGenerates: string[] = [];
  let base = state.document;
  for (const op of settingOps) {
    const result = await applySettingOp(client, account, dossier, workId, base, op, at);
    base = result.document;
    applied.push({ op: op.op, summary: result.summary });
    if (result.generateJobId) pendingGenerates.push(result.generateJobId);
    if (result.worldTouched) applied.push({ op: op.op, summary: result.worldSummary ?? '' });
  }
  const outcome = restOps.length
    ? applyWorkOps(base, restOps, { at })
    : { next: base, applied: [] as { op: string; summary: string }[], touchedScenes: [], proposalIds: [] as string[] };
  const document = outcome.next;
  applied.push(...outcome.applied);
  const touched = [...outcome.touchedScenes];
  const revision = state.revision + 1;

  // 接受正文提议：正文落笔 + 世界观里那条提议标成接受（同一个事务）。
  const acceptedTextScenes: { sceneId: string; textVersion: number }[] = [];
  if (acceptOps.length) {
    const world = await loadWorld(client, account, dossier, { lock: true });
    let worldDocument = world.document;
    let worldRevision = world.revision;
    const appliedWorld: CreativeAppliedOp[] = [];
    for (const op of acceptOps) {
      const proposal = worldDocument.proposals.find((item: Proposal) => item.id === op.proposalId);
      if (!proposal) throw new ApiFailure('PROPOSAL_NOT_FOUND', 404, '这条提议已经不在了。');
      if (proposal.kind !== 'text_edit')
        throw new ApiFailure('INVALID_INPUT', 400, '这不是正文提议，按世界观的操作处理。');
      if (proposal.status !== 'pending' && proposal.status !== 'deferred')
        throw new ApiFailure('PROPOSAL_SETTLED', 409, '这条提议已经处理过了。');
      const edit = proposal.ops[0] as unknown as TextEdit;
      if (!edit || typeof edit !== 'object' || !('sceneId' in edit))
        throw new ApiFailure('INVALID_INPUT', 400, '这条正文提议缺内容。');
      const { scene } = sceneOf(document, edit.sceneId);
      const result = applyTextEdit(scene, edit, op.text);
      const after = op.text ?? edit.after;
      scene.text = result.text;
      scene.textVersion += 1;
      scene.words = wordsOf(scene.text);
      scene.state = scene.text.trim() ? 'written' : 'empty';
      touched.push({ sceneId: scene.id, state: scene.state, textVersion: scene.textVersion });
      acceptedTextScenes.push({ sceneId: scene.id, textVersion: scene.textVersion });
      applied.push({ op: 'text.accept', summary: `接受了「${scene.title}」的正文改动（${after.length} 字）` });
      // 1C：这条改稿是为「某条设定更新」出的，接受之后那处待同步就消掉
      if (typeof proposal.batchId === 'string' && proposal.batchId.startsWith('sync_')) {
        document.setting = resolveSync(settingStateOf(document), {
          itemId: proposal.batchId.slice('sync_'.length),
          sceneId: scene.id,
          at: new Date().toISOString(),
          via: 'text_edit',
        });
      }
      worldDocument = {
        ...worldDocument,
        proposals: worldDocument.proposals.map((item: Proposal) =>
          item.id === proposal.id
            ? {
                ...item,
                status: 'accepted' as const,
                resolution: {
                  decision: 'accepted' as const,
                  reason: op.text === undefined ? '作者接受了这条改写。' : '作者改后接受了这条改写。',
                  at: new Date().toISOString(),
                  by: 'user' as const,
                },
              }
            : item,
        ),
      };
      appliedWorld.push({
        op: 'proposal.decide',
        opId: `accept_${proposal.id}`,
        actor: 'user',
        summary: `接受了正文提议「${proposal.title}」`,
        result: { proposal: worldDocument.proposals.find((item: Proposal) => item.id === proposal.id) },
      } as unknown as CreativeAppliedOp);
    }
    worldRevision += 1;
    await client.query(
      'update creative_world set revision=$3, document=$4::jsonb, updated_at=now() where account_id=$1 and dossier_id=$2',
      [account, dossier, worldRevision, JSON.stringify(worldDocument)],
    );
    await appendEvents(client, { account, dossier }, [
      { type: 'creative.op', data: { revision: worldRevision, applied: appliedWorld } },
    ]);
  }

  await client.query(
    `update creative_work set revision=$4, document=$5::jsonb, updated_at=now()
      where account_id=$1 and dossier_id=$2 and work_id=$3`,
    [account, dossier, workId, revision, JSON.stringify(document)],
  );
  await appendEvents(client, { account, dossier }, [
    { type: 'creative.work', data: { workId, revision } },
    ...touched.map((scene) => ({
      type: 'creative.text',
      data: { workId, sceneId: scene.sceneId, state: scene.state, textVersion: scene.textVersion },
    })),
  ]);

  // 场景引用的事件要能在事件详情里看到「在哪部作品的哪一章」
  await syncWorkRefs(client, account, dossier);
  const world = await loadWorld(client, account, dossier);
  const conflicts = await currentConflicts(client, account, dossier);
  return {
    revision,
    work: project(document, revision, { withText: true, world: world.document, conflicts }),
    applied,
    pendingGenerates,
  };
}

/** 「这部作品实际用的设定」快照：同快照形状，check 按组合算，条目带 setting。 */
export async function readEffectiveSnapshot(
  client: pg.PoolClient,
  account: string,
  dossier: string,
  workId: string,
): Promise<Record<string, unknown>> {
  const effective = await effectiveWorldOf(client, account, dossier, workId);
  const document = effective.document;
  const legs = await buildLegs(client, { account, dossier, document });
  const check = runCheck({ document, legs, revision: effective.workRevision, now: new Date().toISOString() });
  const versionRows = (
    await client.query<{ n: number; at: Date; summary: string; changes: number; world: CreativeDocument }>(
      'select n, at, summary, changes, world from creative_version where account_id=$1 and dossier_id=$2 order by n',
      [account, dossier],
    )
  ).rows;
  const latest = versionRows.length ? versionRows[versionRows.length - 1] : null;
  const worldState = await loadWorld(client, account, dossier);
  return {
    world: {
      ...worldOf(dossier, document, effective.workRevision, {
        latest: latest ? Number(latest.n) : 0,
        draftChanges: Math.max(0, worldState.revision - (latest ? Number(latest.n) : 0)),
      }),
      // 1C：按作品看时的口径
      work: { id: workId, baseVersion: effective.baseVersion, picks: effective.picked, overrides: effective.overridden },
    },
    entities: document.entities,
    relations: document.relations,
    events: document.events,
    modes: document.modes,
    rules: document.rules,
    edits: document.edits,
    legs,
    proposals: document.proposals.filter((item) => item.status === 'pending' || item.status === 'deferred'),
    check,
    versions: versionRows.map((row) => ({ n: Number(row.n), at: row.at.toISOString(), summary: row.summary, changes: Number(row.changes) })),
    cursor: await cursorOf(client, { account, dossier }),
  };
}

/** 导出正文：md 和 docx。 */
export async function exportWork(
  client: pg.PoolClient,
  account: string,
  dossier: string,
  workId: string,
  format: 'md' | 'docx',
): Promise<{ filename: string; contentType: string; body: Uint8Array | string }> {
  const state = await loadWorkState(client, account, dossier, workId);
  const document = state.document;
  const safeTitle = document.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || '作品';
  if (format === 'docx') {
    const blocks: { text: string; bold?: boolean; sizeHalfPt?: number }[] = [];
    for (const chapter of document.chapters) {
      blocks.push({ text: `第 ${chapter.no} 章　${chapter.title}`, bold: true, sizeHalfPt: 30 });
      for (const scene of chapter.scenes) {
        if (scene.title) blocks.push({ text: scene.title, bold: true, sizeHalfPt: 26 });
        for (const paragraph of paragraphsOf(scene.text)) if (paragraph.trim()) blocks.push({ text: paragraph });
      }
    }
    return {
      filename: `${safeTitle}.docx`,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      body: buildDocx({ title: document.title, blocks }),
    };
  }
  const lines: string[] = [`# ${document.title}`, ''];
  for (const chapter of document.chapters) {
    lines.push(`## 第 ${chapter.no} 章　${chapter.title}`, '');
    for (const scene of chapter.scenes) {
      lines.push(`### ${scene.title}`, '');
      const text = scene.text.trim();
      lines.push(text || '（还没有正文）', '');
    }
  }
  return { filename: `${safeTitle}.md`, contentType: 'text/markdown; charset=utf-8', body: lines.join('\n') };
}

/** 待确认提议的分页（1B 提议多，单独取）。 */
export async function listProposals(
  client: pg.PoolClient,
  account: string,
  dossier: string,
  query: {
    kind?: string;
    batchId?: string;
    doubt?: boolean;
    status?: string;
    cursor?: number;
    limit?: number;
    /** newest（默认，新的在前）或 oldest。 */
    sort?: 'newest' | 'oldest';
  },
): Promise<{ proposals: Proposal[]; nextCursor: number | null }> {
  const world = await loadWorld(client, account, dossier);
  const statuses = query.status ? [query.status] : ['pending', 'deferred'];
  let items = world.document.proposals.filter((proposal) => statuses.includes(proposal.status));
  if (query.kind) items = items.filter((proposal) => proposal.kind === query.kind);
  if (query.batchId) items = items.filter((proposal) => proposal.batchId === query.batchId);
  if (query.doubt === true) items = items.filter((proposal) => proposal.doubts.length > 0);
  if (query.doubt === false) items = items.filter((proposal) => proposal.doubts.length === 0);
  // 验收 B4：默认新的在前（提议是按产生顺序追加的，倒过来就是「刚交的」在前）。
  if ((query.sort ?? 'newest') === 'newest') items = [...items].reverse();
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const start = Math.max(0, query.cursor ?? 0);
  const page = items.slice(start, start + limit);
  const next = start + limit < items.length ? start + limit : null;
  return { proposals: page, nextCursor: next };
}
