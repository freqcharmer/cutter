// Offline support: every file is fetched fresh when online and served from cache when offline.
const CACHE = 'fantasticut-v4';
// Every deployed file. tests/run.mjs fails if a file is missing from this list or the list names a missing file.
const CORE = [
  './', 'index.html', 'app.css', 'styles.css', 'manifest.webmanifest', 'terms.html', 'privacy.html',
  'assets/fantasticut-decal-1color.svg', 'assets/fantasticut-icon-16.png', 'assets/fantasticut-icon-16.svg',
  'assets/fantasticut-icon-192.png', 'assets/fantasticut-icon-24.svg', 'assets/fantasticut-icon-32.png',
  'assets/fantasticut-icon-512.png', 'assets/fantasticut-icon-teal.svg', 'fonts/bebas-neue.woff',
  'fonts/oswald-bold.woff', 'fonts/outfit-400.woff2', 'fonts/outfit-500.woff2', 'fonts/outfit-600.woff2',
  'fonts/pacifico.woff', 'fonts/space-grotesk-bold.woff', 'src/app.js', 'src/centerline.js', 'src/clip.js',
  'src/doc.js', 'src/geom.js', 'src/hpgl.js', 'src/import-dxf.js', 'src/import-image.js', 'src/import-svg.js',
  'src/job.js', 'src/nest-core.js', 'src/nest-worker.js', 'src/nodes.js', 'src/presets.js', 'src/serial.js',
  'src/store.js', 'src/text.js', 'src/trace-core.js', 'src/trace-worker.js', 'src/view.js', 'vendor/clipper2.mjs',
  'vendor/dxf-parser.mjs', 'vendor/fit-curve.mjs', 'vendor/imagetracer.mjs', 'vendor/opentype.mjs',
  'vendor/svgpath.mjs',
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
