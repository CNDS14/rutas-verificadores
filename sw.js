/* Service worker: app shell offline; mapas y APIs siempre en línea. */
const VERSION = 'rv-v1.4.1';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/config.js', 'js/catalogo.js', 'js/core.js', 'js/geo.js', 'js/app.js',
  'js/vendor/xlsx.full.min.js', 'js/vendor/leaflet.js', 'js/vendor/leaflet.css', 'js/vendor/exceljs.min.js',
  'fonts/archivo-var.woff2', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png'
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return; // APIs y teselas: red directa
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' }).then(r => { const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request).then(r => r || caches.match('index.html')))
  );
});
