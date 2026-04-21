/**
 * AXIN Bridge — Service Worker mínimo
 * Objetivo: hacer la PWA instalable. Sin caching agresivo en v0.1.
 * El endpoint /status siempre va a red — nunca usar caché para datos del servidor.
 */

const CACHE = 'axin-bridge-v4';
const APP_SHELL = ['./', './index.html', './app.js', './style.css', './manifest.json', './icon.svg'];

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

// Fetch: red primero para el endpoint /status; caché para el app shell
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Las peticiones al endpoint del servidor siempre van a red
  // Cualquier request a la API del servidor (status, chat, auth, admin) → siempre red
  if (url.port === '42421' || ['/status', '/chat', '/auth', '/market', '/admin'].some(p => url.pathname.startsWith(p))) {
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
