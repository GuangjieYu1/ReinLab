// 注册离线 Service Worker：只在构建版本、安全上下文里（localhost 或可信 HTTPS）。
export async function registerExploreSW() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator) || !window.isSecureContext) return null;
  try { return await navigator.serviceWorker.register('/explore-sw.js', { scope: '/' }); } catch { return null; }
}

/** 把页面当前用到的构建产物放进壳缓存，断网重开时页面能起来。
 *  离线页面（断网入口的离线包列表、离线现场页）在线时不会加载，先主动加载一次，它的分块才会进缓存。 */
export async function cacheShell() {
  const reg = await navigator.serviceWorker?.ready.catch(() => null);
  if (!reg?.active) return false;
  await import('../field/OfflineFieldPage').catch(() => null);
  // 资源计时缓冲区可能已满（准备离线包时请求很多），再从 DOM 里的脚本 / 样式 / 预加载链接补一遍
  const fromDom = [...document.querySelectorAll<HTMLScriptElement | HTMLLinkElement>('script[src], link[href]')].map(e => 'src' in e && e.src ? e.src : (e as HTMLLinkElement).href);
  const urls = ['/', ...[...performance.getEntriesByType('resource').map(e => e.name), ...fromDom].map(n => new URL(n, location.href)).filter(u => u.origin === location.origin && !u.pathname.startsWith('/backend')).map(u => u.pathname)];
  reg.active.postMessage({ type: 'cache-shell', urls: [...new Set(urls)] });
  return true;
}
