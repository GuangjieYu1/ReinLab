/**
 * 素材浏览器（契约 §14.8）：按需弹一个独立的 Chromium 窗口，用 Playwright 的持久化配置目录，
 * 和作者平时用的 Chrome 完全隔开。作者自己登录；yt-dlp 用 --cookies-from-browser 直接读这个目录，
 * 我们不导出、不打印、不进模型上下文。
 */

import { chmod, mkdir } from 'node:fs/promises';
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
export async function listSites(deps: BrowserDeps): Promise<BrowserSite[]> {
  const dir = profileDirOf(deps);
  const file = join(dir, 'Default', 'Network', 'Cookies');
  try {
    // node:sqlite（Node 22.5+ 实验特性）
    const { DatabaseSync } = (await import('node:sqlite')) as unknown as {
      DatabaseSync: new (path: string) => { prepare: (sql: string) => { all: () => BrowserSite[] }; close: () => void };
    };
    const db = new DatabaseSync(file);
    try {
      const rows = db
        .prepare('select host_key as domain, datetime(last_access_utc/1000000, "unixepoch") as lastUsedAt from cookies group by host_key order by last_access_utc desc')
        .all();
      return rows;
    } finally {
      db.close();
    }
  } catch {
    return [];
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
