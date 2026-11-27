// Offline support: every file is fetched fresh when online and served from cache when offline.
const CACHE = 'fantasticut-v2';
const CORE = [
  './', 'index.html', 'app.css', 'styles.css', 'manifest.webmanifest', 'terms.html', 'privacy.html',
  'assets/logo-mark.svg', 'assets/icon-192.png', 'assets/icon-512.png',
  'src/app.js', 'src/clip.js', 'src/doc.js', 'src/geom.js', 'src/hpgl.js', 'src/import-dxf.js', 'src/import-image.js',
  'src/import-svg.js', 'src/job.js', 'src/presets.js', 'src/serial.js', 'src/store.js', 'src/text.js', 'src/view.js',
  'vendor/clipper2.mjs', 'vendor/dxf-parser.mjs', 'vendor/imagetracer.mjs', 'vendor/opentype.mjs', 'vendor/svgpath.mjs',
  'fonts/bebas-neue.woff', 'fonts/oswald-bold.woff', 'fonts/pacifico.woff', 'fonts/space-grotesk-bold.woff',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === location.origin;
  const googleFonts = /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (!sameOrigin && !googleFonts) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const net = await fetch(req);
      if (net.ok || net.type === 'opaque') cache.put(req, net.clone());
      return net;
    } catch {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') return cache.match('index.html');
      throw new Error('offline');
    }
  })());
});
