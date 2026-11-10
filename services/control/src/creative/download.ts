/**
 * download_video（契约 §14.7）：yt-dlp 下最高 720p，可只取一段；存进公共素材文件夹
 * `~/ReinLab素材/`，文件名 `<简短描述>__<站点>-<视频号>.mp4`，旁边放 .json；拆解完再放 .md。
 * cookie 只在进程内存里读（契约 §14.1），有 DRM 的直接拒绝。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, rename, rm, writeFile, stat, mkdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);

export type DownloadDeps = {
  ytDlpPath?: string;
  folder?: string;
  cookiesFile?: string | null;
  /** 专用素材浏览器的配置目录（yt-dlp 用 --cookies-from-browser 直接读，不导出 cookie）。 */
  browserProfile?: string;
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
export async function downloadVideo(
  deps: DownloadDeps,
  input: { url: string; from?: string; to?: string; note?: string },
): Promise<{ name: string; path: string; title: string; site: string; videoId: string; durationSec: number | null; description: string }> {
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
    const section = input.from ? `*${input.from}-${input.to ?? ''}` : null;
    const args = ['--no-warnings', '-f', 'bv*[height<=720]+ba/b[height<=720]/b', '-o', join(dir, 'v.%(ext)s'), ...cookieArgs];
    if (section) args.push('--download-sections', section, '--force-keyframes-at-cuts');
    args.push(input.url);
    try {
      await run(ytDlpOf(deps), args, { maxBuffer: 64 * 1024 * 1024 });
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
          durationSec,
          description,
          tags: [],
          note: '这里的视频只用于拆解和参考，不放进作品、不外传。',
        },
        null,
        2,
      ),
    );
    return { name, path: target, title, site, videoId, durationSec, description };
  } finally {
    if (cookieFile) await rm(cookieFile, { force: true });
    await rm(dir, { recursive: true, force: true });
  }
}
