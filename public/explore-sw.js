// 探索台离线（10-explore-v2-contract.md 第 0、2.1 节）：只在构建版本里注册。
// 页面：网络优先、断网回首页壳；构建产物：缓存优先后台更新；后端：网络优先、断网回离线包；离线瓦片 / 字形：缓存优先。
const SHELL = 'reinlab-shell-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// 页面在准备离线包时把当前用到的构建产物地址发过来，一起放进壳缓存
self.addEventListener('message', e => {
  if (e.data?.type === 'cache-shell') e.waitUntil(caches.open(SHELL).then(c => c.addAll(e.data.urls).catch(() => {})));
});

const fromCache = req => caches.match(req, { ignoreVary: true });

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(r => { const copy = r.clone(); caches.open(SHELL).then(c => c.put('/', copy)); return r; })
      .catch(async () => (await caches.match('/', { cacheName: SHELL })) || Response.error()));
    return;
  }
  if (url.pathname.startsWith('/backend/v1/explore/offline-')) {   // 离线瓦片 / 字形
    e.respondWith(fromCache(req).then(hit => hit || fetch(req)));
    return;
  }
  if (url.pathname.startsWith('/backend/')) {                       // 业务接口：联网用新的，断网用包里的
    if (url.pathname.includes('/stream')) return;                   // 事件流不缓存
    e.respondWith(fetch(req).catch(async () => (await fromCache(req)) || Response.error()));
    return;
  }
  if (url.pathname.startsWith('/assets/') || /\.(js|css|woff2?|svg|png)$/.test(url.pathname)) {
    e.respondWith(caches.open(SHELL).then(async c => {
      const hit = await c.match(req);
      const net = fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
  }
});
