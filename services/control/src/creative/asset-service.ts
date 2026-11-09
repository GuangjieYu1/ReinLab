/**
 * 人物形象资产（MVP-2 契约 §12）。
 *
 * 资产 ID 每人物一个、稳定；每次出图是新版本（新的在前）。图片本体落本机磁盘（image/store.ts），
 * 文档里只存元数据。出图描述由服务端拼：artStyle + look + 作者 note，视图要求写死在 VIEW_PROMPT 里。
 * 每一格状态变化推 creative.asset；每张图记一条 usage_record（purpose: creative_image）。
 */

import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { AssetImage, PersonAsset, PersonAssetVersion, PersonView } from '@reinlab/contracts';
import { ApiFailure } from '../api/errors';
import { appendEvents } from './events';
import { loadWorld } from './service';
import { saveImage } from './image/store';
import { selectedPortraits } from './asset-query';
import { ImageProviderUnavailable, UnsavedImageError, type ImageProvider } from './image/provider';

export const VIEWS: PersonView[] = ['portrait', 'front', 'side', 'back'];

const VIEW_PROMPT: Record<PersonView, string> = {
  portrait: '人物立绘：正面半身到全身皆可，单人，白底，姿势自然，不要文字、不要边框。',
  front: '三视图之一：同一人物的正面全身，站姿挺直、双臂自然下垂，白底，不要文字、不要背景道具。',
  side: '三视图之一：同一人物的正侧面全身（朝右），站姿挺直，白底，不要文字。',
  back: '三视图之一：同一人物的背面全身，站姿挺直，白底，不要文字。',
};

/** 拼出图描述：画风 + 外貌 + 作者备注 + 这一格的要求。 */
export function promptOf(input: {
  artStyle: string | null;
  look: string;
  note?: string | null;
  view: PersonView;
}): string {
  return [
    input.artStyle ? `画风：${input.artStyle}。` : '',
    `人物外貌：${input.look}`,
    input.note ? `作者补充：${input.note}` : '',
    VIEW_PROMPT[input.view],
  ]
    .filter(Boolean)
    .join('\n');
}

type AssetDocument = PersonAsset;

const emptyAsset = (entityId: string): AssetDocument => ({
  // 资产 ID 稳定：没出过图时也按实体派生，反复读到的都是同一个
  id: `ast_${createHash('sha256').update(entityId).digest('hex').slice(0, 12)}`,
  entityId,
  selectedVersionId: null,
  versions: [],
});

export async function readAsset(
  client: pg.PoolClient,
  account: string,
  dossier: string,
  entityId: string,
): Promise<AssetDocument> {
  const row = (
    await client.query<{ document: AssetDocument }>(
      'select document from creative_person_asset where account_id=$1 and dossier_id=$2 and entity_id=$3',
      [account, dossier, entityId],
    )
  ).rows[0];
  return row?.document ?? emptyAsset(entityId);
}

const saveAsset = async (client: pg.PoolClient, account: string, dossier: string, asset: AssetDocument) => {
  await client.query(
    `insert into creative_person_asset(account_id,dossier_id,entity_id,asset_id,document,updated_at)
     values($1,$2,$3,$4,$5::jsonb,now())
     on conflict (account_id,dossier_id,entity_id)
     do update set asset_id=excluded.asset_id, document=excluded.document, updated_at=now()`,
    [account, dossier, asset.entityId, asset.id, JSON.stringify(asset)],
  );
};

export type AssetRunDeps = {
  db: import('../db/database').Database;
  provider?: ImageProvider;
};

const patchView = (
  asset: AssetDocument,
  versionId: string,
  view: PersonView,
  patch: Partial<AssetImage>,
): AssetDocument => ({
  ...asset,
  versions: asset.versions.map((version) =>
    version.id === versionId ? { ...version, views: { ...version.views, [view]: { ...version.views[view], ...patch } as AssetImage } } : version,
  ),
});

const emit = async (
  client: pg.PoolClient,
  account: string,
  dossier: string,
  asset: AssetDocument,
  versionId: string,
) => {
  const version = asset.versions.find((item) => item.id === versionId);
  if (version)
    await appendEvents(client, { account, dossier }, [
      { type: 'creative.asset', data: { entityId: asset.entityId, assetId: asset.id, version } },
    ]);
};

const pushVersion = async (
  db: AssetRunDeps['db'],
  account: string,
  dossier: string,
  entityId: string,
  versionId: string,
  view: PersonView,
  patch: Partial<AssetImage>,
) => {
  await db.withAccount(account, async (client) => {
    const asset = await readAsset(client, account, dossier, entityId);
    const next = patchView(asset, versionId, view, patch);
    await saveAsset(client, account, dossier, next);
    await emit(client, account, dossier, next, versionId);
  });
};

