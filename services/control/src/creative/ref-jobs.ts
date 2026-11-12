/**
 * 参考素材的后台视觉拆解（契约 §14.10）：下载 + 切镜头先做完返回，逐镜描述放到后台排队跑。
 * 状态写在来源 .json 的 breakdown 字段里；控制面重启后从断点接着拆，已拆好的镜头不重调视觉模型。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RefEvent } from '@reinlab/contracts';
import { detectScenes, type BreakdownShot } from './breakdown';
import { describeShots, type VisionConfig } from './breakdown-vlm';

const run = promisify(execFile);

export type RefShot = BreakdownShot & { text?: string | null };
export type RefBreakdown = {
  state: 'queued' | 'analyzing' | 'ready' | 'failed';
  done: number;
  total: number;
  failure?: string | null;
  summary?: string | null;
  shots: RefShot[];
  origin?: { account: string; dossier: string; runId: string | null } | null;
};

export type RefJobDeps = {
  folder: string;
  ffmpegPath?: string;
  vision?: VisionConfig | null;
  /** 发起这次下载的会话（用于 creative.focus / creative.ref 和用量记账）。 */
  origin?: { account: string; dossier: string; runId: string | null } | null;
  onFocus?: (info: { step: string; done: number; total: number; detail: string }, origin: { account: string; dossier: string; runId: string | null } | null) => void;
  onRef?: (event: RefEvent, origin: { account: string; dossier: string; runId: string | null } | null) => void;
  onUsage?: (usage: { inputTokens: number | null; outputTokens: number | null }, origin: { account: string; dossier: string; runId: string | null } | null) => void | Promise<void>;
};

export const basePathOf = (folder: string, name: string) => join(folder, name.replace(/\.mp4$/i, ''));

const readJson = async <T>(path: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
};

const writeJson = (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2));

/** 下载完调它：切镜头 + 关键帧，写状态，然后排队（不调视觉模型）。 */
export async function prepareRef(
  deps: RefJobDeps,
  input: { videoPath: string; basePath: string; title: string; url: string; durationSec: number | null; origin?: RefJobDeps['origin'] },
): Promise<{ total: number; breakdown: RefBreakdown }> {
  const scenes = await detectScenes(deps.ffmpegPath, input.videoPath, input.durationSec);
  const framesDir = `${input.basePath}.frames`;
  await mkdir(framesDir, { recursive: true });
  const shots: RefShot[] = [];
  for (const [index, scene] of scenes.entries()) {
    const name = `shot-${String(index + 1).padStart(2, '0')}.jpg`;
    const middle = (scene.startSec + scene.endSec) / 2;
    await run(deps.ffmpegPath ?? '/opt/homebrew/bin/ffmpeg', [
      '-y', '-ss', String(middle), '-i', input.videoPath, '-frames:v', '1', '-q:v', '4', join(framesDir, name),
    ]).catch(() => undefined);
    shots.push({ n: index + 1, startSec: scene.startSec, endSec: scene.endSec, keyframes: [join(framesDir, name)], text: null });
  }
  const breakdown: RefBreakdown = {
    state: 'queued', done: 0, total: shots.length, shots,
    ...(input.origin || deps.origin ? { origin: input.origin ?? deps.origin } : {}),
  };
  const source = (await readJson<Record<string, unknown>>(`${input.basePath}.json`)) ?? {};
  await writeJson(`${input.basePath}.json`, { ...source, breakdown });
  enqueue({ deps, basePath: input.basePath, title: input.title });
  deps.onRef?.(
    { name: input.basePath.split('/').pop() ?? '', runId: breakdown.origin?.runId ?? null, state: 'queued', done: 0, total: shots.length },
    breakdown.origin ?? null,
  );
  return { total: shots.length, breakdown };
}

type QueueItem = { deps: RefJobDeps; basePath: string; title: string };
const queue: QueueItem[] = [];
let current: QueueItem | null = null;
const active = new Set<string>();

/** 定时扫盘（启动时可能因为控制面时序没扫到；每 30 秒兜底一次，已排队的不重复排）。 */
export function startRefSweeper(deps: RefJobDeps, everyMs = 30_000): () => void {
  const timer = setInterval(() => {
    void resumeRefJobs(deps).catch(() => undefined);
  }, everyMs);
  return () => clearInterval(timer);
}

function enqueue(item: QueueItem): void {
  if (item.basePath === current?.basePath || active.has(item.basePath)) return;
  active.add(item.basePath);
  queue.push(item);
  void drain();
}

async function drain(): Promise<void> {
  if (current) return;
  const next = queue.shift();
  if (!next) return;
  current = next;
  try {
    await runRefJob(next.deps, next.basePath, next.title);
  } finally {
    active.delete(next.basePath);
    current = null;
    void drain();
  }
}

