/**
 * Seedance 出片管线（契约 §13.9）：
 * 预演 webm → ffmpeg 转 mp4(24fps) → TOS 私有桶 → 2 小时预签名 GET 链接 → Seedance 任务（参考图 base64 + 参考视频 URL）
 * → 轮询 → 取回 mp4/首帧 → 存本机。TOS 用 S3 兼容接口 + SigV4 预签名。
 */

import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type TosConfig = { accessKey: string; secretKey: string; bucket: string; region: string };
export type SeedanceConfig = { apiKey: string; baseUrl?: string; model?: string; priceWithVideo?: number; priceWithoutVideo?: number };

export type VideoDeps = {
  ffmpegPath?: string;
  tos?: TosConfig | null;
  seedance?: SeedanceConfig | null;
};

export const ffmpegPathOf = (deps: VideoDeps): string => deps.ffmpegPath ?? '/opt/homebrew/bin/ffmpeg';

const sha256Hex = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const hmac = (key: Uint8Array | string, value: string) => createHmac('sha256', key).update(value).digest();
const encodeRfc = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

/** TOS（S3 兼容）预签名：PUT 上传 / GET 下载。 */
export function presignTos(tos: TosConfig, method: 'PUT' | 'GET', key: string, expiresSec: number): string {
  const host = `${tos.bucket}.tos-s3-${tos.region}.volces.com`;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = stamp.slice(0, 8);
  const scope = `${day}/${tos.region}/s3/aws4_request`;
  const query: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${tos.accessKey}/${scope}`,
    'X-Amz-Date': stamp,
    'X-Amz-Expires': String(expiresSec),
    'X-Amz-SignedHeaders': 'host',
  };
  const queryString = Object.keys(query).sort().map((name) => `${encodeRfc(name)}=${encodeRfc(query[name]!)}`).join('&');
  const path = `/${key.split('/').map(encodeRfc).join('/')}`;
  const canonical = [method, path, queryString, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256Hex(canonical)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${tos.secretKey}`, day), tos.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  return `https://${host}${path}?${queryString}&X-Amz-Signature=${signature}`;
}

/** 上传到 TOS，返回 2 小时有效的预签名 GET 链接。 */
export async function uploadAndSign(tos: TosConfig, key: string, bytes: Uint8Array, mime: string): Promise<string> {
  const put = await fetch(presignTos(tos, 'PUT', key, 600), {
    method: 'PUT',
    body: bytes as unknown as RequestInit['body'],
    headers: { 'content-type': mime },
  });
  if (!put.ok) throw new Error(`TOS 上传失败（${put.status}）：${(await put.text()).slice(0, 200)}`);
  return presignTos(tos, 'GET', key, 7200);
}

/** 预演 webm → mp4（H.264 / 24fps / yuv420p / 无音轨）。 */
export async function transcodeToMp4(deps: VideoDeps, input: Uint8Array): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), 'reinlab-video-'));
  try {
    const from = join(dir, 'in.webm');
    const to = join(dir, 'out.mp4');
    await writeFile(from, input);
    await run(ffmpegPathOf(deps), ['-y', '-i', from, '-an', '-vf', 'fps=24,scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', to]);
    return new Uint8Array(await readFile(to));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 取视频第一帧当海报。 */
export async function extractPoster(deps: VideoDeps, video: Uint8Array): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), 'reinlab-poster-'));
  try {
    const from = join(dir, 'in.mp4');
    const to = join(dir, 'poster.jpg');
    await writeFile(from, video);
    await run(ffmpegPathOf(deps), ['-y', '-i', from, '-frames:v', '1', '-q:v', '3', to]);
    return new Uint8Array(await readFile(to));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 按顺序硬切拼接（不做转场）。 */
export async function concatVideos(deps: VideoDeps, videos: Uint8Array[]): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), 'reinlab-cut-'));
  try {
    const list = join(dir, 'list.txt');
    const files: string[] = [];
    for (const [index, video] of videos.entries()) {
      const file = join(dir, `part-${index}.mp4`);
      await writeFile(file, video);
      files.push(file);
    }
    await writeFile(list, files.map((file) => `file '${file}'`).join('\n'));
    const out = join(dir, 'cut.mp4');
    await run(ffmpegPathOf(deps), ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out]);
    return new Uint8Array(await readFile(out));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export type SeedanceTask = { taskId: string };

/** 提交出片任务；参考视频必须是公网可访问的 URL。 */
export async function submitSeedance(
  config: SeedanceConfig,
  input: { prompt: string; refImages: { mime: string; bytes: Uint8Array }[]; referenceVideoUrl: string | null; resolution: '480p' | '720p'; durationSec: number },
): Promise<SeedanceTask> {
  const base = (config.baseUrl ?? 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, '');
  const content: Record<string, unknown>[] = [{ type: 'text', text: input.prompt }];
  for (const image of input.refImages)
    content.push({
      type: 'image_url',
      image_url: { url: `data:${image.mime};base64,${Buffer.from(image.bytes).toString('base64')}` },
      role: 'reference_image',
    });
  if (input.referenceVideoUrl) content.push({ type: 'video_url', video_url: { url: input.referenceVideoUrl }, role: 'reference_video' });
  const response = await fetch(`${base}/contents/generations/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model ?? 'doubao-seedance-2-0-260128',
      content,
      resolution: input.resolution,
      duration: input.durationSec,
      ratio: '16:9',
      watermark: false,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`出片平台拒绝（${response.status}）：${text.slice(0, 200)}`);
  const body = JSON.parse(text) as { id?: string };
  if (!body.id) throw new Error('平台没给任务号。');
  return { taskId: body.id };
}

export type SeedanceResult =
  | { state: 'running' }
  | { state: 'failed'; error: string }
  | { state: 'succeeded'; videoUrl: string; usage: { totalTokens: number | null } };

export async function pollSeedance(config: SeedanceConfig, taskId: string): Promise<SeedanceResult> {
  const base = (config.baseUrl ?? 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, '');
  const response = await fetch(`${base}/contents/generations/tasks/${taskId}`, {
    headers: { authorization: `Bearer ${config.apiKey}` },
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await response.json().catch(() => ({}))) as {
    status?: string;
    content?: { video_url?: string };
    usage?: { total_tokens?: number };
    error?: { message?: string } | string;
  };
  if (body.status === 'succeeded' && body.content?.video_url)
    return { state: 'succeeded', videoUrl: body.content.video_url, usage: { totalTokens: body.usage?.total_tokens ?? null } };
  if (body.status === 'failed' || body.status === 'cancelled')
    return { state: 'failed', error: typeof body.error === 'string' ? body.error : (body.error?.message ?? '平台说这一镜没出成。') };
  return { state: 'running' };
}

/** 按 token 记价（带参考视频 ¥28/百万，不带 ¥46/百万）。 */
export function videoCost(config: SeedanceConfig, usage: { totalTokens: number | null }, withReferenceVideo: boolean): { value: number; known: true } | null {
  if (usage.totalTokens === null) return null;
  const price = withReferenceVideo ? (config.priceWithVideo ?? 28) : (config.priceWithoutVideo ?? 46);
  return { value: Number(((usage.totalTokens / 1_000_000) * price).toFixed(6)), known: true };
}
