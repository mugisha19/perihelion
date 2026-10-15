'use strict';

// Service worker: makes the game load instantly and play offline once visited.
// Bump VERSION whenever any file in site/ changes so installed copies pick up the update.
const VERSION = 'v1';
const CACHE = `perihelion-${VERSION}`;

const PRECACHE = [
  './',
  'index.html',
  'style.css',
  'game.js',
  'pwa.js',
  'favicon.svg',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // `reload` skips the HTTP cache so a fresh install never stores a stale copy.
    await cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith('perihelion-') && n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req));
  } else {
    event.respondWith(staleWhileRevalidate(req));
  }
});

// Pages: try the network so updates show up quickly, fall back to the cached shell when offline.
async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put('index.html', res.clone());
    return res;
  } catch {
    return (await cache.match('index.html')) || Response.error();
  }
}

// Assets: serve the cached copy immediately and refresh it in the background.
async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req, { ignoreSearch: true });
  const refresh = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  if (cached) return cached;
  return (await refresh) || Response.error();
}
