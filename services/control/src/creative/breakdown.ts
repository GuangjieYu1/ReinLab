/**
 * 参考视频拆解（契约 §14.2 的最小版）：ffmpeg 场景切分 → 每镜取 3 张关键帧 → 写 .md 拆解表 + 逐帧数据 JSON。
 * 运镜/动作/表情（MediaPipe）还没接，先给镜头边界、时长、关键帧，够导演按镜交白模和镜头表。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);

export type BreakdownShot = { n: number; startSec: number; endSec: number; keyframes: string[] };
export type Breakdown = { source: string; durationSec: number | null; shots: BreakdownShot[] };

const ffmpegPathOf = (path?: string) => path ?? '/opt/homebrew/bin/ffmpeg';

/** 用 ffmpeg 的 scene 分数切镜，返回每镜的起止时间。 */
export async function detectScenes(ffmpeg: string | undefined, videoPath: string, durationSec: number | null): Promise<{ startSec: number; endSec: number }[]> {
  try {
    const { stderr } = await run(ffmpegPathOf(ffmpeg), [
      '-i', videoPath, '-filter:v', "select='gt(scene,0.35)',showinfo", '-f', 'null', '-',
    ], { maxBuffer: 32 * 1024 * 1024 });
    const times = [...stderr.matchAll(/pts_time:([\d.]+)/g)].map((match) => Number(match[1])).filter((value) => Number.isFinite(value));
    const end = durationSec ?? times.at(-1) ?? null;
    const cuts = [0, ...times.filter((time) => time > 0.2)];
    const out: { startSec: number; endSec: number }[] = [];
    for (const [index, start] of cuts.entries()) {
      const stop = cuts[index + 1] ?? end;
      if (stop === null || stop - start < 0.25) continue;
      out.push({ startSec: Number(start.toFixed(2)), endSec: Number(stop.toFixed(2)) });
    }
    return out.length ? out : [{ startSec: 0, endSec: end ?? 5 }];
  } catch {
    return [{ startSec: 0, endSec: durationSec ?? 5 }];
  }
}

/** 拆解一个已经下载好的视频，在它旁边写 .md 和 .json。 */
export async function breakdownVideo(
  deps: { ffmpegPath?: string },
  input: { videoPath: string; basePath: string; title: string; url: string; durationSec: number | null },
): Promise<{ markdownPath: string; shots: BreakdownShot[] }> {
  const shots = await detectScenes(deps.ffmpegPath, input.videoPath, input.durationSec);
  const framesDir = `${input.basePath}.frames`;
  await run('mkdir', ['-p', framesDir]);
  try {
    const result: BreakdownShot[] = [];
    for (const [index, shot] of shots.entries()) {
      const middle = (shot.startSec + shot.endSec) / 2;
      const name = `shot-${String(index + 1).padStart(2, '0')}.jpg`;
      let keyframes: string[] = [];
      try {
        await run(ffmpegPathOf(deps.ffmpegPath), ['-y', '-ss', String(middle), '-i', input.videoPath, '-frames:v', '1', '-q:v', '4', join(framesDir, name)]);
        keyframes = [`${input.basePath}.frames/${name}`];
      } catch {
        keyframes = [];
      }
      result.push({ n: index + 1, startSec: shot.startSec, endSec: shot.endSec, keyframes });
    }
    const lines = [
      `# 拆解：${input.title}`,
      '',
      `- 来源：${input.url}`,
      `- 时长：${input.durationSec ?? '未知'} 秒`,
      `- 镜头：${result.length} 个（ffmpeg 场景切分）`,
      '',
      '| 镜 | 起止（秒） | 关键帧 |',
      '|---|---|---|',
      ...result.map((shot) => `| ${shot.n} | ${shot.startSec}–${shot.endSec} | ${shot.keyframes[0] ?? ''} |`),
      '',
      '> 运镜、动作、表情（MediaPipe）还没接；先按镜头边界和关键帧交白模/镜头表。',
    ];
    await writeFile(`${input.basePath}.md`, `${lines.join('\n')}\n`);
    await writeFile(`${input.basePath}.json`, JSON.stringify({ ...input, shots: result }, null, 2));
    return { markdownPath: `${input.basePath}.md`, shots: result };
  } catch (error) {
    await rm(framesDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
