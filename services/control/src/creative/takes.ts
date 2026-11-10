/**
 * 出片候选（契约 §13.9 3B）：预演转 mp4 → TOS 签名 → Seedance → 取回存本机；选用与拼片。
 */

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { SceneCut, Shot, ShotTake } from '@reinlab/contracts';
import { ApiFailure } from '../api/errors';
import { appendEvents } from './events';
import { loadWorld } from './service';
import { readImage, saveImage } from './image/store';
import { selectedPortraits, selectedVersions } from './asset-query';
import {
  concatVideos,
  extractPoster,
  pollSeedance,
  submitSeedance,
  transcodeToMp4,
  uploadAndSign,
  videoCost,
  type VideoDeps,
} from './video/pipeline';
import type { WorkDocument } from './work';

type TakeList = ShotTake[];

const takesOf = (document: { takes?: unknown[] }): TakeList => (document.takes ?? []) as TakeList;
const shotsOf = (document: { shots?: unknown[] }): Shot[] => (document.shots ?? []) as Shot[];

const FURNITURE_LABEL = /八仙桌|长凳|方凳|椅|条案|柜台|货架|碗架|茶炉|屏风|门|窗|灯|坛|匾额/;

/** 按 §13.9 第 3 条的结构拼提示词。 */
export function promptOfTake(input: {
  shot: Shot;
  prims: { label?: string; material?: string }[];
  cast: { name: string; index: number }[];
  artStyle: string | null;
  doors: string[];
}): string {
  const furniture = [...new Set(input.prims.map((prim) => prim.label ?? '').filter((label) => FURNITURE_LABEL.test(label)))];
  const people = input.cast.map((member) => `@图片${member.index} 里的${member.name}`);
  return [
    '完全参考 @视频1 的机位、构图、镜头推进、家具位置和人物走位：@视频1 是白模预演，木色的是家具',
    furniture.length ? `（画面里的家具：${furniture.join('、')}）` : '',
    people.length ? `，${people.join('、')}` : '',
    '。',
    input.doors.length ? `门在 ${input.doors.join('、')}，画面里的墙上没有门。` : '',
    `这一镜：${input.shot.action}`,
    input.shot.dialogue ? `对白：「${input.shot.dialogue}」。` : '',
    input.shot.light ? `光线：${input.shot.light}。` : '',
    input.artStyle ? `画风：${input.artStyle}。` : '',
    '电影感，镜头稳定，人物五官和服装与参考图一致。',
  ]
    .filter(Boolean)
    .join('');
}

export async function startTake(
  client: pg.PoolClient,
  account: string,
  dossier: string,
  shotId: string,
  input: { resolution?: '480p' | '720p'; durationSec?: number; note?: string; draftTakeId?: string | null },
): Promise<ShotTake> {
  const state = await loadWorld(client, account, dossier, { lock: true });
  const shot = shotsOf(state.document).find((item) => item.id === shotId);
  if (!shot) throw new ApiFailure('SHOT_NOT_FOUND', 404, '没有这个镜头。');
  if (!shot.preview?.url) throw new ApiFailure('PREVIEW_MISSING', 422, '先在视口里录一段预演，再出片。');
  const box = (state.document.whiteboxes ?? []) as { placeId: string; version: number; prims: { label?: string }[] }[];
  const current = box.filter((item) => item.placeId === shot.placeId).sort((a, b) => a.version - b.version).at(-1);
  const takes = takesOf(state.document);
  const draft = input.draftTakeId ? takes.find((item) => item.id === input.draftTakeId) : null;
  const resolution = input.resolution ?? (draft ? '720p' : '480p');
  const take: ShotTake = {
    id: `tk_${randomUUID().slice(0, 12)}`,
    shotId,
    n: takes.filter((item) => item.shotId === shotId).length + 1,
    createdAt: new Date().toISOString(),
    state: 'queued',
    durationSec: input.durationSec ?? shot.durationSec,
    resolution,
    basis: {
      shotHash: String(shot.id),
      whiteboxVersion: current?.version ?? shot.whiteboxVersion,
      refImages: [],
      previewId: shot.preview.previewId,
      mode: shot.preview ? 'reference_video' : 'reference_image_only',
      prompt: '',
      ...(draft ? { draftTakeId: draft.id } : {}),
    },
    provider: 'unknown',
    model: 'unknown',
    cost: null,
  };
  await client.query('update creative_world set revision=$3, document=$4::jsonb, updated_at=now() where account_id=$1 and dossier_id=$2', [
    account,
    dossier,
    state.revision + 1,
    JSON.stringify({ ...state.document, takes: [...takes, take] }),
  ]);
  await appendEvents(client, { account, dossier }, [{ type: 'creative.take', data: take }]);
  return take;
}

