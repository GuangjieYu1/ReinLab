// 注册离线 Service Worker：只在构建版本、安全上下文里（localhost 或可信 HTTPS）。
export async function registerExploreSW() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator) || !window.isSecureContext) return null;
  try { return await navigator.serviceWorker.register('/explore-sw.js', { scope: '/' }); } catch { return null; }
}

/** 把页面当前用到的构建产物放进壳缓存，断网重开时页面能起来。 */
export async function cacheShell() {
  const reg = await navigator.serviceWorker?.ready.catch(() => null);
  if (!reg?.active) return false;
  const urls = ['/', ...performance.getEntriesByType('resource').map(e => new URL(e.name)).filter(u => u.origin === location.origin && !u.pathname.startsWith('/backend')).map(u => u.pathname)];
  reg.active.postMessage({ type: 'cache-shell', urls: [...new Set(urls)] });
  return true;
}
