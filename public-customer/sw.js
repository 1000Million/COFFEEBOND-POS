/**
 * Coffee Bond customer ordering service worker (order origin only).
 *
 * Deliberately conservative. It caches versioned static assets and the app shell so
 * the ordering app opens fast on a poor mobile connection, and nothing else.
 *
 * It never caches Firebase, Authentication, OTP, Cloud Functions, checkout sessions,
 * Razorpay, customer profiles, order status, My Orders, payments, onlineOrders or
 * tracking responses: every one of those is cross-origin or non-GET and is skipped
 * before any cache is consulted. There is no background sync and no request replay,
 * so a checkout or payment can never be resubmitted by this worker. Offline, the
 * shell still renders and the basket survives in localStorage, but the application
 * itself blocks checkout because those calls require the network.
 *
 * Its cache namespace is distinct from the staff worker's, and the two run on
 * different origins so their caches can never collide.
 */
const CACHE_PREFIX = 'coffee-bond-order-static';
const CACHE_VERSION = 'v2';
const STATIC_CACHE = `${CACHE_PREFIX}-${CACHE_VERSION}`;
const APP_SHELL = ['/', '/index.html', '/offline.html', '/manifest.webmanifest', '/pwa/icon-192.png', '/pwa/icon-512.png', '/pwa/icon-maskable-512.png', '/pwa/apple-touch-icon.png'];
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
  // Only GET is ever considered: checkout, payment and profile writes are POSTs and
  // are handed straight to the network without interception.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Cross-origin requests (Firestore, Identity Toolkit, Cloud Functions, Razorpay)
  // are never inspected or cached.
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