const recordUsage = async (
  db: AssetRunDeps['db'],
  account: string,
  dossier: string,
  provider: ImageProvider,
  cost: PersonAssetVersion['cost'],
) => {
  await db.withAccount(account, async (client) => {
    await client.query(
      `insert into usage_record(id,account_id,dossier_id,run_id,provider,model,known,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_cny,purpose)
       values(gen_random_uuid(),$1,$2,null,$3,$4,$5,null,null,null,null,$6,'creative_image')`,
      [
        account,
        dossier,
        provider.name,
        provider.model,
        Boolean(cost?.known),
        cost?.known && cost.value !== null ? cost.value.toFixed(6) : null,
      ],
    );
  });
};

/** 出一版：立绘先出，三视图拿立绘当参考；只重出某几格时用 from 版的立绘当参考。 */
export async function startAssetVersion(
  client: pg.PoolClient,
  account: string,
  dossier: string,
  entityId: string,
  input: { views?: PersonView[]; note?: string; from?: string | null },
): Promise<{ asset: AssetDocument; version: PersonAssetVersion }> {
  const state = await loadWorld(client, account, dossier);
  const entity = state.document.entities.find((item) => item.id === entityId);
  if (!entity || entity.kind !== 'person') throw new ApiFailure('ENTITY_NOT_FOUND', 404, '没有这个人物。');
  const look = String(entity.person?.look ?? '').trim();
  if (!look) throw new ApiFailure('LOOK_MISSING', 422, '先写外貌（person.look），再出形象。');
  const required = input.views?.length ? [...new Set(input.views)] : VIEWS;
  if (required.some((view) => !VIEWS.includes(view))) throw new ApiFailure('INVALID_INPUT', 400, '视图只能是 portrait/front/side/back。');

  const asset = await readAsset(client, account, dossier, entityId);
  const from = input.from ? asset.versions.find((item) => item.id === input.from) : undefined;
  if (input.from && !from) throw new ApiFailure('VERSION_NOT_FOUND', 404, '要参考的那一版不在了。');
  const views: Partial<Record<PersonView, AssetImage>> = {};
  for (const view of VIEWS) {
    if (required.includes(view)) views[view] = { state: 'queued' };
    else if (from?.views[view]) views[view] = { ...from.views[view] };
  }
  const version: PersonAssetVersion = {
    id: `v_${randomUUID().slice(0, 12)}`,
    n: asset.versions.length + 1,
    createdAt: new Date().toISOString(),
    basis: {
      revision: state.revision,
      look,
      artStyle: (state.document as { artStyle?: string | null }).artStyle ?? null,
      ...(input.note ? { note: input.note } : {}),
    },
    ...(input.from ? { from: input.from } : {}),
    views,
    provider: 'unknown',
    model: 'unknown',
    cost: null,
  };
  const next: AssetDocument = { ...asset, versions: [version, ...asset.versions] };
  await saveAsset(client, account, dossier, next);
  await emit(client, account, dossier, next, version.id);
  return { asset: next, version };
}

/** 真的出图：逐格跑，每格状态变化推事件；已花过的钱不重复花。 */
export async function runAssetVersion(
  deps: AssetRunDeps,
  account: string,
  dossier: string,
  entityId: string,
  versionId: string,
  input: { views?: PersonView[] } = {},
): Promise<void> {
  const provider = deps.provider;
  if (!provider) throw new ApiFailure('IMAGE_PROVIDER_MISSING', 503, '还没接出图的平台。');
  const head = await deps.db.withAccount(account, (client) => readAsset(client, account, dossier, entityId));
  const version = head.versions.find((item) => item.id === versionId);
  if (!version) throw new ApiFailure('VERSION_NOT_FOUND', 404, '这一版不在了。');
  const targets = (input.views?.length ? input.views : VIEWS).filter((view) => {
    const cell = version.views[view];
    return cell && (cell.state === 'queued' || cell.state === 'failed' || cell.state === 'unsaved');
  });
  if (!provider.available()) {
    for (const view of targets) {
      await pushVersion(deps.db, account, dossier, entityId, versionId, view, {
        state: 'failed',
        failure: '出图的平台还没配好（缺 ARK_API_KEY）。',
      });
    }
    throw new ImageProviderUnavailable();
  }

  // 版本上写清是谁出的
  await deps.db.withAccount(account, async (client) => {
    const asset = await readAsset(client, account, dossier, entityId);
    const next = {
      ...asset,
      versions: asset.versions.map((item) =>
        item.id === versionId ? { ...item, provider: provider.name, model: provider.model } : item,
      ),
    };
    await saveAsset(client, account, dossier, next);
    await emit(client, account, dossier, next, versionId);
  });

  // 立绘先出，其余格拿它当参考
  const order: PersonView[] = (['portrait', 'front', 'side', 'back'] as PersonView[]).filter((view) => targets.includes(view));
  let referenceBytes: Uint8Array | null = null;
  let referenceMime = 'image/png';
  if (!order.includes('portrait')) {
    const fromVersion = version.from ? head.versions.find((item) => item.id === version.from) : undefined;
    const base = fromVersion?.views.portrait ?? version.views.portrait;
    if (base?.state === 'saved' && base.url) {
      try {
        const { readImage } = await import('./image/store');
        const fileId = base.url.split('/').pop() ?? '';
        const file = await deps.db.withAccount(account, (client) => readImage(client, { account, fileId }));
        referenceBytes = new Uint8Array(file.bytes);
        referenceMime = file.mime;
      } catch {
        referenceBytes = null;
      }
    }
  }
  for (const view of order) {
    await pushVersion(deps.db, account, dossier, entityId, versionId, view, { state: 'generating' });
    try {
      const output = await provider.generate({
        prompt: promptOf({ artStyle: version.basis.artStyle, look: version.basis.look, note: version.basis.note, view }),
        reference: referenceBytes ? { bytes: referenceBytes, mime: referenceMime } : null,
      });
      if (view === 'portrait') {
        referenceBytes = output.bytes;
        referenceMime = output.mime;
      }
      const file = await deps.db.withAccount(account, (client) =>
        saveImage(client, {
          account,
          dossier,
          bytes: output.bytes,
          mime: output.mime,
          width: output.width,
          height: output.height,
        }),
      );
      await pushVersion(deps.db, account, dossier, entityId, versionId, view, {
        state: 'saved',
        url: file.url,
        width: output.width,
        height: output.height,
        taskId: output.taskId,
      });
      await recordUsage(deps.db, account, dossier, provider, output.cost);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 取回失败（有临时地址/任务号）：标「待保存」，可以只重试取回；平台直接拒绝就是 failed
      const pending = error instanceof UnsavedImageError ? error : null;
      await pushVersion(deps.db, account, dossier, entityId, versionId, view, {
        state: pending ? 'unsaved' : 'failed',
        failure: message.slice(0, 300),
        ...(pending?.pendingUrl ? { url: pending.pendingUrl } : {}),
        ...(pending?.taskId ? { taskId: pending.taskId } : {}),
      });
      await recordUsage(deps.db, account, dossier, provider, null);
    }
  }
}

