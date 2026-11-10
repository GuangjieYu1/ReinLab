/** 只读的资产查询（不依赖 service，避免和 asset-service 形成循环引用）。 */
import type pg from 'pg';
import type { PersonAsset } from '@reinlab/contracts';

/** 每人物当前选用的是哪一版（算镜头是否依据旧了）。 */
export async function selectedVersions(
  client: pg.PoolClient,
  account: string,
  dossier: string,
): Promise<Map<string, { entityId: string; versionId: string | null; versionN: number | null }>> {
  const rows = (
    await client.query<{ entity_id: string; document: PersonAsset }>(
      'select entity_id, document from creative_person_asset where account_id=$1 and dossier_id=$2',
      [account, dossier],
    )
  ).rows;
  const map = new Map<string, { entityId: string; versionId: string | null; versionN: number | null }>();
  for (const row of rows) {
    const version = row.document.versions.find((item) => item.id === row.document.selectedVersionId);
    map.set(row.entity_id, { entityId: row.entity_id, versionId: row.document.selectedVersionId, versionN: version?.n ?? null });
  }
  return map;
}

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

/** 视频文件名：作品-场-镜号-候选号（契约 §13.9）。 */
export async function describeVideoFile(
  client: pg.PoolClient,
  account: string,
  fileId: string,
): Promise<string | null> {
  const rows = (
    await client.query<{ dossier_id: string; document: { shots?: { id: string; n: number; workId: string; sceneId: string }[]; takes?: { id: string; shotId: string; n: number; url?: string | null; posterUrl?: string | null }[]; cuts?: { workId: string; sceneId: string; file?: { url?: string | null } | null }[] } }>(
      'select dossier_id, document from creative_world where account_id=$1',
      [account],
    )
  ).rows;
  for (const row of rows) {
    const doc = row.document;
    for (const take of doc.takes ?? []) {
      if (!take.url?.endsWith(fileId) && !take.posterUrl?.endsWith(fileId)) continue;
      const shot = (doc.shots ?? []).find((item) => item.id === take.shotId);
      if (!shot) continue;
      const work = (
        await client.query<{ title: string }>(
          "select document->>'title' title from creative_work where account_id=$1 and dossier_id=$2 and work_id=$3",
          [account, row.dossier_id, shot.workId],
        )
      ).rows[0]?.title;
      return `${work ?? '作品'}-第${shot.n}镜-候选${take.n}`;
    }
    for (const cut of doc.cuts ?? []) {
      if (!cut.file?.url?.endsWith(fileId)) continue;
      const work = (
        await client.query<{ title: string }>(
          "select document->>'title' title from creative_work where account_id=$1 and dossier_id=$2 and work_id=$3",
          [account, row.dossier_id, cut.workId],
        )
      ).rows[0]?.title;
      const sceneTitle = (
        await client.query<{ title: string }>(
          "select scene->>'title' title from creative_work w, jsonb_array_elements(w.document->'chapters') chapter, jsonb_array_elements(chapter->'scenes') scene where w.account_id=$1 and w.dossier_id=$2 and w.work_id=$3 and scene->>'id'=$4",
          [account, row.dossier_id, cut.workId, cut.sceneId],
        )
      ).rows[0]?.title;
      return `${work ?? '作品'}-${sceneTitle ?? '一场'}-成片`;
    }
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
