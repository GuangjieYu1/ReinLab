/**
 * 图片文件存哪儿（契约 §12.3「文件存在 ReinLab 自己这里」）。
 *
 * 本机先用磁盘目录：$REINLAB_CREATIVE_ASSETS 或 ~/.local/state/reinlab/creative-assets/<account>/<dossier>/。
 * 文件按内容 sha256 命名（同一张图只存一份）；元数据记 creative_image_file。
 * 备份就是备份这个目录（和账本一起）。
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { ApiFailure } from '../../api/errors';

export const assetRoot = (): string =>
  process.env.REINLAB_CREATIVE_ASSETS ?? join(homedir(), '.local/state/reinlab/creative-assets');

const extOf = (mime: string): string =>
  mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'bin';

export async function saveImage(
  client: pg.PoolClient,
  input: { account: string; dossier: string; bytes: Uint8Array; mime: string; width: number | null; height: number | null },
): Promise<{ fileId: string; url: string }> {
  const fileId = createHash('sha256').update(input.bytes).digest('hex').slice(0, 40);
  const dir = join(assetRoot(), input.account, input.dossier);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${fileId}.${extOf(input.mime)}`), input.bytes);
  await client.query(
    `insert into creative_image_file(account_id,dossier_id,file_id,mime,bytes,width,height)
     values($1,$2,$3,$4,$5,$6,$7)
     on conflict (account_id,file_id) do nothing`,
    [input.account, input.dossier, fileId, input.mime, input.bytes.byteLength, input.width, input.height],
  );
  return { fileId, url: `/v1/creative/assets/files/${fileId}` };
}

export async function readImage(
  client: pg.PoolClient,
  input: { account: string; fileId: string },
): Promise<{ bytes: Buffer; mime: string }> {
  if (!/^[0-9a-f]{32,64}$/.test(input.fileId)) throw new ApiFailure('FILE_NOT_FOUND', 404, '这张图不存在。');
  const row = (
    await client.query<{ mime: string; dossier_id: string }>(
      'select mime, dossier_id from creative_image_file where file_id=$1 and account_id=$2',
      [input.fileId, input.account],
    )
  ).rows[0];
  if (!row) throw new ApiFailure('FILE_NOT_FOUND', 404, '这张图不存在。');
  const path = join(assetRoot(), input.account, row.dossier_id, `${input.fileId}.${extOf(row.mime)}`);
  try {
    return { bytes: await readFile(path), mime: row.mime };
  } catch {
    throw new ApiFailure('FILE_MISSING', 410, '这张图的文件在磁盘上找不到了（备份目录被清过？）。');
  }
}

export { extOf };