const patchTake = async (
  db: import('../db/database').Database,
  account: string,
  dossier: string,
  takeId: string,
  patch: Partial<ShotTake>,
): Promise<ShotTake | null> => {
  return db.withAccount(account, async (client) => {
    const state = await loadWorld(client, account, dossier, { lock: true });
    const takes = takesOf(state.document);
    const index = takes.findIndex((item) => item.id === takeId);
    if (index < 0) return null;
    const next = { ...takes[index]!, ...patch } as ShotTake;
    takes[index] = next;
    await client.query('update creative_world set revision=$3, document=$4::jsonb, updated_at=now() where account_id=$1 and dossier_id=$2', [
      account,
      dossier,
      state.revision + 1,
      JSON.stringify({ ...state.document, takes }),
    ]);
    await appendEvents(client, { account, dossier }, [{ type: 'creative.take', data: next }]);
    return next;
  });
};

const recordUsage = async (
  db: import('../db/database').Database,
  account: string,
  dossier: string,
  provider: string,
  model: string,
  cost: ShotTake['cost'],
  note?: string,
) => {
  await db.withAccount(account, async (client) => {
    await client.query(
      `insert into usage_record(id,account_id,dossier_id,run_id,provider,model,known,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_cny,purpose,note)
       values(gen_random_uuid(),$1,$2,null,$3,$4,$5,null,null,null,null,$6,'creative_video',$7)`,
      [account, dossier, provider, model, Boolean(cost?.known), cost?.known && cost.value !== null ? cost.value.toFixed(6) : null, note ?? null],
    );
  });
};

