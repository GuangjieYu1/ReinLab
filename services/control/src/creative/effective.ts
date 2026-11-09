/**
 * 「这部作品实际用的设定」（1C 契约 §6.3）。
 *
 * 基准版本的快照 + 逐条采用（picks）+ 本作品改写（overrides）。检查、轨迹、写作助手、设定顾问
 * 在这部作品里一律按它来；世界观草稿怎么改都不偷偷改到它。
 */

import type pg from 'pg';
import type { CreativeDocument } from './world';
import { ApiFailure } from '../api/errors';
import { loadWorld, requireCreativeDossier } from './service';
import { effectiveDocument, settingStateOf, type EffectiveSource } from './settings';
import { itemMapOf } from './items';
import type { WorkDocument } from './work';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EffectiveWorld = {
  work: WorkDocument;
  workRevision: number;
  document: CreativeDocument;
  sources: Map<string, EffectiveSource>;
  /** 用到的版本快照（页面要显示「基于 v1」这类信息时用）。 */
  baseVersion: number;
  picked: { itemId: string; fromVersion: number }[];
  overridden: string[];
};

/** 按作品的组合还原它实际用的世界；没有 picks/overrides 时就是当前草稿。 */
export async function effectiveWorldOf(
  client: pg.PoolClient,
  account: string,
  dossier: string,
  workId: string,
): Promise<EffectiveWorld> {
  if (!UUID.test(workId)) throw new ApiFailure('WORK_NOT_FOUND', 404, '找不到这部作品。');
  await requireCreativeDossier(client, account, dossier);
  const row = (
    await client.query<{ revision: number; document: WorkDocument }>(
      'select revision, document from creative_work where account_id=$1 and dossier_id=$2 and work_id=$3',
      [account, dossier, workId],
    )
  ).rows[0];
  if (!row) throw new ApiFailure('WORK_NOT_FOUND', 404, '找不到这部作品。');
  const state = settingStateOf(row.document);
  const world = await loadWorld(client, account, dossier);
  const baseVersion = row.document.baseVersion;
  // 没有 picks/overrides 时也必须从 baseVersion 的快照起算（验收 C3：以前返回的是草稿）
  const baseRow =
    baseVersion > 0
      ? (
          await client.query<{ world: CreativeDocument }>(
            'select world from creative_version where account_id=$1 and dossier_id=$2 and n=$3',
            [account, dossier, baseVersion],
          )
        ).rows[0]
      : undefined;
  if (!state.picks.length && !state.overrides.length) {
    const document = JSON.parse(JSON.stringify(baseRow?.world ?? world.document)) as CreativeDocument;
    for (const item of itemMapOf(document).values()) (item.value as Record<string, unknown>).setting = 'base';
    return {
      work: row.document,
      workRevision: Number(row.revision),
      document,
      sources: new Map(),
      baseVersion,
      picked: [],
      overridden: [],
    };
  }

  const wanted = new Set<number>([...state.picks.map((pick) => pick.fromVersion), baseVersion].filter((n) => n > 0));
  const versionRows = (
    await client.query<{ n: number; world: CreativeDocument }>(
      'select n, world from creative_version where account_id=$1 and dossier_id=$2 and n = any($3::int[])',
      [account, dossier, [...wanted]],
    )
  ).rows;
  const versions = new Map<number, CreativeDocument>(versionRows.map((item) => [Number(item.n), item.world]));
  const base = versions.get(baseVersion) ?? baseRow?.world ?? world.document;
  const built = effectiveDocument({ base, versions, setting: state });
  return {
    work: row.document,
    workRevision: Number(row.revision),
    document: built.document,
    sources: built.sources,
    baseVersion,
    picked: state.picks.map((pick) => ({ itemId: pick.itemId, fromVersion: pick.fromVersion })),
    overridden: state.overrides.map((override) => override.itemId),
  };
}

/** 世界的草稿（没按作品看时用）。 */
export async function draftWorldOf(
  client: pg.PoolClient,
  account: string,
  dossier: string,
): Promise<CreativeDocument> {
  return (await loadWorld(client, account, dossier)).document;
}
