export type OpeningRect = { x: number; y: number; width: number; height: number };
// Match the established return: 680ms to fold, then 820ms to retreat.
// Opening gives those two movements their full duration in the opposite order.
export const OPENING_APPROACH_DURATION = 820;
export const OPENING_UNFOLD_DURATION = 680;
export const OPENING_DURATION = OPENING_APPROACH_DURATION + OPENING_UNFOLD_DURATION;
const approachEase = 'cubic-bezier(.32,.08,.2,1)';
const unfoldEase = 'cubic-bezier(.32,.08,.3,1)';
const COVER_WIDTH = 500;
const COVER_HEIGHT = 370;

/** Rectangles are measured in viewport coordinates, never in the 3D field. */
export function openingTransform(from: OpeningRect, to: OpeningRect) {
  return `translate3d(${from.x - to.x}px,${from.y - to.y}px,0) scale(${from.width / Math.max(1, to.width)},${from.height / Math.max(1, to.height)})`;
}

export function openingNearRect(source: OpeningRect, scale: number): OpeningRect {
  return {
    x: source.x - source.width * (scale - 1) / 2,
    y: source.y - source.height * (scale - 1) / 2,
    width: source.width * scale,
    height: source.height * scale,
  };
}

export function openingApproachScale(height: number, source: OpeningRect) {
  return Math.max(1.3, Math.min(2.2, height * .82 / Math.max(1, source.height)));
}

/** Position the archive's actual face artwork in the same viewport rect as the lesson. */
export function openingCoverTransform(rect: OpeningRect, frame: OpeningRect) {
  return `translate3d(${rect.x - frame.x}px,${rect.y - frame.y}px,0) scale(${rect.width / COVER_WIDTH},${rect.height / COVER_HEIGHT})`;
}

function createOpeningCover(root: HTMLElement, sourceFace: HTMLElement) {
  const layer = root.querySelector<HTMLElement>('.cine-classroom-layer');
  if (!layer) throw new Error('Opening layer is not mounted');
  const cover = document.createElement('div');
  cover.className = 'cine-cassette selected cine-opening-cover';
  cover.setAttribute('aria-hidden', 'true');
  cover.inert = true;
  const cassette = sourceFace.closest<HTMLElement>('.cine-cassette');
  if (cassette) {
    const material = getComputedStyle(cassette);
    cover.style.setProperty('--cassette-clarity', material.getPropertyValue('--cassette-clarity'));
    cover.style.setProperty('--cassette-scan', material.getPropertyValue('--cassette-scan'));
    const mechanism = cassette.querySelector<HTMLElement>(':scope > .cassette-mechanism');
    if (mechanism) cover.append(mechanism.cloneNode(true));
  }
  cover.append(sourceFace.cloneNode(true));
  // The classroom content sits above this physical cover. It gradually becomes
  // readable while the same cover continues to unfold underneath it.
  layer.insertBefore(cover, layer.querySelector('.research-lab, .learning-terminal, .course-terminal'));
  return cover;
}

/** Start the physical approach on the click, while the lesson mounts offscreen. */
export function startArchiveApproach(viewport: HTMLElement, source: OpeningRect) {
  const frame = viewport.getBoundingClientRect();
  const scale = openingApproachScale(frame.height, source);
  viewport.style.transformOrigin = `${source.x + source.width / 2 - frame.x}px ${source.y + source.height / 2 - frame.y}px`;
  const animation = viewport.animate(
    [{ transform: 'scale(1)' }, { transform: `scale(${scale})` }],
    { duration: OPENING_APPROACH_DURATION, easing: approachEase, fill: 'forwards' },
  );
  return {
    finished: animation.finished,
    settle() {
      viewport.style.transform = `scale(${scale})`;
      animation.cancel();
    },
    cancel() {
      animation.cancel();
      viewport.style.transform = '';
      viewport.style.transformOrigin = '';
    },
  };
}

/** Continue that exact face into the lesson after the camera reaches it.
 * The lesson has already been laid out offscreen; all first frames are
 * installed in the same layout effect, before the next paint.
 * The established return path is intentionally left untouched.
 */
