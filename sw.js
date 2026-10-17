/* ─────────────────────────────────────────────────────────────────────────────
   Iron Log / BJJ Log — service worker
   Strategy:
     • Pages (index.html, bjj.html): NETWORK-FIRST. Every commit shows on the
       next open with no cache-busting. If offline, the last cached copy is
       served so the app still opens at the gym.
     • Other same-origin assets: stale-while-revalidate.
     • Cross-origin requests (Supabase API, fonts, CDNs) and non-GET requests
       are NEVER intercepted — they always go straight to the network.
   Bump CACHE only if you change this file's strategy; page freshness does
   not depend on it because pages are always refetched when online.
   ───────────────────────────────────────────────────────────────────────────── */
const CACHE = 'ironlog-sw-v2';
const PRECACHE = ['./', './index.html', './bjj.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // allSettled: a missing file must not block installation
      .then((c) => Promise.allSettled(PRECACHE.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isPage(req, url) {
  return req.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('/');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // pass through: Supabase, fonts, CDNs

  if (isPage(req, url)) {
    // Cache pages under their path only, so ?v=… busters all map to one entry.
    const key = new Request(url.origin + url.pathname);
    // Last resort when nothing is cached for this path: the root page for a
    // root navigation, otherwise an honest offline notice (never the wrong page).
    const offline = () => {
      if (url.pathname.endsWith('/') || url.pathname.endsWith('/index.html')) return caches.match('./index.html');
      return caches.match(key, { ignoreSearch: true }).then((hit) => hit || new Response(
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<body style="font-family:system-ui;background:#0a0f1a;color:#e2e8f0;padding:24px"><h2>Offline</h2>' +
        '<p>This page has not been cached yet. Reconnect and reload.</p></body>',
        { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
    };
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone(); // clone synchronously before the body is consumed
            caches.open(CACHE).then((c) => c.put(key, copy));
            return res;
          }
          // Host answered but not with the page (5xx, 404 during a deploy):
          // serve the last good copy if there is one, else pass the error through.
          return caches.match(key, { ignoreSearch: true }).then((hit) => hit || res);
        })
        .catch(() => caches.match(key, { ignoreSearch: true }).then((hit) => hit || offline()))
    );
    return;
  }

  // Stale-while-revalidate for other same-origin assets.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
