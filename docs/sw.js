/**
 * AXIN Bridge — Service Worker mínimo
 * Objetivo: hacer la PWA instalable sin asumir un puerto fijo del bridge.
 * Las rutas API del bridge directo y del relay VPS siempre van a red.
 */

const CACHE = 'axin-bridge-v5';
const APP_SHELL = ['./', './index.html', './app.js', './style.css', './manifest.json', './icon.svg'];
const API_PREFIXES = ['/status', '/chat', '/auth', '/market', '/admin', '/panels'];

function isBridgeApiRequest(url) {
  if (API_PREFIXES.some(prefix => url.pathname.startsWith(prefix))) return true;
  return /^\/s\/[^/]+\/api(?:\/|$)/i.test(url.pathname);
}

// Instalar: cachear el app shell
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

// Activar: limpiar caches viejos
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Fetch: red primero para las APIs del bridge/relay; caché para el app shell
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Cualquier request a la API del bridge o del relay VPS -> siempre red
  if (isBridgeApiRequest(url)) {
    e.respondWith(
      fetch(e.request).catch(() =>
        new Response(JSON.stringify({ serverOnline: false, error: 'sw_offline' }), {
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }

  // App shell: caché primero, red de fallback
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
