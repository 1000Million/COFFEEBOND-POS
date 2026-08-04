const CACHE_PREFIX = 'coffee-bond-pos-static';
const CACHE_VERSION = 'v2';
const STATIC_CACHE = `${CACHE_PREFIX}-${CACHE_VERSION}`;
// Both manifests are shell assets: the staff app and the customer ordering app are
// two separate installable identities served from this origin.
const APP_SHELL = ['/', '/index.html', '/offline.html', '/manifest.webmanifest', '/manifest-customer.webmanifest', '/pwa/icon-192.png', '/pwa/icon-512.png', '/pwa/icon-maskable-512.png', '/pwa/apple-touch-icon.png'];
const STATIC_EXTENSION = /\.(?:css|js|mjs|png|jpg|jpeg|webp|svg|ico|woff|woff2)$/i;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(STATIC_CACHE).then((cache) => cache.addAll(APP_SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith(CACHE_PREFIX) && key !== STATIC_CACHE)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/__/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => response.ok ? response : Promise.reject(new Error('Navigation failed')))
        .catch(async () => (await caches.match('/index.html')) || caches.match('/offline.html')),
    );
    return;
  }

  if (!url.pathname.startsWith('/assets/') && !url.pathname.startsWith('/pwa/') && !STATIC_EXTENSION.test(url.pathname)) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;

      return fetch(request).then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          void caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
