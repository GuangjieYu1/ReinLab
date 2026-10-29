// 只在最近的滚动容器里滚动，不像 scrollIntoView 那样连带滚动外层的 overflow:hidden 容器（那会把整页挤偏）。
export function scrollWithin(el: Element | null | undefined, block: 'start' | 'center' = 'center') {
  if (!el) return;
  let box = el.parentElement;
  while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
  if (!box) return;
  const r = el.getBoundingClientRect(), b = box.getBoundingClientRect();
  const delta = block === 'start' ? r.top - b.top - 12 : r.top - b.top - (b.height - r.height) / 2;
  box.scrollTo({ top: box.scrollTop + delta, behavior: 'smooth' });
}
