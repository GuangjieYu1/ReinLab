/**
 * download_video（契约 §14.7）：yt-dlp 下最高 720p，可只取一段；存进公共素材文件夹
 * `~/ReinLab素材/`，文件名 `<简短描述>__<站点>-<视频号>.mp4`，旁边放 .json；拆解完再放 .md。
 * cookie 只在进程内存里读（契约 §14.1），有 DRM 的直接拒绝。
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, rename, rm, writeFile, stat, mkdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);

/** 跑 yt-dlp 并把百分比透出来（stderr 里是「[download]  12.3% of ...」）。 */
function runWithProgress(command: string, args: string[], onPercent?: (percent: number) => void): Promise<{ stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let last = -1;
    const feed = (chunk: Buffer) => {
      stderr += chunk.toString();
      if (!onPercent) return;
      const matches = [...stderr.matchAll(/(\d{1,3}(?:\.\d+)?)%/g)];
      const percent = matches.length ? Math.floor(Number(matches.at(-1)![1])) : -1;
      if (percent >= 0 && percent !== last && (last < 0 || percent - last >= 5 || percent >= 100)) {
        last = percent;
        onPercent(percent);
      }
      if (stderr.length > 2_000_000) stderr = stderr.slice(-200_000);
    };
    child.stderr.on('data', feed);
    child.stdout.on('data', feed);
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve({ stderr }) : reject(Object.assign(new Error('yt-dlp 失败'), { stderr }))));
  });
}

export type DownloadDeps = {
  ytDlpPath?: string;
  folder?: string;
  cookiesFile?: string | null;
  /** 专用素材浏览器的配置目录（yt-dlp 用 --cookies-from-browser 直接读，不导出 cookie）。 */
  browserProfile?: string;
  /** 能看图的模型（拆解描述用）。 */
  vision?: import('./breakdown-vlm').VisionConfig | null;
};

/** 需要作者本人登录（412/403/登录墙）。 */
export class LoginRequiredError extends Error {
  constructor(readonly site: string) {
    super(`${site} 要登录`);
  }
}

export const folderOf = (deps: DownloadDeps) => deps.folder ?? join(homedir(), 'ReinLab素材');
const ytDlpOf = (deps: DownloadDeps) => deps.ytDlpPath ?? '/opt/homebrew/bin/yt-dlp';

const BAD = /[\\/:*?"<>|]/g;
const short = (value: string, max = 20) => value.replace(BAD, '').replace(/\s+/g, '').trim().slice(0, max) || '视频';

const SITE: Record<string, string> = {
  'bilibili.com': 'bilibili',
  'b23.tv': 'bilibili',
  'youtube.com': 'youtube',
  'youtu.be': 'youtube',
  'douyin.com': 'douyin',
  'kuaishou.com': 'kuaishou',
  'xiaohongshu.com': 'xiaohongshu',
};

const siteOf = (url: string): string => {
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  })();
  return Object.entries(SITE).find(([domain]) => host.endsWith(domain))?.[1] ?? host.replace(/^www\./, '') ?? 'web';
};

const idOf = (url: string, title: string, durationSec: number | null): string => {
  const match = /BV[0-9A-Za-z]{10}|[?&]v=([\w-]{6,})/.exec(url);
  if (match) return match[0].replace(/^[?&]v=/, '');
  return `${short(title, 8)}-${Math.round(Date.now() / 1000)}`;
};

/** 下载一个视频到公共素材文件夹；返回文件名和元数据。 */
/** 「前 30 秒」这种写在 note 里的时间段也认。 */
const rangeFromNote = (note?: string): { from?: string; to?: string } => {
  const match = /前\s*(\d+)\s*秒/.exec(note ?? '');
  return match ? { from: '0', to: match[1] } : {};
};

