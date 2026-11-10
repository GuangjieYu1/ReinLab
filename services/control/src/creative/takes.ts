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
import { colorName, fallbackClothColor, type RGB } from '@reinlab/contracts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const execFileAsync = promisify(execFile);

type TakeList = ShotTake[];

const takesOf = (document: { takes?: unknown[] }): TakeList => (document.takes ?? []) as TakeList;
const shotsOf = (document: { shots?: unknown[] }): Shot[] => (document.shots ?? []) as Shot[];

const FURNITURE_LABEL = /八仙桌|长凳|方凳|椅|条案|柜台|货架|碗架|茶炉|屏风|门|窗|灯|坛|匾额/;

/** 机位能不能看到这个部件（视锥近似：角度 + 距离）。 */
export function inViewOf(camera: { eye: [number, number, number]; target: [number, number, number]; fov: number }, point: [number, number, number]): boolean {
  const dir = [camera.target[0] - camera.eye[0], camera.target[1] - camera.eye[1], camera.target[2] - camera.eye[2]];
  const len = Math.hypot(...dir) || 1;
  const to = [point[0] - camera.eye[0], point[1] - camera.eye[1], point[2] - camera.eye[2]];
  const dist = Math.hypot(...to) || 1;
  const cos = (dir[0] * to[0] + dir[1] * to[1] + dir[2] * to[2]) / (len * dist);
  const half = ((camera.fov || 45) * Math.PI) / 360;
  return Math.acos(Math.max(-1, Math.min(1, cos))) <= half + 0.15 && dist < 30;
}

const facingWord = (facing: number | undefined, at: [number, number, number], camera: { eye: [number, number, number] }): string => {
  if (facing === undefined || Number.isNaN(facing)) return '面向镜头';
  // facing：0 = 朝 -z，顺时针；换成向量
  const rad = ((facing ?? 0) * Math.PI) / 180;
  const dir = [Math.sin(rad), 0, -Math.cos(rad)];
  const toCam = [camera.eye[0] - at[0], 0, camera.eye[2] - at[2]];
  const len = Math.hypot(...toCam) || 1;
  const cos = (dir[0]! * toCam[0]! + dir[2]! * toCam[2]!) / len;
  if (cos > 0.5) return '面向镜头';
  if (cos < -0.5) return '背对镜头';
  return '侧对镜头';
};

const positionWord = (point: [number, number, number], prims: { label?: string; c?: number[] }[]): string => {
  let best: { label: string; distance: number } | null = null;
  for (const prim of prims) {
    if (!prim.label || !prim.c) continue;
    // 只认家具库里的名字（「凳乙二」这种不是任何一件家具）
    if (!FURNITURE_LABEL.test(prim.label)) continue;
    const distance = Math.hypot(point[0] - Number(prim.c[0]), point[2] - Number(prim.c[2]));
    if (!best || distance < best.distance) best = { label: String(prim.label), distance };
  }
  if (best && best.distance < 2.2) return `${best.label}旁`;
  const x = point[0];
  const z = point[2];
  const where: string[] = [];
  where.push(Math.abs(x) > 2.5 ? (x > 0 ? '东侧' : '西侧') : '屋子中间');
  if (Math.abs(z) > 2.2) where.push(z > 0 ? '靠南' : '靠北');
  return where.join('、');
};

/** 时辰 / 天气 / 光线：shot.light 为空时从正文和事件时间补。 */
export function lightWordsOf(input: { light?: string | null; sceneText: string; eventTimes: string[] }): string {
  if (input.light?.trim()) return input.light.trim();
  const text = `${input.sceneText} ${input.eventTimes.join(' ')}`;
  const words: string[] = [];
  if (/天还没亮|天未亮|未明|五更|凌晨|拂晓/.test(text)) words.push('天还没亮');
  else if (/黎明|清晨|早上/.test(text)) words.push('清晨');
  else if (/黄昏|傍晚|酉时/.test(text)) words.push('黄昏');
  else if (/夜|亥时|子时|灯下/.test(text)) words.push('夜里');
  if (/雨|细雨|下雨/.test(text)) words.push('下着细雨');
  if (/油灯|烛/.test(text)) words.push('屋里点着油灯，暖黄');
  else if (/月光|月色/.test(text)) words.push('月光冷白');
  return words.length ? words.join('，') : '屋里光线偏暗';
}

