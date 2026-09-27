const OPENMAIC_ORIGIN = 'http://127.0.0.1:3000';
let departurePending = false;

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
  caption.textContent = `01 / 抽取档案     02 / 展开文件     03 / ${destination === 'reinlab' ? '进入课堂目录' : '进入创作工作区'}`;
  curtain.append(folder, leaf, caption);
  document.body.append(curtain);
  requestAnimationFrame(() => curtain.classList.add('is-covering'));
  const url = destination === 'reinlab'
    ? `${OPENMAIC_ORIGIN}/reinlab?entry=rhine`
    : `${OPENMAIC_ORIGIN}/workspace`;
  window.setTimeout(() => window.location.assign(url), reduced ? 90 : 1380);
}