/** 真出片：转码 → 上传签名 → 提交 → 轮询 → 取回存本机。 */
export async function runTake(
  deps: VideoDeps & { db: import('../db/database').Database },
  account: string,
  dossier: string,
  takeId: string,
): Promise<void> {
  const db = deps.db;
  const seedance = deps.seedance;
  if (!seedance) {
    await patchTake(db, account, dossier, takeId, { state: 'failed', failure: '本机没配置出片平台（缺 ARK_API_KEY）。' });
    return;
  }
  const context = await db.withAccount(account, async (client) => {
    const state = await loadWorld(client, account, dossier);
    const take = takesOf(state.document).find((item) => item.id === takeId);
    if (!take) throw new ApiFailure('TAKE_NOT_FOUND', 404, '这个候选不在了。');
    const shot = shotsOf(state.document).find((item) => item.id === take.shotId);
    if (!shot) throw new ApiFailure('SHOT_NOT_FOUND', 404, '镜头不在了。');
    const box = (state.document.whiteboxes ?? []) as { placeId: string; version: number; prims: { label?: string }[] }[];
    const current = box.filter((item) => item.placeId === shot.placeId).sort((a, b) => a.version - b.version).at(-1);
    const portraits = await selectedPortraits(client, account, dossier);
    const versions = await selectedVersions(client, account, dossier);
    return { state, take, shot, prims: current?.prims ?? [], portraits, versions };
  });
  const { state, take, shot, prims, portraits } = context;
  try {
    // 1) 预演 webm → mp4
    const previewUrl = shot.preview?.url;
    if (!previewUrl) throw new Error('这一镜没有预演片段。');
    const fileId = previewUrl.split('/').pop() ?? '';
    const preview = await db.withAccount(account, (client) => readImage(client, { account, fileId }));
    const mp4 = await transcodeToMp4(deps, new Uint8Array(preview.bytes));
    // 2) 上传 TOS 拿签名链接
    if (!deps.tos) throw new Error('本机没配置 TOS（缺 TOS_* 密钥），参考视频传不上去。');
    const key = `creative/${dossier}/${shot.id}/${take.id}-${Date.now()}.mp4`;
    const videoUrl = await uploadAndSign(deps.tos, key, mp4, 'video/mp4');
    // 3) 参考图：每个出场人物选用形象的立绘
    const refImages: { mime: string; bytes: Uint8Array }[] = [];
    const cast: { name: string; index: number }[] = [];
    for (const member of shot.cast) {
      const portrait = portraits.get(member.entityId);
      if (!portrait) continue;
      const pid = portrait.url.split('/').pop() ?? '';
      try {
        const image = await db.withAccount(account, (client) => readImage(client, { account, fileId: pid }));
        cast.push({ name: state.document.entities.find((entity) => entity.id === member.entityId)?.name ?? '人物', index: refImages.length + 1 });
        refImages.push({ mime: image.mime, bytes: new Uint8Array(image.bytes) });
      } catch {
        continue;
      }
    }
    const doors = prims.map((prim) => prim.label ?? '').filter((label) => /门/.test(label));
    const prompt = promptOfTake({
      shot,
      prims,
      cast,
      artStyle: (state.document as { artStyle?: string | null }).artStyle ?? null,
      doors: doors.length ? ['南墙正中（镜头背后）'] : [],
    });
    // 4) 提交 + 轮询
    const submitted = await submitSeedance(seedance, {
      prompt,
      refImages: refImages.slice(0, 9),
      referenceVideoUrl: videoUrl,
      resolution: take.resolution,
      durationSec: take.durationSec,
    });
    await patchTake(db, account, dossier, takeId, {
      state: 'generating',
      provider: 'volcengine-ark',
      model: seedance.model ?? 'doubao-seedance-2-0-260128',
      taskId: submitted.taskId,
      basis: { ...take.basis, refImages: cast.map((member) => ({ assetVersionId: '', view: 'portrait' as const })), prompt, mode: 'reference_video' },
    });
    let result = await pollSeedance(seedance, submitted.taskId);
    const started = Date.now();
    while (result.state === 'running' && Date.now() - started < 12 * 60 * 1000) {
      await new Promise((done) => setTimeout(done, 8000));
      result = await pollSeedance(seedance, submitted.taskId);
    }
    if (result.state === 'failed') throw new Error(result.error);
    if (result.state === 'running') throw new Error('等太久还没出（超过 12 分钟）。');
    // 5) 取回存本机
    const videoResponse = await fetch(result.videoUrl, { signal: AbortSignal.timeout(180_000) });
    if (!videoResponse.ok) throw new Error(`片子取不回来（${videoResponse.status}）。`);
    const bytes = new Uint8Array(await videoResponse.arrayBuffer());
    const file = await db.withAccount(account, (client) => saveImage(client, { account, dossier, bytes, mime: 'video/mp4', width: null, height: null }));
    let posterUrl: string | null = null;
    try {
      const poster = await extractPoster(deps, bytes);
      const posterFile = await db.withAccount(account, (client) => saveImage(client, { account, dossier, bytes: poster, mime: 'image/jpeg', width: null, height: null }));
      posterUrl = posterFile.url;
    } catch {
      posterUrl = null;
    }
    const cost = videoCost(seedance, result.usage, true);
    await patchTake(db, account, dossier, takeId, { state: 'saved', url: file.url, posterUrl, cost });
    await recordUsage(db, account, dossier, 'volcengine-ark', seedance.model ?? 'doubao-seedance-2-0-260128', cost);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await patchTake(db, account, dossier, takeId, { state: 'failed', failure: message.slice(0, 300) });
    await recordUsage(db, account, dossier, 'volcengine-ark', seedance.model ?? 'doubao-seedance-2-0-260128', { value: 0, known: true }, '平台未收费：这一镜没出成');
  }
}

