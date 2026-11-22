/* AZ Studio v2 · 离线外壳
   导航：网络优先，失败回退到已缓存页面，再回退到 /offline/。
   同源静态资源（/_astro/、/art/、/og/、图标）：缓存优先 + 后台更新。
   Astro 资源带内容哈希，发版无需改版本号；只有改了本文件逻辑才需要改 VERSION。 */
const VERSION = 'az-v2-1';
const SHELL = ['/', '/offline/', '/manifest.webmanifest', '/favicon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(VERSION)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin !== location.origin) return; // Supabase 等跨域请求不经 SW

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(
          async () =>
            (await caches.match(req)) ||
            (await caches.match('/offline/')) ||
            new Response('offline', { status: 503 }),
        ),
    );
    return;
  }

  if (/^\/(_astro|art|og|icons)\/|\.(svg|png|woff2?)$/.test(u.pathname)) {
    e.respondWith(
      caches.match(req).then((hit) => {
        const net = fetch(req)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(VERSION).then((c) => c.put(req, copy));
            }
            return res;
          })
          .catch(() => hit);
        return hit || net;
      }),
    );
  }
});
