/* V72 的旧 Service Worker 已退役（v2 改用 /sw.js）。
   老访客浏览器里还注册着 az-sw.js，它会把所有导航都回放成缓存的旧单页。
   浏览器检查到这个新版本后：清空旧缓存 → 注销自己 → 刷新已打开的页面，之后正常加载 v2。 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('az-studio-')).map((k) => caches.delete(k)));
      await self.registration.unregister();
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach((c) => c.navigate(c.url));
    })(),
  );
});
