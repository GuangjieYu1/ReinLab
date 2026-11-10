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
export type BreakdownUsage = { inputTokens: number | null; outputTokens: number | null };

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

/** 量视频实际时长（切片后以文件为准，不用平台元数据）。 */
export async function probeDuration(ffmpeg: string | undefined, videoPath: string): Promise<number | null> {
  try {
    const { stderr } = await run(ffmpegPathOf(ffmpeg), ['-i', videoPath], { maxBuffer: 8 * 1024 * 1024 }).catch((error) => ({ stderr: String((error as { stderr?: string }).stderr ?? '') }));
    const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
    if (!match) return null;
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  } catch {
    return null;
  }
}

/** 拆解一个已经下载好的视频，在它旁边写 .md 和 .json。 */
export async function breakdownVideo(
  deps: { ffmpegPath?: string; vision?: import('./breakdown-vlm').VisionConfig | null },
  input: {
    videoPath: string;
    basePath: string;
    title: string;
    url: string;
    durationSec: number | null;
    onProgress?: (info: { step: string; done?: number; total?: number; detail?: string }) => void;
  },
): Promise<{ markdownPath: string; shots: BreakdownShot[]; usage: BreakdownUsage | null }> {
  input.onProgress?.({ step: '切镜头' });
  const shots = await detectScenes(deps.ffmpegPath, input.videoPath, input.durationSec);
  const framesDir = `${input.basePath}.frames`;
  await run('mkdir', ['-p', framesDir]);
  try {
    let usage: BreakdownUsage | null = null;
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
    // 描述层：能看图的模型读关键帧，写景别/运镜/人物/场景/光线（纯文字导演也照着搭）
    let described: { n: number; text: string }[] = [];
    if (deps.vision)
      try {
        const { describeShots } = await import('./breakdown-vlm');
        const vision = await describeShots(
          deps.vision,
          { shots: result, title: input.title },
          {
            onProgress: (info) =>
              input.onProgress?.({ step: `视觉拆解 镜 ${info.done}`, done: info.done, total: info.total, detail: info.text.slice(0, 200) }),
          },
        );
        described = vision.shots;
        usage = { inputTokens: vision.inputTokens, outputTokens: vision.outputTokens };
        console.log(JSON.stringify({ code: 'BREAKDOWN_VISION_USAGE', inputTokens: vision.inputTokens, outputTokens: vision.outputTokens }));
      } catch (error) {
        console.error(JSON.stringify({ code: 'BREAKDOWN_VISION_FAILED', message: (error as Error).message.slice(0, 160) }));
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
      '',
      '## 逐镜描述（视觉模型读关键帧写的）',
      ...(described.length
        ? described.map((item) => `- 镜${item.n}：${item.text.replace(/\n/g, ' ')}`)
        : ['- （这次没有视觉模型描述；只有镜头边界和关键帧）']),
      '',
      '> MediaPipe 的骨骼动作/表情还没接；运镜与人物走位以逐镜描述为准。',
    ];
    await writeFile(`${input.basePath}.md`, `${lines.join('\n')}\n`);
    // 拆解结果另存，别覆盖下载时写的来源元数据（site/videoId/from/to/description）
    await writeFile(`${input.basePath}.breakdown.json`, JSON.stringify({ ...input, shots: result }, null, 2));
    return { markdownPath: `${input.basePath}.md`, shots: result, usage };
  } catch (error) {
    await rm(framesDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
