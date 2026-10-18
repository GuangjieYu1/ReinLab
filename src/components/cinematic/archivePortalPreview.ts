import { openingApproachScale, openingCoverTransform, openingTransform, type OpeningRect } from './archiveOpening';

const ease = 'cubic-bezier(.22,1,.36,1)';
const foldEase = 'cubic-bezier(.32,.08,.3,1)';

/** Carry the selected real cassette to a handoff plate; no OpenMAIC content mounts. */
export function previewArchivePortal(destination: 'reinlab' | 'workspace', reduced: boolean, onClose: () => void): void {
  const app = document.querySelector<HTMLElement>('.app');
  const cinema = document.querySelector<HTMLElement>('.cinema-experience:not([hidden])');
  const viewport = cinema?.querySelector<HTMLElement>('.cine-scene-viewport');
  const cassette = cinema?.querySelector<HTMLElement>('.cine-cassette.selected');
  const sourceFace = cassette?.querySelector<HTMLElement>('.cassette-front');
  const focusOrigin = document.activeElement;
  const originalInert = app?.inert ?? false;
  const previousTransform = viewport?.style.transform ?? '';
  const previousOrigin = viewport?.style.transformOrigin ?? '';
  const previousOpacity = viewport?.style.opacity ?? '';
  const originalRect = sourceFace?.getBoundingClientRect();
  let near: OpeningRect | undefined;
  let approachScale = 1;
  let ready = false;
  let closing = false;
  let closed = false;
  const animations: Animation[] = [];
  const duration = (ms: number) => reduced ? 0 : ms;
  const run = (element: HTMLElement, keyframes: Keyframe[], ms: number, delay = 0) => {
    const animation = element.animate(keyframes, { duration: duration(ms), delay: duration(delay), easing: ease, fill: 'both' });
    animations.push(animation);
    return animation.finished;
  };

  const overlay = document.createElement('section');
  overlay.className = 'cine-preview-portal';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'cine-preview-portal-title');
  const background = document.createElement('div');
  background.className = 'cine-preview-portal-background';
  const paper = document.createElement('article');
  paper.className = 'cine-preview-portal-paper';
  const content = document.createElement('div');
  content.className = 'cine-preview-portal-content';
  // All copy is a local handoff marker. The study stops before external navigation.
  content.innerHTML = `<header><span>RHINE LAB / KNOWLEDGE DIVISION</span><span>TRANSFER / 01</span></header>
    <div class="cine-preview-portal-identity"><span>INTERNAL DATABASE</span><h1 id="cine-preview-portal-title">RHINE LAB</h1><div class="cine-preview-portal-rule"></div><h2>OpenMAIC<span>${destination === 'reinlab' ? '课程档案' : '聊天主页'}</span></h2><p>档案已展开，准备进入下一段探索。</p></div>
    <footer><span><i></i>进入前的交接点 · 预览到这里结束</span><button type="button" disabled>返回档案 <span>↗</span></button></footer>`;
  const button = content.querySelector<HTMLButtonElement>('button')!;
  paper.append(content);
  overlay.append(background, paper);
  document.body.append(overlay);
  if (app) app.inert = true;
  overlay.tabIndex = -1;
  overlay.focus({ preventScroll: true });

  let cover: HTMLDivElement | undefined;
  const clean = () => {
    if (closed) return;
    closed = true;
    if (viewport) {
      viewport.style.transform = previousTransform;
      viewport.style.transformOrigin = previousOrigin;
      viewport.style.opacity = previousOpacity;
    }
    animations.forEach(animation => animation.cancel());
    overlay.remove();
    if (app) app.inert = originalInert;
    if (focusOrigin instanceof HTMLElement && focusOrigin.isConnected) focusOrigin.focus({ preventScroll: true });
    onClose();
  };

  const close = async () => {
    if (!ready || closing) return;
    closing = true;
    button.disabled = true;
    try {
      const frame = overlay.getBoundingClientRect();
      const target = paper.getBoundingClientRect();
      if (viewport && near && cover && !reduced) {
        cover.style.opacity = '1';
        cover.style.transform = openingCoverTransform(target, frame);
        viewport.style.transform = `scale(${approachScale})`;
        viewport.style.opacity = '0';
        background.style.opacity = '1';
        paper.style.opacity = '0';
        animations.splice(0).forEach(animation => animation.cancel());
        await Promise.all([
          run(cover, [{ transform: openingCoverTransform(target, frame) }, { transform: openingCoverTransform(near, frame) }], 620),
          run(cover, [{ opacity: 1 }, { opacity: 1, offset: .7 }, { opacity: 0 }], 620),
          run(background, [{ opacity: 1 }, { opacity: 0 }], 520, 140),
          run(viewport, [{ opacity: 0 }, { opacity: 1 }], 340, 280),
        ]);
        cover.style.opacity = '0';
        viewport.style.opacity = previousOpacity;
        animations.splice(0).forEach(animation => animation.cancel());
        overlay.style.opacity = '0';
        await run(viewport, [{ transform: `scale(${approachScale})` }, { transform: previousTransform || 'scale(1)' }], 700);
      } else {
        await run(overlay, [{ opacity: 1 }, { opacity: 0 }], 240);
      }
    } finally { clean(); }
  };
  button.addEventListener('click', () => { void close(); });
  overlay.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); void close(); }
    if (event.key === 'Tab') { event.preventDefault(); if (ready) button.focus(); }
  });

  void (async () => {
    try {
      const frame = overlay.getBoundingClientRect();
      const target = paper.getBoundingClientRect();
      paper.style.opacity = '0';
      background.style.opacity = '0';
      if (viewport && sourceFace && originalRect && !reduced) {
        const viewportFrame = viewport.getBoundingClientRect();
        approachScale = openingApproachScale(viewportFrame.height, originalRect);
        viewport.style.transformOrigin = `${originalRect.x + originalRect.width / 2 - viewportFrame.x}px ${originalRect.y + originalRect.height / 2 - viewportFrame.y}px`;
        await run(viewport, [{ transform: previousTransform || 'scale(1)' }, { transform: `scale(${approachScale})` }], 760);
        viewport.style.transform = `scale(${approachScale})`;
        const actual = sourceFace.getBoundingClientRect();
        near = { x: actual.x, y: actual.y, width: actual.width, height: actual.height };
        cover = document.createElement('div');
        cover.className = 'cine-cassette selected cine-opening-cover cine-preview-portal-cover';
        cover.setAttribute('aria-hidden', 'true');
        cover.inert = true;
        const material = getComputedStyle(cassette!);
        cover.style.setProperty('--cassette-clarity', material.getPropertyValue('--cassette-clarity'));
        cover.style.setProperty('--cassette-scan', material.getPropertyValue('--cassette-scan'));
        const mechanism = cassette?.querySelector('.cassette-mechanism');
        if (mechanism) cover.append(mechanism.cloneNode(true));
        cover.append(sourceFace.cloneNode(true));
        overlay.append(cover);
        await Promise.all([
          run(cover, [{ transform: openingCoverTransform(near, frame), easing: foldEase }, { transform: openingCoverTransform(target, frame) }], 720),
          run(cover, [{ opacity: 1 }, { opacity: 1, offset: .3 }, { opacity: 0, offset: .85 }, { opacity: 0 }], 720),
          run(background, [{ opacity: 0 }, { opacity: 1 }], 620),
          run(viewport, [{ opacity: 1 }, { opacity: 0 }], 360),
          run(paper, [{ transformOrigin: '0 0', transform: openingTransform(near, target) }, { transformOrigin: '0 0', transform: 'none' }], 720),
          run(paper, [{ opacity: 0 }, { opacity: 0, offset: .16 }, { opacity: 1, offset: .8 }, { opacity: 1 }], 720),
          run(content, [{ opacity: 0, transform: 'translateY(16px)' }, { opacity: 1, transform: 'translateY(0)' }], 480, 320),
        ]);
      } else {
        await Promise.all([
          run(background, [{ opacity: 0 }, { opacity: 1 }], 280),
          run(paper, [{ opacity: 0, transform: 'translateY(16px)' }, { opacity: 1, transform: 'none' }], 380),
        ]);
      }
      // Release the projected layers at their final pose so text returns to
      // normal rasterization instead of retaining a scaled compositor surface.
      paper.style.opacity = '1';
      paper.style.transform = '';
      background.style.opacity = '1';
      content.style.opacity = '1';
      content.style.transform = '';
      if (cover) cover.style.opacity = '0';
      if (viewport && near) viewport.style.opacity = '0';
      animations.splice(0).forEach(animation => animation.cancel());
      ready = true;
      button.disabled = false;
      button.focus({ preventScroll: true });
    } catch { clean(); }
  })();
}
