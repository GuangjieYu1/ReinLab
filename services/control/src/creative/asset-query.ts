/** 只读的资产查询（不依赖 service，避免和 asset-service 形成循环引用）。 */
import type pg from 'pg';
import type { PersonAsset } from '@reinlab/contracts';

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
