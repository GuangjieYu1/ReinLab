/**
 * 素材浏览器（契约 §14.8）：按需弹一个独立的 Chromium 窗口，用 Playwright 的持久化配置目录，
 * 和作者平时用的 Chrome 完全隔开。作者自己登录；yt-dlp 用 --cookies-from-browser 直接读这个目录，
 * 我们不导出、不打印、不进模型上下文。
 */

import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type BrowserDeps = { profileDir?: string; headless?: boolean };

export const profileDirOf = (deps: BrowserDeps) => deps.profileDir ?? join(homedir(), '.config/reinlab/browser-profile');

export async function ensureProfile(deps: BrowserDeps): Promise<string> {
  const dir = profileDirOf(deps);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => undefined);
  return dir;
}

/** 打开一个窗口并跳到 url（作者自己登录；助手不经手）。 */
export async function openBrowser(deps: BrowserDeps, url: string): Promise<{ opened: true; url: string }> {
  const dir = await ensureProfile(deps);
  const { chromium } = await import('playwright');
  const context = await chromium.launchPersistentContext(dir, {
    headless: deps.headless ?? false,
    viewport: { width: 1280, height: 860 },
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  const pages = context.pages();
  const page = pages[0] ?? (await context.newPage());
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => undefined);
  // 不 await close：窗口留给作者登录，关掉窗口后 context 自己结束
  context.on('close', () => undefined);
  return { opened: true, url };
}

export type BrowserSite = { domain: string; lastUsedAt: string | null };

/** 列出配置目录里登录过的站点（只读域名和最后使用时间，不回显 cookie）。 */
export async function listSites(deps: BrowserDeps): Promise<{ sites: BrowserSite[]; note?: string }> {
  const dir = profileDirOf(deps);
  const candidates = [join(dir, 'Default', 'Network', 'Cookies'), join(dir, 'Default', 'Cookies')];
  const { existsSync } = await import('node:fs');
  const file = candidates.find((item) => existsSync(item));
  if (!file) return { sites: [], note: '还没有登录过任何站点' };
  try {
    // node:sqlite（Node 22.5+ 实验特性）
    const { DatabaseSync } = (await import('node:sqlite')) as unknown as {
      DatabaseSync: new (path: string) => { prepare: (sql: string) => { all: () => BrowserSite[] }; close: () => void };
    };
    const db = new DatabaseSync(file);
    try {
      // Chromium 的时间从 1601-01-01 起算（微秒），转成 UTC
      const rows = db
        .prepare(
          'select host_key as domain, datetime(last_access_utc/1000000 - 11644473600, "unixepoch") as lastUsedAt from cookies group by host_key order by last_access_utc desc',
        )
        .all();
      return { sites: rows };
    } finally {
      db.close();
    }
  } catch (error) {
    return { sites: [], note: `读不到登录记录：${(error as Error).message.slice(0, 120)}` };
  }
}

/**
 * 把某个站点的登录导出成 Netscape cookies.txt（0600），交给 yt-dlp 用一次。
 * 不碰加密数据库、不导出到别处；下载结束由调用方立刻删掉。
 */
export async function exportCookiesFile(deps: BrowserDeps, url: string): Promise<{ file: string; count: number }> {
  const dir = await ensureProfile(deps);
  const { chromium } = await import('playwright');
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>;
  try {
    context = await chromium.launchPersistentContext(dir, { headless: true, args: ['--no-first-run'] });
  } catch (error) {
    throw new Error(`素材浏览器的窗口还开着（或配置目录被占用），先关掉窗口再下载：${(error as Error).message.slice(0, 80)}`);
  }
  try {
    const cookies = await context.cookies(url);
    if (!cookies.length) throw new Error('素材浏览器里还没有这个站点的登录：点「打开素材浏览器」登录后再试');
    const lines = ['# Netscape HTTP Cookie File', '# 由 ReinLab 临时导出，下载结束立刻删除', ''];
    for (const cookie of cookies) {
      const domain = cookie.domain.startsWith('.') ? cookie.domain : `.${cookie.domain}`;
      const expires = Math.floor(cookie.expires && cookie.expires > 0 ? cookie.expires : Date.now() / 1000 + 3600);
      lines.push(`${domain}	TRUE	${cookie.path}	${cookie.secure ? 'TRUE' : 'FALSE'}	${expires}	${cookie.name}	${cookie.value}`);
    }
    const file = join(dir, `cookies-${Date.now()}.txt`);
    await writeFile(file, `${lines.join('\n')}\n`, { mode: 0o600 });
    await chmod(file, 0o600).catch(() => undefined);
    return { file, count: cookies.length };
  } finally {
    await context.close().catch(() => undefined);
  }
}

/** 清掉某个站点（或全部）的登录状态。 */
export async function clearSites(deps: BrowserDeps, domain?: string): Promise<{ cleared: number }> {
  const dir = profileDirOf(deps);
  const file = join(dir, 'Default', 'Network', 'Cookies');
  try {
    const { DatabaseSync } = (await import('node:sqlite')) as unknown as {
      DatabaseSync: new (path: string) => { prepare: (sql: string) => { run: (...args: unknown[]) => { changes?: number } }; close: () => void };
    };
    const db = new DatabaseSync(file);
    try {
      const statement = domain
        ? db.prepare('delete from cookies where host_key = ? or host_key like ?')
        : db.prepare('delete from cookies');
      const result = domain ? statement.run(domain, `%${domain}`) : statement.run();
      return { cleared: Number(result.changes ?? 0) };
    } finally {
      db.close();
    }
  } catch {
    return { cleared: 0 };
  }
}