export async function downloadVideo(
  deps: DownloadDeps,
  input: { url: string; from?: string; to?: string; note?: string; onProgress?: (info: { step: string; done?: number; total?: number; detail?: string }) => void },
): Promise<{ name: string; path: string; title: string; site: string; videoId: string; durationSec: number | null; description: string; markdown: string | null; usage: { inputTokens: number | null; outputTokens: number | null } | null }> {
  const folder = folderOf(deps);
  await mkdir(folder, { recursive: true });
  const readme = join(folder, '说明.md');
  try {
    await stat(readme);
  } catch {
    await writeFile(readme, '# 说明\n\n这里的视频只用于拆解和参考，不放进作品、不外传。\n');
  }
  const dir = await mkdtemp(join(tmpdir(), 'reinlab-dl-'));
  let cookieFile: string | null = null;
  try {
    // 切片时以文件实际时长为准（平台元数据是全片的）
    const site = siteOf(input.url);
    // 先把素材浏览器里的登录临时导出成 cookies.txt：取信息和下载两步都要带，B 站在取信息这一步就会 412
    let cookieArgs: string[] = [];
    if (deps.browserProfile) {
      const { exportCookiesFile } = await import('./browser');
      const exported = await exportCookiesFile({ profileDir: deps.browserProfile }, input.url);
      cookieFile = exported.file;
      cookieArgs = ['--cookies', exported.file];
    } else if (deps.cookiesFile) cookieArgs = ['--cookies', deps.cookiesFile];
    let meta: string;
    try {
      meta = (
        await run(ytDlpOf(deps), ['--no-warnings', '--skip-download', ...cookieArgs, '--print', '%(title)s\t%(duration)s\t%(uploader)s', input.url], {
          maxBuffer: 4 * 1024 * 1024,
        })
      ).stdout.trim();
    } catch (error) {
      const text = String((error as { stderr?: string; message?: string }).stderr ?? (error as Error).message ?? '');
      if (/412|403|login|sign in|登录|风控|Precondition/i.test(text)) throw new LoginRequiredError(site);
      throw new Error(`yt-dlp 取信息失败：${text.split('\n').slice(-2).join(' ').slice(0, 160)}`);
    }
    const [titleRaw, durationRaw, uploader] = meta.split('\t');
    const title = titleRaw ?? '视频';
    const durationSec = Number(durationRaw) || null;
    const range = { ...rangeFromNote(input.note), ...(input.from ? { from: input.from } : {}), ...(input.to ? { to: input.to } : {}) };
    const section = range.from ? `*${range.from}-${range.to ?? ''}` : null;
    const args = ['--no-warnings', '-f', 'bv*[height<=720]+ba/b[height<=720]/b', '-o', join(dir, 'v.%(ext)s'), ...cookieArgs];
    if (section) args.push('--download-sections', section, '--force-keyframes-at-cuts');
    args.push(input.url);
    input.onProgress?.({ step: '下载中' });
    try {
      await runWithProgress(ytDlpOf(deps), args, (percent) => input.onProgress?.({ step: `下载中 ${percent}%` }));
    } catch (error) {
      const text = String((error as { stderr?: string; message?: string }).stderr ?? (error as Error).message ?? '');
      if (/412|403|login|sign in|登录|风控|Precondition/i.test(text)) throw new LoginRequiredError(siteOf(input.url));
      throw error;
    }
    const files = await readdir(dir);
    const file = files.find((name) => name.startsWith('v.'));
    if (!file) throw new Error('yt-dlp 没下下来文件。');
    const videoId = idOf(input.url, title, durationSec);
    const description = short(input.note || title, 20);
    let base = `${description}__${site}-${videoId}`;
    const exists = async (candidate: string) => {
      try {
        await stat(join(folder, `${candidate}.mp4`));
        return true;
      } catch {
        return false;
      }
    };
    let suffix = 1;
    while (await exists(base)) base = `${description}-${++suffix}__${site}-${videoId}`;
    const name = `${base}.mp4`;
    const target = join(folder, name);
    await rename(join(dir, file), target);
    // 切片时以文件实际时长为准（平台元数据是全片的）
    const clippedDuration = await (await import('./breakdown')).probeDuration(process.env.REINLAB_FFMPEG ?? '/opt/homebrew/bin/ffmpeg', target).catch(() => null);
    await writeFile(
      join(folder, `${base}.json`),
      JSON.stringify(
        {
          url: input.url,
          site,
          videoId,
          title,
          author: uploader ?? null,
          fetchedAt: new Date().toISOString(),
          durationSec: clippedDuration ?? durationSec,
          description,
          tags: [],
          note: '这里的视频只用于拆解和参考，不放进作品、不外传。',
        },
        null,
        2,
      ),
    );
    // 下载完自动拆解（契约 §14.2）：场景切分 + 关键帧 + .md/.json；失败不影响下载结果
    const basePath = target.replace(/\.mp4$/i, '');
    let markdown: string | null = null;
    let usage: { inputTokens: number | null; outputTokens: number | null } | null = null;
    try {
      const { breakdownVideo } = await import('./breakdown');
      const result = await breakdownVideo({ ffmpegPath: process.env.REINLAB_FFMPEG ?? '/opt/homebrew/bin/ffmpeg', ...(deps.vision ? { vision: deps.vision } : {}) }, {
        videoPath: target,
        basePath,
        title,
        url: input.url,
        durationSec: clippedDuration ?? durationSec,
        ...(input.onProgress ? { onProgress: input.onProgress } : {}),
      });
      markdown = result.markdownPath;
      usage = result.usage;
    } catch (error) {
      console.error(JSON.stringify({ code: 'BREAKDOWN_FAILED', message: (error as Error).message.slice(0, 160) }));
    }
    return { name, path: target, title, site, videoId, durationSec: clippedDuration ?? durationSec, description, markdown, usage };
  } finally {
    if (cookieFile) await rm(cookieFile, { force: true });
    await rm(dir, { recursive: true, force: true });
  }
}