/** 按 §13.9 第 3 条的结构拼提示词：人偶↔人物对应、走位、时辰天气光线。 */
export function promptOfTake(input: {
  shot: Shot;
  prims: { label?: string; c?: [number, number, number] }[];
  cast: { name: string; index: number | null; color: string; at: [number, number, number]; to?: [number, number, number] | null; facing?: number }[];
  visiblePrims?: { label?: string; c?: [number, number, number] }[];
  artStyle: string | null;
  doors: string[];
  lightText: string;
  /** 说明和走位矛盾时不附 action。 */
  dropAction?: boolean;
}): string {
  const visible = input.visiblePrims ?? input.prims;
  const furniture = [...new Set(visible.map((prim) => prim.label ?? '').filter((label) => FURNITURE_LABEL.test(label)))];
  const people = input.cast.map((member) => {
    const portrait = member.index ? `（@图片${member.index} 是${member.name}）` : '';
    const facing = facingWord(member.facing, member.to ?? member.at, input.shot.camera);
    const walk = member.to
      ? `从${positionWord(member.at, input.prims)}走到${positionWord(member.to, input.prims)}，停下${facing}`
      : `站在${positionWord(member.at, input.prims)}，${facing}`;
    return `${member.color}人偶是${member.name}${portrait}，${walk}`;
  });
  const action = !input.dropAction && input.shot.action?.trim() ? `导演写的动作：${input.shot.action.replace(/[。；;]?$/, '')}。` : '';
  const dialogue = input.shot.dialogue ? `对白：「${input.shot.dialogue.replace(/[。；;]?$/, '')}」。` : '';
  return [
    `完全参考 @视频1 的机位、构图、镜头推进、家具位置和人物走位：@视频1 是白模预演`,
    furniture.length ? `，木色的是家具（画面里的家具：${furniture.join('、')}）` : '',
    '。',
    people.length ? `${people.join('；')}。` : '',
    input.doors.length ? `门在 ${input.doors.join('、')}，画面里的墙上没有门。` : '',
    action,
    dialogue,
    input.lightText ? `${input.lightText.replace(/[。；;]?$/, '')}。` : '',
    input.artStyle ? `画风：${input.artStyle.replace(/[。；;]?$/, '')}。` : '',
    '电影感，镜头稳定，人物五官和服装与参考图一致。',
  ]
    .filter(Boolean)
    .join('');
}

/** 镜头说明和 cast 走位矛盾时提醒作者（不回退，只提示）。 */
export function contradictionsOf(shot: Shot, prims: { label?: string; c?: number[] }[]): string[] {
  const out: string[] = [];
  const words = String(shot.action ?? '');
  for (const member of shot.cast) {
    const near = positionWord(member.at as [number, number, number], prims);
    for (const place of ['门', '柜台', '窗口', '桌'])
      if (words.includes(place) && !near.includes(place)) out.push(`镜头说明里提到「${place}」，但这一镜的人站在${near}——按走位生成提示词，说明只作补充`);
  }
  return [...new Set(out)];
}

