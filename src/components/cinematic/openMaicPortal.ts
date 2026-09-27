import { Capacitor } from '@capacitor/core';
import { Browser } from '@capacitor/browser';

/** 设置面板里填写的地址；与构建期环境变量分开保存，不进仓库。 */
export const OPENMAIC_ORIGIN_KEY = 'reinlab-openmaic-origin-v1';

/**
 * 原生课程层访问 /api/reinlab/* 时携带的令牌。
 *
 * 只在服务端设置了 REINLAB_EXPORT_TOKEN 时才需要填写。与地址一样存在本机：
 * 令牌属于部署信息，写进构建产物就意味着每换一次都要重新出包。
 */
export const OPENMAIC_TOKEN_KEY = 'reinlab-openmaic-token-v1';

export function readStoredToken(): string {
  try { return (localStorage.getItem(OPENMAIC_TOKEN_KEY) ?? '').trim(); } catch { return ''; }
}

export function writeStoredToken(value: string): void {
  try {
    const next = value.trim();
    if (next) localStorage.setItem(OPENMAIC_TOKEN_KEY, next);
    else localStorage.removeItem(OPENMAIC_TOKEN_KEY);
  } catch { /* 存储不可用时仅本次会话生效。 */ }
}

const stripTrailingSlashes = (url: string) => url.replace(/\/+$/, '');

/** 读取设置面板中保存的地址；存储不可用时返回空串。 */
export function readStoredOrigin(): string {
  try { return (localStorage.getItem(OPENMAIC_ORIGIN_KEY) ?? '').trim(); } catch { return ''; }
}

/** 保存设置面板中的地址；传空串表示清除。 */
export function writeStoredOrigin(value: string): void {
  try {
    const next = value.trim();
    if (next) localStorage.setItem(OPENMAIC_ORIGIN_KEY, next);
    else localStorage.removeItem(OPENMAIC_ORIGIN_KEY);
  } catch { /* 存储不可用时仅本次会话生效，不阻断使用。 */ }
}

/**
 * 解析 OpenMAIC 站点地址。**每次调用时求值**，因此在设置面板里改完即刻生效，
 * 不需要重启应用，也不需要重新出包。
 *
 * 优先级：
 *   1. 构建期环境变量 `VITE_OPENMAIC_ORIGIN`（由 CI 或 .env.local 注入）
 *   2. 用户在设置面板中填写的地址（存在本机）
 *   3. 仅开发服务器回退到 `http://127.0.0.1:3000`，保持 `npm run dev` 的原有行为
 *
 * 生产构建绝不回退到 127.0.0.1：设备上的它指向设备自己，只会跳到失败页面。
 */
export function resolveOrigin(): string {
  const configured = (import.meta.env.VITE_OPENMAIC_ORIGIN ?? '').trim();
  if (configured) return stripTrailingSlashes(configured);
  const stored = readStoredOrigin();
  if (stored) return stripTrailingSlashes(stored);
  return import.meta.env.DEV ? 'http://127.0.0.1:3000' : '';
}

/** 是否已配置可跳转的 OpenMAIC 地址。 */
export function isOpenMAICConfigured(): boolean {
  return resolveOrigin().length > 0;
}

/** 构建期是否已注入地址（由 CI 或 .env.local 提供）。 */
export function hasBuildOrigin(): boolean {
  return (import.meta.env.VITE_OPENMAIC_ORIGIN ?? '').trim().length > 0;
}

let departurePending = false;

/** Keep the old archive visible while a physical file is drawn and opened. */
export function enterOpenMAIC(destination: 'reinlab' | 'workspace', reduced = false): void {
  if (departurePending) return;
  departurePending = true;
  const origin = resolveOrigin();
  const curtain = document.createElement('div');
  curtain.className = 'rhine-portal-departure';
  curtain.setAttribute('role', 'status');
  curtain.setAttribute('aria-live', 'polite');
  const folder = document.createElement('div');
  folder.className = 'rhine-portal-folder';
  folder.setAttribute('aria-hidden', 'true');
  const tab = document.createElement('span');
  tab.textContent = 'RHINE LAB / KNOWLEDGE DIVISION';
  const pocket = document.createElement('i');
  folder.append(tab, pocket);
  const leaf = document.createElement('div');
  leaf.className = 'rhine-portal-leaf';
  const serial = document.createElement('small');
  serial.textContent = 'INTERNAL DATABASE / X—013';
  const brand = document.createElement('span');
  brand.textContent = 'RHINE LAB';
  const line = document.createElement('i');
  const target = document.createElement('b');
  target.textContent = destination === 'reinlab' ? 'OPENMAIC / LEARNING ARCHIVE' : 'OPENMAIC / WORKSPACE';
  leaf.append(serial, brand, line, target);
  const caption = document.createElement('p');
  caption.textContent = origin
    ? `01 / 抽取档案     02 / 展开文件     03 / ${destination === 'reinlab' ? '进入课堂目录' : '进入创作工作区'}`
    : '01 / 抽取档案     02 / 展开文件     03 / 本地预览';
  curtain.append(folder, leaf, caption);
  document.body.append(curtain);
  requestAnimationFrame(() => curtain.classList.add('is-covering'));

  const delay = reduced ? 90 : 1380;

  if (!origin) {
    // 没有可跳转的地址：留在当前终端，并说明去哪里填。允许稍后重试。
    const notice = document.createElement('div');
    notice.className = 'rhine-portal-notice';
    notice.setAttribute('role', 'alert');
    notice.textContent = '未配置 OpenMAIC 地址，本次不会离开当前终端。请在「工作台 → 终端设置」中填写。';
    curtain.append(notice);
    window.setTimeout(() => {
      curtain.classList.remove('is-covering');
      window.setTimeout(() => { curtain.remove(); departurePending = false; }, reduced ? 0 : 420);
    }, delay);
    return;
  }

  const url = destination === 'reinlab'
    ? `${origin}/reinlab?entry=rhine`
    : `${origin}/workspace`;

  if (Capacitor.isNativePlatform()) {
    // 原生外壳里整页跳转会离开应用、且没有返回按钮可点。
    // 改用应用内浏览器 sheet：关闭 sheet 即回到原位，
    // 因此不需要 OpenMAIC 侧的 ?return=archive 回跳地址。
    window.setTimeout(async () => {
      curtain.classList.remove('is-covering');
      window.setTimeout(() => curtain.remove(), 220);
      const handle = await Browser.addListener('browserFinished', () => {
        departurePending = false;
        void handle.remove();
      });
      await Browser.open({ url });
    }, delay);
    return;
  }

  window.setTimeout(() => window.location.assign(url), delay);
}
