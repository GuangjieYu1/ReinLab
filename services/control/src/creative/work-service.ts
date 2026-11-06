/**
 * 作品服务（design/prd/20-creative-contract.md §5.2）：
 * 建作品、读作品、WorkOp 原子批次、正文接受、正文标注、导出。
 *
 * 作品行按 (档案, 作品) 存一份 jsonb，revision 自己走；世界观那边只多一条
 * 「提议被接受了」的记录。正文改完推 creative.text，作品结构改完推 creative.work。
 */

import type pg from 'pg';
import type {
  CreativeAppliedOp,
  Proposal,
  TextEdit,
  Work,
  WorkOp,
} from '@reinlab/contracts';
import { ApiFailure } from '../api/errors';
import { appendEvents } from './events';
import { loadWorld, requireCreativeDossier } from './service';
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

export type WorkBatchOutcome = {
  revision: number;
  work: Work;
  applied: { op: string; summary: string }[];
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

  const acceptOps = request.ops.filter((op): op is Extract<WorkOp, { op: 'text.accept' }> => op.op === 'text.accept');
  const restOps = request.ops.filter((op) => op.op !== 'text.accept');
  const outcome = restOps.length
    ? applyWorkOps(state.document, restOps)
    : { next: state.document, applied: [] as { op: string; summary: string }[], touchedScenes: [], proposalIds: [] as string[] };
  const document = outcome.next;
  const applied: { op: string; summary: string }[] = [...outcome.applied];
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

  const world = await loadWorld(client, account, dossier);
  const conflicts = await currentConflicts(client, account, dossier);
  return {
    revision,
    work: project(document, revision, { withText: true, world: world.document, conflicts }),
    applied,
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
  query: { kind?: string; batchId?: string; doubt?: boolean; status?: string; cursor?: number; limit?: number },
): Promise<{ proposals: Proposal[]; nextCursor: number | null }> {
  const world = await loadWorld(client, account, dossier);
  const statuses = query.status ? [query.status] : ['pending', 'deferred'];
  let items = world.document.proposals.filter((proposal) => statuses.includes(proposal.status));
  if (query.kind) items = items.filter((proposal) => proposal.kind === query.kind);
  if (query.batchId) items = items.filter((proposal) => proposal.batchId === query.batchId);
  if (query.doubt === true) items = items.filter((proposal) => proposal.doubts.length > 0);
  if (query.doubt === false) items = items.filter((proposal) => proposal.doubts.length === 0);
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const start = Math.max(0, query.cursor ?? 0);
  const page = items.slice(start, start + limit);
  const next = start + limit < items.length ? start + limit : null;
  return { proposals: page, nextCursor: next };
}