/** 立绘中段平均色（和前端 useClothColors 同一区域/规则），用 ffmpeg 解像素。 */
async function clothColorOf(deps: VideoDeps, bytes: Uint8Array, mime: string, id: string, index: number): Promise<RGB> {
  const file = join(tmpdir(), `cloth-${process.pid}-${index}.${mime === 'image/png' ? 'png' : 'jpg'}`);
  try {
    await writeFile(file, bytes);
    const { stdout } = await execFileAsync(
      deps.ffmpegPath ?? '/opt/homebrew/bin/ffmpeg',
      ['-v', 'error', '-i', file, '-vf', 'scale=48:72', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
      { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 },
    );
    let r = 0, g = 0, b = 0, n = 0;
    const W = 48, H = 72;
    for (let y = Math.floor(H * 0.35); y < Math.floor(H * 0.75); y += 1)
      for (let x = Math.floor(W * 0.3); x < Math.floor(W * 0.7); x += 1) {
        const at = (y * W + x) * 3;
        const l = (stdout[at]! + stdout[at + 1]! + stdout[at + 2]!) / 3;
        if (l > 205 || l < 25) continue;
        r += stdout[at]!; g += stdout[at + 1]!; b += stdout[at + 2]!; n += 1;
      }
    if (!n) return fallbackClothColor(id, index);
    return [r / n, g / n, b / n];
  } catch {
    return fallbackClothColor(id, index);
  } finally {
    await unlink(file).catch(() => undefined);
  }
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
    const workRow = (
      await client.query<{ document: WorkDocument }>(
        'select document from creative_work where account_id=$1 and dossier_id=$2 and work_id=$3',
        [account, dossier, shot.workId],
      )
    ).rows[0];
    const scene = workRow?.document.chapters.flatMap((chapter) => chapter.scenes).find((item) => item.id === shot.sceneId);
    const eventTimes = state.document.events
      .filter((event) => (scene?.eventIds ?? []).includes(event.id))
      .map((event) => `${event.start?.label ?? ''} ${event.start?.t ?? ''}`);
    return { state, take, shot, prims: current?.prims ?? [], portraits, versions, sceneText: scene?.text ?? '', eventTimes };
  });
  const { state, take, shot, prims, portraits, sceneText, eventTimes } = context;
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
    const cast: { name: string; index: number | null; color: string; at: [number, number, number]; to?: [number, number, number] | null; facing?: number }[] = [];
    let index = 0;
    for (const member of shot.cast) {
      const entity = state.document.entities.find((item) => item.id === member.entityId);
      const name = entity?.name ?? '人物';
      const portrait = portraits.get(member.entityId);
      let colorRgb: RGB = fallbackClothColor(member.entityId, index);
      let imageIndex: number | null = null;
      if (portrait) {
        const pid = portrait.url.split('/').pop() ?? '';
        try {
          const image = await db.withAccount(account, (client) => readImage(client, { account, fileId: pid }));
          const bytes = new Uint8Array(image.bytes);
          colorRgb = await clothColorOf(deps, bytes, image.mime, member.entityId, index);
          refImages.push({ mime: image.mime, bytes });
          imageIndex = refImages.length;
        } catch {
          imageIndex = null;
        }
      }
      cast.push({ name, index: imageIndex, color: colorName(colorRgb), at: member.at as [number, number, number], to: (member.to ?? null) as [number, number, number] | null, facing: member.facing });
      index += 1;
    }
    const doors = prims.map((prim) => prim.label ?? '').filter((label) => /门/.test(label));
    const visiblePrims = prims.filter((prim) => {
      const c = (prim as { c?: [number, number, number] }).c;
      return !c || inViewOf(shot.camera as never, c);
    });
    const contradictions = contradictionsOf(shot, prims);
    const prompt = promptOfTake({
      shot,
      prims,
      cast,
      visiblePrims,
      artStyle: (state.document as { artStyle?: string | null }).artStyle ?? null,
      doors: doors.length ? ['南墙正中（镜头背后）'] : [],
      lightText: lightWordsOf({ light: shot.light, sceneText, eventTimes }),
      dropAction: contradictions.length > 0,
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
      basis: {
        ...take.basis,
        refImages: shot.cast
          .filter((member) => portraits.get(member.entityId))
          .map((member) => ({ assetVersionId: (context.versions.get(member.entityId)?.versionId ?? '') as string, view: 'portrait' as const })),
        prompt,
        mode: 'reference_video',
      },
    });
    let result = await pollSeedance(seedance, submitted.taskId);
    const started = Date.now();
    while (result.state === 'running' && Date.now() - started < 12 * 60 * 1000) {
      await new Promise((done) => setTimeout(done, 8000));
      result = await pollSeedance(seedance, submitted.taskId);
    }
    if (result.state === 'failed') throw new Error(result.error);
    if (result.state === 'running') throw new Error('等太久还没出（超过 12 分钟）。');
    // 5) 取回存本机（取不回来就记下平台地址，重试只重新取回、不再付费）
    const videoResponse = await fetch(result.videoUrl, { signal: AbortSignal.timeout(180_000) });
    if (!videoResponse.ok) throw new Error(`UNSAVED:${result.videoUrl}:片子取不回来（${videoResponse.status}）。`);
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
    if (message.startsWith('UNSAVED:')) {
      const [, pendingUrl, reason] = message.split(':');
      await patchTake(db, account, dossier, takeId, { state: 'unsaved', failure: reason ?? '片子还没取回来。' });
      await db.withAccount(account, async (client) => {
        const current = await loadWorld(client, account, dossier, { lock: true });
        const takes = takesOf(current.document).map((item) =>
          item.id === takeId ? { ...item, basis: item.basis } : item,
        );
        void takes;
        await client.query('update creative_world set document=$3::jsonb where account_id=$1 and dossier_id=$2', [account, dossier, JSON.stringify({ ...current.document, pendingUrls: { ...(current.document as { pendingUrls?: Record<string, string> }).pendingUrls, [takeId]: pendingUrl } })]);
      });
      return;
    }
    await patchTake(db, account, dossier, takeId, { state: 'failed', failure: message.slice(0, 300) });
    await recordUsage(db, account, dossier, 'volcengine-ark', seedance.model ?? 'doubao-seedance-2-0-260128', { value: 0, known: true }, '平台未收费：这一镜没出成');
  }
}

/** 重试：只重新取回 unsaved 的片子，不重新出片。 */
export async function retryTake(
  deps: VideoDeps & { db: import('../db/database').Database },
  account: string,
  dossier: string,
  takeId: string,
): Promise<ShotTake | null> {
  const db = deps.db;
  const state = await db.withAccount(account, (client) => loadWorld(client, account, dossier));
  const take = takesOf(state.document).find((item) => item.id === takeId);
  if (!take || take.state !== 'unsaved') return take ?? null;
  const pendingUrl = (state.document as { pendingUrls?: Record<string, string> }).pendingUrls?.[takeId];
  if (!pendingUrl) return take;
  try {
    const response = await fetch(pendingUrl, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw new Error(`片子还是取不回来（${response.status}）。`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const file = await db.withAccount(account, (client) => saveImage(client, { account, dossier, bytes, mime: 'video/mp4', width: null, height: null }));
    let posterUrl: string | null = null;
    try {
      const poster = await extractPoster(deps, bytes);
      const posterFile = await db.withAccount(account, (client) => saveImage(client, { account, dossier, bytes: poster, mime: 'image/jpeg', width: null, height: null }));
      posterUrl = posterFile.url;
    } catch {
      posterUrl = null;
    }
    return patchTake(db, account, dossier, takeId, { state: 'saved', url: file.url, posterUrl });
  } catch (error) {
    return patchTake(db, account, dossier, takeId, { failure: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
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
