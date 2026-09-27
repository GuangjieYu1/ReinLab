/**
 * 解析 OpenMAIC 站点地址。
 *
 * 优先取构建期环境变量 VITE_OPENMAIC_ORIGIN；开发服务器下沿用原先的本地地址，
 * 让 `npm run dev` 的既有行为完全不变。
 *
 * 生产构建（即打包进 iOS / iPadOS 外壳的那一份）在未显式配置时为空：
 * 设备上的 127.0.0.1 指向设备自己，绝不能作为回退值，否则只会跳到失败页面。
 */
function resolveOrigin(): string {
  const configured = (import.meta.env.VITE_OPENMAIC_ORIGIN ?? '').trim();
  if (configured) return configured.replace(/\/+$/, '');
  return import.meta.env.DEV ? 'http://127.0.0.1:3000' : '';
}

const OPENMAIC_ORIGIN = resolveOrigin();

let departurePending = false;

/** 是否已配置可跳转的 OpenMAIC 地址。 */
export function isOpenMAICConfigured(): boolean {
  return OPENMAIC_ORIGIN.length > 0;
}

/** Keep the old archive visible while a physical file is drawn and opened. */
export function enterOpenMAIC(destination: 'reinlab' | 'workspace', reduced = false): void {
  if (departurePending) return;
  departurePending = true;
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
  caption.textContent = OPENMAIC_ORIGIN
    ? `01 / 抽取档案     02 / 展开文件     03 / ${destination === 'reinlab' ? '进入课堂目录' : '进入创作工作区'}`
    : '01 / 抽取档案     02 / 展开文件     03 / 本地预览';
  curtain.append(folder, leaf, caption);
  document.body.append(curtain);
  requestAnimationFrame(() => curtain.classList.add('is-covering'));

  const delay = reduced ? 90 : 1380;

  if (!OPENMAIC_ORIGIN) {
    // 没有可跳转的地址：留在当前终端，并把原因讲清楚。允许稍后重试。
    const notice = document.createElement('div');
    notice.className = 'rhine-portal-notice';
    notice.setAttribute('role', 'alert');
    notice.textContent = '未配置 OpenMAIC 地址，本次不会离开当前终端。';
    curtain.append(notice);
    window.setTimeout(() => {
      curtain.classList.remove('is-covering');
      window.setTimeout(() => { curtain.remove(); departurePending = false; }, reduced ? 0 : 420);
    }, delay);
    return;
  }

  const url = destination === 'reinlab'
    ? `${OPENMAIC_ORIGIN}/reinlab?entry=rhine`
    : `${OPENMAIC_ORIGIN}/workspace`;
  window.setTimeout(() => window.location.assign(url), delay);
}
