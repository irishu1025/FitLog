// Offline support: network-first for app files (so updates show up), cache fallback when offline.
// Versioned SDK files (Firebase, Anthropic) are cached on first use so they load offline too.
const CACHE = 'fitlog-v6';
const ASSETS = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'js/app.js', 'js/ai.js', 'js/calc.js', 'js/charts.js', 'js/db.js', 'js/cloud.js', 'js/firebase-config.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Versioned library files (Firebase SDK, Anthropic SDK) never change: cache-first.
  const pinnedLib = (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/'))
    || (url.hostname === 'cdn.jsdelivr.net' && url.pathname.startsWith('/npm/@anthropic-ai/sdk@'));
  if (pinnedLib) {
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })),
    );
    return;
  }

  // Same-origin app files only; never touch AI, Firestore or sign-in traffic (incl. /__/auth/).
  if (url.origin !== self.location.origin || url.pathname.startsWith('/__/')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))),
  );
});