/** 只重试取回：unsaved 的格子重新取一次，不重新付费。 */
export async function retryUnsaved(
  deps: AssetRunDeps,
  account: string,
  dossier: string,
  entityId: string,
  versionId: string,
): Promise<void> {
  await deps.db.withAccount(account, async (client) => {
    const asset = await readAsset(client, account, dossier, entityId);
    const version = asset.versions.find((item) => item.id === versionId);
    if (!version) throw new ApiFailure('VERSION_NOT_FOUND', 404, '这一版不在了。');
    for (const view of VIEWS) {
      const cell = version.views[view];
      if (!cell || cell.state !== 'unsaved' || !cell.url) continue;
      try {
        const image = await fetch(cell.url, { signal: AbortSignal.timeout(120_000) });
        if (!image.ok) throw new Error(`取不回来（${image.status}）`);
        const bytes = new Uint8Array(await image.arrayBuffer());
        const file = await saveImage(client, { account, dossier, bytes, mime: image.headers.get('content-type') ?? 'image/png', width: null, height: null });
        const next = patchView(asset, versionId, view, { state: 'saved', url: file.url, failure: null });
        await saveAsset(client, account, dossier, next);
        await emit(client, account, dossier, next, versionId);
      } catch (error) {
        const next = patchView(asset, versionId, view, {
          failure: `还是取不回来：${error instanceof Error ? error.message : String(error)}`.slice(0, 300),
        });
        await saveAsset(client, account, dossier, next);
        await emit(client, account, dossier, next, versionId);
      }
    }
  });
}

/** 停掉还没开始的格子（已经在出的照常出完，钱已花）。 */
export async function stopAssetVersion(
  client: pg.PoolClient,
  account: string,
  dossier: string,
  entityId: string,
  versionId: string,
): Promise<AssetDocument> {
  const asset = await readAsset(client, account, dossier, entityId);
  const version = asset.versions.find((item) => item.id === versionId);
  if (!version) throw new ApiFailure('VERSION_NOT_FOUND', 404, '这一版不在了。');
  let next = asset;
  for (const view of VIEWS) {
    if (version.views[view]?.state !== 'queued') continue;
    next = patchView(next, versionId, view, { state: 'failed', failure: '已停止（还没开始）。' });
  }
  await saveAsset(client, account, dossier, next);
  await emit(client, account, dossier, next, versionId);
  return next;
}

export async function selectVersion(
  client: pg.PoolClient,
  account: string,
  dossier: string,
  entityId: string,
  versionId: string | null,
): Promise<AssetDocument> {
  const asset = await readAsset(client, account, dossier, entityId);
  if (versionId && !asset.versions.some((item) => item.id === versionId))
    throw new ApiFailure('VERSION_NOT_FOUND', 404, '这一版不在了。');
  const next: AssetDocument = { ...asset, selectedVersionId: versionId };
  await saveAsset(client, account, dossier, next);
  const version = next.versions.find((item) => item.id === versionId);
  if (version) await emit(client, account, dossier, next, versionId!);
  return next;
}
