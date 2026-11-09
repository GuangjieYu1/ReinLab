/** 只读的资产查询（不依赖 service，避免和 asset-service 形成循环引用）。 */
import type pg from 'pg';
import type { PersonAsset } from '@reinlab/contracts';

/** 文件名要用：这张图属于哪个人物、哪个视图、第几版。 */
export async function describeFile(
  client: pg.PoolClient,
  account: string,
  fileId: string,
): Promise<{ entityId: string; dossierId: string; view: string; versionN: number } | null> {
  const rows = (
    await client.query<{ entity_id: string; dossier_id: string; document: PersonAsset }>(
      'select entity_id, dossier_id, document from creative_person_asset where account_id=$1',
      [account],
    )
  ).rows;
  // 同一个文件会被后续版本沿用：取最早的那一版（真正生成它的那版），文件名才对得上
  for (const row of rows) {
    let found: { entityId: string; dossierId: string; view: string; versionN: number } | null = null;
    for (const version of row.document.versions) {
      for (const [view, cell] of Object.entries(version.views)) {
        if (cell?.url && cell.url.endsWith(fileId))
          found = { entityId: row.entity_id, dossierId: row.dossier_id, view, versionN: version.n };
      }
    }
    if (found) return found;
  }
  return null;
}

/** 快照里 person.portrait 要用的：每人物选用版本的立绘。 */
export async function selectedPortraits(
  client: pg.PoolClient,
  account: string,
  dossier: string,
): Promise<Map<string, { assetId: string; url: string }>> {
  const rows = (
    await client.query<{ entity_id: string; document: PersonAsset }>(
      'select entity_id, document from creative_person_asset where account_id=$1 and dossier_id=$2',
      [account, dossier],
    )
  ).rows;
  const map = new Map<string, { assetId: string; url: string }>();
  for (const row of rows) {
    const version = row.document.versions.find((item) => item.id === row.document.selectedVersionId);
    const portrait = version?.views.portrait;
    if (version && portrait?.state === 'saved' && portrait.url)
      map.set(row.entity_id, { assetId: row.document.id, url: portrait.url });
  }
  return map;
}
