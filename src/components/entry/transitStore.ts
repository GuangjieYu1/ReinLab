// 标识转场（Files ⇄ 工作台）的共享状态。页面发起，常驻的 EmblemTransit 层执行。
import type { EntryWorkbench } from '../cinematic/entryWorkbenches';

export type Transit = {
  id: number;
  direction: 'enter' | 'return';
  workbench: EntryWorkbench;
  from: DOMRect;            // 起点：档案盒上的印章 / 工作台顶栏里的标识
  land: string;             // 终点选择器：在新页面上找到后飞过去
  target: string;           // 中途切换到的地址
  caption: { code: string; title: string; name: string; fileNo: string };
};

export const TRANSIT_END = 'rhine:transit-end';
let current: Transit | null = null;
let seq = 0;
const listeners = new Set<(t: Transit | null) => void>();

export function startTransit(t: Omit<Transit, 'id'>) {
  if (current) return;
  current = { ...t, id: ++seq };
  listeners.forEach(fn => fn(current));
}
export function endTransit() {
  const done = current; current = null;
  listeners.forEach(fn => fn(null));
  if (done) window.dispatchEvent(new CustomEvent(TRANSIT_END, { detail: done.direction }));
}
export const transitActive = () => current !== null;
export function subscribeTransit(fn: (t: Transit | null) => void) { listeners.add(fn); fn(current); return () => { listeners.delete(fn); }; }