export function animateArchiveUnfold(root: HTMLElement, viewport: HTMLElement, source: OpeningRect) {
  const main = root.querySelector<HTMLElement>('.research-lab-main, .rl-main[data-surface="live"], .course-main[data-surface="live"]');
  if (!main) throw new Error('Opening surface is not mounted');
  const sourceFace = viewport.querySelector<HTMLElement>('.cine-cassette.selected > .cassette-front');
  if (!sourceFace) throw new Error('Opening cassette is not mounted');
  // Layout projection may have written a transform during the child commit.
  // Read the destination with that transform removed, before installing ours.
  main.style.transform = 'none';
  const destination = main.getBoundingClientRect();
  const rootFrame = root.getBoundingClientRect();
  const scale = openingApproachScale(rootFrame.height, source);
  // Use the actual projected 3D face after the approach, not an estimated
  // scaled box; perspective can otherwise create a visible handoff nudge.
  const nearFace = sourceFace.getBoundingClientRect();
  const near = { x: nearFace.x, y: nearFace.y, width: nearFace.width, height: nearFace.height };
  const cover = createOpeningCover(root, sourceFace);
  cover.style.transform = openingCoverTransform(near, rootFrame);
  const animations: Animation[] = [];
  const startTime = document.timeline.currentTime;
  const run = (element: HTMLElement, keyframes: Keyframe[]) => {
    const animation = element.animate(keyframes, { duration: OPENING_UNFOLD_DURATION, fill: 'both' });
    if (startTime !== null) animation.startTime = startTime;
    animations.push(animation);
  };
  run(viewport, [
    { offset: 0, opacity: 1 },
    { offset: .03, opacity: 1, easing: unfoldEase },
    { offset: .26, opacity: 0 },
    { offset: 1, opacity: 0 },
  ]);
  run(cover, [
    { offset: 0, transform: openingCoverTransform(near, rootFrame), easing: unfoldEase },
    { offset: 1, transform: openingCoverTransform(destination, rootFrame) },
  ]);
  run(cover, [
    { offset: 0, opacity: 1 },
    { offset: .32, opacity: 1, easing: unfoldEase },
    { offset: .8, opacity: 0 },
    { offset: 1, opacity: 0 },
  ]);
  run(main, [
    { offset: 0, transformOrigin: '0 0', transform: openingTransform(near, destination), easing: unfoldEase },
    { offset: 1, transformOrigin: '0 0', transform: 'translate3d(0,0,0) scale(1,1)' },
  ]);
  run(main, [
    { offset: 0, opacity: 0 },
    { offset: .11, opacity: 0, easing: unfoldEase },
    { offset: .69, opacity: 1 },
    { offset: 1, opacity: 1 },
  ]);
  const researchLab = root.querySelector<HTMLElement>('.cine-research-layer > .research-lab');
  if (researchLab) run(researchLab, [
    { offset: 0, opacity: 0 },
    { offset: .18, opacity: 0, easing: unfoldEase },
    { offset: 1, opacity: 1 },
  ]);
  root.querySelectorAll<HTMLElement>('.cine-classroom-backdrop, .rl-header, .rl-footer, .course-header, .course-identity, .course-spine-index').forEach(element => {
    run(element, [
      { offset: 0, opacity: 0 },
      { offset: .18, opacity: 0, easing: unfoldEase },
      { offset: 1, opacity: 1 },
    ]);
  });
  const notebook = root.querySelector<HTMLElement>('.rl-notebook');
  if (notebook) run(notebook, [
    { offset: 0, opacity: 0, transform: 'translate3d(14px,0,0)' },
    { offset: .22, opacity: 0, transform: 'translate3d(14px,0,0)', easing: unfoldEase },
    { offset: 1, opacity: 1, transform: 'translate3d(0,0,0)' },
  ]);
  return {
    finished: Promise.all(animations.map(animation => animation.finished)),
    settle() {
      // Preserve the near-camera pose for the unchanged reverse transition.
      viewport.style.transform = `scale(${scale})`;
      viewport.style.opacity = '';
      main.style.transform = 'none';
      main.style.opacity = '1';
      animations.forEach(animation => animation.cancel());
      cover.remove();
    },
    cancel() { animations.forEach(animation => animation.cancel()); cover.remove(); },
  };
}
