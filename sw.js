// Overlay Presenter — offline cache (service worker).
// After one visit the app, PDF.js and pdf-lib are stored on the device, so the presenter
// starts and runs with no network at all. When online, the app's own code is fetched fresh
// (falling back to the stored copy after a few seconds on poor Wi-Fi), so updates still arrive.
// Bump CACHE when a library file changes (the libraries are cached first, not re-checked).
const CACHE = 'overlay-presenter-v1';
const CORE = ['./', './index.html', './app.js'];
const CDN = 'https://cdn.jsdelivr.net/';
const LIBS = [                    // local copies if present (self-hosted with libraries), and the pinned CDN builds
  './pdf.min.mjs', './pdf.worker.min.mjs', './pdf-lib.min.js',
  CDN + 'npm/pdfjs-dist@6.5.438/build/pdf.min.mjs',
  CDN + 'npm/pdfjs-dist@6.5.438/build/pdf.worker.min.mjs',
  CDN + 'npm/pdf-lib@1.17.1/dist/pdf-lib.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // Store each file separately so one missing file (e.g. a different folder layout) doesn't block the rest.
    await Promise.all([...CORE, ...LIBS].map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

const isLib = (url) => url.startsWith(CDN) || /\.(mjs|wasm|pfb|ttf)$|pdf-lib\.min\.js$|\/standard_fonts\//.test(url);

async function networkFirst(req) {
  const c = await caches.open(CACHE);
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, rej) => setTimeout(() => rej(new Error('slow network')), 3500)),
    ]);
    if (res.ok) c.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await c.match(req, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}
async function cacheFirst(req) {
  const c = await caches.open(CACHE);
  const hit = await c.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) c.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = req.url;
  const sameOrigin = url.startsWith(self.location.origin);
  if (!sameOrigin && !url.startsWith(CDN)) return;          // leave everything else alone
  e.respondWith(isLib(url) ? cacheFirst(req) : networkFirst(req));
});