/** 选用；null 取消。 */
export async function selectTake(
  client: pg.PoolClient,
  account: string,
  dossier: string,
  shotId: string,
  takeId: string | null,
): Promise<Shot[]> {
  const state = await loadWorld(client, account, dossier, { lock: true });
  const shots = shotsOf(state.document);
  const index = shots.findIndex((item) => item.id === shotId);
  if (index < 0) throw new ApiFailure('SHOT_NOT_FOUND', 404, '没有这个镜头。');
  if (takeId && !takesOf(state.document).some((item) => item.id === takeId && item.shotId === shotId))
    throw new ApiFailure('TAKE_NOT_FOUND', 404, '没有这个候选。');
  shots[index] = { ...shots[index]!, selectedTakeId: takeId };
  await client.query('update creative_world set revision=$3, document=$4::jsonb, updated_at=now() where account_id=$1 and dossier_id=$2', [
    account,
    dossier,
    state.revision + 1,
    JSON.stringify({ ...state.document, shots }),
  ]);
  await appendEvents(client, { account, dossier }, [{ type: 'creative.shot', data: { workId: shots[index]!.workId, sceneId: shots[index]!.sceneId, shots } }]);
  return shots;
}

/** 拼成片：按镜号顺序硬切拼接选用的候选。 */
export async function cutScene(
  deps: VideoDeps & { db: import('../db/database').Database },
  account: string,
  dossier: string,
  workId: string,
  sceneId: string,
): Promise<SceneCut> {
  const db = deps.db;
  const state = await db.withAccount(account, (client) => loadWorld(client, account, dossier));
  const shots = shotsOf(state.document)
    .filter((shot) => shot.workId === workId && shot.sceneId === sceneId)
    .sort((a, b) => a.n - b.n);
  const missing = shots.filter((shot) => !shot.selectedTakeId).map((shot) => `第 ${shot.n} 镜`);
  if (!shots.length) throw new ApiFailure('SHOT_NOT_FOUND', 404, '这一场还没有镜头。');
  if (missing.length) throw new ApiFailure('CUT_INCOMPLETE', 422, `这些镜头还没选用候选：${missing.join('、')}`);
  const takes = takesOf(state.document);
  const videos: Uint8Array[] = [];
  let totalSec = 0;
  for (const shot of shots) {
    const take = takes.find((item) => item.id === shot.selectedTakeId);
    if (!take?.url) throw new ApiFailure('CUT_INCOMPLETE', 422, `第 ${shot.n} 镜的候选还没有片子。`);
    const fileId = take.url.split('/').pop() ?? '';
    const file = await db.withAccount(account, (client) => readImage(client, { account, fileId }));
    videos.push(new Uint8Array(file.bytes));
    totalSec += take.durationSec;
  }
  const cut: SceneCut = {
    workId,
    sceneId,
    shots: shots.map((shot) => ({ shotId: shot.id, takeId: shot.selectedTakeId ?? null })),
    file: { state: 'building' },
  };
  await db.withAccount(account, async (client) => {
    const current = await loadWorld(client, account, dossier, { lock: true });
    const cuts = ((current.document.cuts ?? []) as SceneCut[]).filter((item) => !(item.workId === workId && item.sceneId === sceneId));
    await client.query('update creative_world set revision=$3, document=$4::jsonb, updated_at=now() where account_id=$1 and dossier_id=$2', [
      account,
      dossier,
      current.revision + 1,
      JSON.stringify({ ...current.document, cuts: [...cuts, cut] }),
    ]);
    await appendEvents(client, { account, dossier }, [{ type: 'creative.cut', data: cut }]);
  });
  try {
    const merged = await concatVideos(deps, videos);
    const file = await db.withAccount(account, (client) => saveImage(client, { account, dossier, bytes: merged, mime: 'video/mp4', width: null, height: null }));
    cut.file = { state: 'saved', url: file.url, durationSec: totalSec };
  } catch (error) {
    cut.file = { state: 'failed', failure: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
  }
  await db.withAccount(account, async (client) => {
    const current = await loadWorld(client, account, dossier, { lock: true });
    const cuts = ((current.document.cuts ?? []) as SceneCut[]).filter((item) => !(item.workId === workId && item.sceneId === sceneId));
    await client.query('update creative_world set revision=$3, document=$4::jsonb, updated_at=now() where account_id=$1 and dossier_id=$2', [
      account,
      dossier,
      current.revision + 1,
      JSON.stringify({ ...current.document, cuts: [...cuts, cut] }),
    ]);
    await appendEvents(client, { account, dossier }, [{ type: 'creative.cut', data: cut }]);
  });
  return cut;
}