/** 跑一份拆解（逐镜）。导出给回归测试用；一般只通过队列调用。 */
export async function runRefJob(deps: RefJobDeps, basePath: string, title: string): Promise<void> {
  const sourcePath = `${basePath}.json`;
  const source = (await readJson<{ breakdown?: RefBreakdown; url?: string }>(sourcePath)) ?? {};
  const breakdown = source.breakdown;
  if (!breakdown) return;
  const origin = breakdown.origin ?? deps.origin ?? null;
  breakdown.state = 'analyzing';
  breakdown.failure = null;
  await writeJson(sourcePath, { ...source, breakdown });
  deps.onRef?.({ name: basePath.split('/').pop() ?? '', runId: origin?.runId ?? null, state: 'analyzing', done: breakdown.done, total: breakdown.total }, origin);
  let usage = { inputTokens: 0 as number | null, outputTokens: 0 as number | null };
  let any = false;
  try {
    if (!deps.vision) throw new Error('本机没配视觉模型（缺 ARK_API_KEY），拆不了。');
    for (const shot of breakdown.shots) {
      if (shot.text) continue;
      const result = await describeShots(
        deps.vision,
        { shots: [{ n: shot.n, startSec: shot.startSec, endSec: shot.endSec, keyframes: shot.keyframes }], title },
        {},
      );
      shot.text = result.shots[0]?.text ?? null;
      any = true;
      usage.inputTokens = (usage.inputTokens ?? 0) + (result.inputTokens ?? 0);
      usage.outputTokens = (usage.outputTokens ?? 0) + (result.outputTokens ?? 0);
      breakdown.done = breakdown.shots.filter((item) => item.text).length;
      await writeJson(sourcePath, { ...source, breakdown });
      await writeMarkdown(basePath, title, breakdown);
      deps.onFocus?.(
        { step: `视觉拆解 镜 ${shot.n}`, done: breakdown.done, total: breakdown.total, detail: (shot.text ?? '').slice(0, 200) },
        origin,
      );
    }
    breakdown.state = 'ready';
    breakdown.summary = summarize(breakdown);
    await writeJson(sourcePath, { ...source, breakdown });
    await writeMarkdown(basePath, title, breakdown);
    deps.onRef?.(
      { name: basePath.split('/').pop() ?? '', runId: origin?.runId ?? null, state: 'ready', done: breakdown.done, total: breakdown.total, summary: breakdown.summary },
      origin,
    );
  } catch (error) {
    breakdown.state = 'failed';
    breakdown.failure = (error instanceof Error ? error.message : String(error)).slice(0, 200);
    await writeJson(sourcePath, { ...source, breakdown });
    deps.onRef?.(
      { name: basePath.split('/').pop() ?? '', runId: origin?.runId ?? null, state: 'failed', done: breakdown.done, total: breakdown.total, failure: breakdown.failure },
      origin,
    );
  } finally {
    if (any && deps.onUsage) await deps.onUsage(usage, origin);
  }
}

const summarize = (breakdown: RefBreakdown): string => {
  const lines = breakdown.shots.filter((shot) => shot.text).slice(0, 3).map((shot) => `镜${shot.n}：${(shot.text ?? '').split('；').slice(0, 2).join('；')}`);
  return lines.join('；').slice(0, 300);
};

async function writeMarkdown(basePath: string, title: string, breakdown: RefBreakdown): Promise<void> {
  const described = breakdown.shots.filter((shot) => shot.text);
  const lines = [
    `# 拆解：${title}`,
    '',
    `- 镜头：${breakdown.total} 个（ffmpeg 场景切分）`,
    `- 状态：${{ queued: '排队中', analyzing: `正在拆 ${breakdown.done}/${breakdown.total}`, ready: '拆完', failed: '失败' }[breakdown.state]}`,
    '',
    '| 镜 | 起止（秒） | 关键帧 |',
    '|---|---|---|',
    ...breakdown.shots.map((shot) => `| ${shot.n} | ${shot.startSec}–${shot.endSec} | ${shot.keyframes[0] ?? ''} |`),
    '',
    '## 逐镜描述（视觉模型读关键帧写的）',
    ...(described.length ? described.map((shot) => `- 镜${shot.n}：${shot.text}`) : ['- （还在拆）']),
  ];
  await writeFile(`${basePath}.md`, `${lines.join('\n')}\n`);
}

/** 等队列排空（回归测试用）。 */
export function refQueueIdle(): Promise<void> {
  return new Promise((resolve) => {
    const tick = () => (current || queue.length ? setTimeout(tick, 20) : resolve());
    tick();
  });
}

/** 控制面启动时扫素材夹：没拆完的接着拆。 */
export async function resumeRefJobs(deps: RefJobDeps): Promise<number> {
  let names: string[] = [];
  try {
    names = await readdir(deps.folder);
  } catch {
    return 0;
  }
  let resumed = 0;
  for (const name of names) {
    if (!name.endsWith('.json') || name.endsWith('.breakdown.json')) continue;
    const basePath = join(deps.folder, name.replace(/\.json$/, ''));
    if (basePath === current?.basePath || active.has(basePath)) continue;
    const source = await readJson<{ breakdown?: RefBreakdown }>(join(deps.folder, name));
    if (!source?.breakdown || !['queued', 'analyzing'].includes(source.breakdown.state)) continue;
    if (source.breakdown.shots.every((shot) => shot.text)) continue;
    enqueue({ deps, basePath: basePathOf(deps.folder, name), title: String((source as { title?: string }).title ?? name) });
    resumed += 1;
  }
  return resumed;
}
