'use strict';

// Service worker: makes the game load instantly and play offline once visited.
// Bump VERSION whenever any file in site/ changes so installed copies pick up the update.
const VERSION = 'v5';
const CACHE = `perihelion-${VERSION}`;
const NETWORK_TIMEOUT_MS = 3000; // on a slow connection, fall back to the cached copy after this long

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

  // Every page load is stored under one key so any start URL (with or without a query) works offline.
  event.respondWith(networkFirst(req, req.mode === 'navigate' ? 'index.html' : req));
});

// Network first, so players always get the newest files and never a stale script paired with new
// markup. The cache is the fallback when offline or when the network is slower than the timeout.
async function networkFirst(req, key) {
  const cache = await caches.open(CACHE);
  const network = fetch(req).then((res) => {
    if (res.ok) cache.put(key, res.clone());
    return res;
  });
  network.catch(() => { /* handled below, or irrelevant once a cached copy was served */ });

  const timeout = new Promise((_, reject) => setTimeout(reject, NETWORK_TIMEOUT_MS));
  try {
    return await Promise.race([network, timeout]);
  } catch {
    const cached = await cache.match(key, { ignoreSearch: true });
    if (cached) return cached;
    return network.catch(() => Response.error());
  }
}
