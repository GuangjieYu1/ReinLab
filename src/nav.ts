// 页内导航：正式入口与工作台之间用 pushState 切换页面，不整页刷新，
// 这样转场层里的标识可以跨页面连续存在。
export const NAV_EVENT = 'rhine:navigate';

export function navigate(url: string) {
  window.history.pushState(null, '', url);
  window.dispatchEvent(new Event(NAV_EVENT));
}
