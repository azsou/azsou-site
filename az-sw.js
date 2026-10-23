/* AZ Studio offline shell — V66: stale-while-revalidate for navigations.
   The visitor always gets the cached shell instantly (offline included);
   the network copy refreshes the cache in the background, and when it
   differs the page is told so it can offer a one-tap refresh.
   Bump CACHE on every release. */
const CACHE = 'az-studio-v72-2';
const SHELL = ['./'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});

async function tellClients(message){
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  clients.forEach(c => c.postMessage(message));
}

async function bytesDiffer(a, b){
  const [ba, bb] = await Promise.all([a.arrayBuffer(), b.arrayBuffer()]);
  if (ba.byteLength !== bb.byteLength) return true;
  const va = new Uint8Array(ba), vb = new Uint8Array(bb);
  /* compare a sparse sample + tail — cheap and adequate for "did it change" */
  const step = Math.max(1, Math.floor(va.length / 4096));
  for (let i = 0; i < va.length; i += step) if (va[i] !== vb[i]) return true;
  for (let i = Math.max(0, va.length - 64); i < va.length; i++) if (va[i] !== vb[i]) return true;
  return false;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.mode === 'navigate'){
    /* stale-while-revalidate: cached shell now, refresh in background.
       The refresh promise is handed to waitUntil SYNCHRONOUSLY — without
       that the worker may be terminated before the background fetch,
       compare and postMessage ever run. */
    const refresh = (async () => {
      let res = null;
      try { res = await fetch(req); } catch (err) { return null; }
      if (res && res.ok){
        const cache = await caches.open(CACHE);
        const cached = await cache.match('./');
        const fresh = res.clone();
        if (cached && await bytesDiffer(cached.clone(), res.clone())){
          await cache.put('./', fresh);
          await tellClients({ type: 'az-sw-updated' });
        } else if (!cached){
          await cache.put('./', fresh);
        }
      }
      return res;
    })();
    e.waitUntil(refresh);
    e.respondWith((async () => {
      const cached = await caches.match('./');
      if (cached) return cached;
      const net = await refresh;
      return net || new Response('offline', { status: 503 });
    })());
    return;
  }
  if (new URL(req.url).origin === location.origin){
    e.respondWith(caches.match(req).then(hit => hit || fetch(req)));
  }
});
