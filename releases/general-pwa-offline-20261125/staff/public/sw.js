const CACHE_PREFIX = 'coffee-bond-pos-static';
const CACHE_VERSION = 'v3-safe-drafts';
const STATIC_CACHE = `${CACHE_PREFIX}-${CACHE_VERSION}`;
// Both manifests are shell assets: the staff app and the customer ordering app are
// two separate installable identities served from this origin.
const BUILD_ASSETS = (self.__WB_MANIFEST || []).map(entry => '/' + (typeof entry === 'string' ? entry : entry.url).replace(/^\//, ''));
const APP_SHELL = [...new Set([...BUILD_ASSETS, '/', '/index.html', '/offline.html', '/manifest.webmanifest', '/manifest-customer.webmanifest', '/pwa/icon-192.png', '/pwa/icon-512.png', '/pwa/icon-maskable-512.png', '/pwa/apple-touch-icon.png'])];
const STATIC_EXTENSION = /\.(?:webmanifest|css|js|mjs|png|jpg|jpeg|webp|svg|ico|woff|woff2)$/i;
const CUSTOMER_ORDER_DESTINATION = 'https://order.coffeebond.in/';

function customerOrderRedirect(url) {
  if (url.origin !== self.location.origin || (url.pathname !== '/order' && url.pathname !== '/order/')) return null;
  const destination = new URL(CUSTOMER_ORDER_DESTINATION);
  destination.search = url.search;
  return destination.href;
}

self.addEventListener('install', (event) => {
  // A waiting update never takes over an active till automatically.
  event.waitUntil(caches.open(STATIC_CACHE).then(async cache=>{
    await cache.addAll(APP_SHELL);
    const html=await (await cache.match('/index.html')).text();
    const assets=[...html.matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/g)].map(m=>m[1]);
    await cache.addAll(assets);
  }));
});
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
// Every open client must explicitly report a safe state. Older/unresponsive clients
// block takeover; closing them permits normal service-worker activation.
// A signed operation can outlive its tab, login and app version. Check the
// installed journal before every explicit takeover, including a closed till.
async function journalAllowsUpdate() {
  return new Promise(resolve=>{
    let request;
    try {request=indexedDB.open('coffee-bond-offline-cash-v1');} catch {resolve(false);return;}
    request.onblocked=request.onerror=()=>resolve(false);
    request.onupgradeneeded=event=>{
      // An absent journal has no guarded entries. Do not create its schema here.
      request.transaction.abort();resolve(event.oldVersion===0);
    };
    request.onsuccess=()=>{
      const db=request.result;
      if(!db.objectStoreNames.contains('entries')){db.close();resolve(false);return;}
      const tx=db.transaction('entries','readonly'),cursor=tx.objectStore('entries').openCursor();
      let clear=true;
      cursor.onsuccess=()=>{
        const row=cursor.result;
        if(row && row.value.status!=='SYNCED'){clear=false;return;}
        if(row)row.continue();
      };
      tx.oncomplete=()=>{db.close();resolve(clear);};
      tx.onabort=tx.onerror=()=>{db.close();resolve(false);};
    };
  });
}
const approvals=new Map();
self.addEventListener('message',event=>{
  if(event.data?.type==='UPDATE_SAFETY_REPLY'){
    const pending=approvals.get(event.data.id);
    if(pending&&pending.ids.has(event.source?.id)){pending.ids.delete(event.source.id);pending.safe=pending.safe&&event.data.safe===true;if(!pending.ids.size)pending.done(pending.safe)}
  }
  if(event.data?.type==='SKIP_WAITING')event.waitUntil((async()=>{
    const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    if(!await journalAllowsUpdate())return;
    if(!clients.length)return self.skipWaiting();
    const id=crypto.randomUUID();
    const safe=await new Promise(resolve=>{
      const timer=setTimeout(()=>{approvals.delete(id);resolve(false)},2000);
      approvals.set(id,{ids:new Set(clients.map(c=>c.id)),safe:true,done:value=>{clearTimeout(timer);approvals.delete(id);resolve(value)}});
      clients.forEach(c=>c.postMessage({type:'UPDATE_SAFETY_QUERY',id}));
    });
    if(safe && await journalAllowsUpdate())await self.skipWaiting();
  })());
});

// Cache only published menu photographs, never Storage metadata, private
// documents, authenticated API responses or a general Firebase URL pattern.
const MENU_IMAGE_CACHE = 'coffee-bond-pos-menu-images-v1';
const MENU_IMAGE_LIMIT = 100;
const MENU_IMAGE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const MENU_IMAGE_CACHED_AT = 'x-coffee-bond-image-cached-at';
const MENU_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
let imageCacheWrites = Promise.resolve();

function isPublicMenuImage(request, url) {
  if (request.method !== 'GET' || request.destination !== 'image') return false;
  if (url.protocol !== 'https:' || url.hostname !== 'firebasestorage.googleapis.com' || url.port) return false;
  const prefix = '/v0/b/coffee-bond-pos.firebasestorage.app/o/';
  if (!url.pathname.startsWith(prefix) || url.searchParams.get('alt') !== 'media') return false;
  try {
    const objectPath = decodeURIComponent(url.pathname.slice(prefix.length));
    return objectPath.startsWith('menu-images/') && /\.(?:jpe?g|png|webp)$/i.test(objectPath);
  } catch { return false; }
}

function isCacheableMenuImage(response) {
  const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const cacheControl = response.headers.get('cache-control') || '';
  return response.status === 200 && !response.redirected && response.type !== 'opaque'
    && MENU_IMAGE_TYPES.has(contentType) && !/\b(?:private|no-store)\b/i.test(cacheControl);
}

function storeMenuImage(cache, request, response) {
  imageCacheWrites = imageCacheWrites.catch(() => {}).then(async () => {
    const headers = new Headers(response.headers);
    headers.set(MENU_IMAGE_CACHED_AT, String(Date.now()));
    await cache.put(request, new Response(response.body, { status: 200, headers }));
    const keys = await cache.keys();
    for (const oldKey of keys.slice(0, Math.max(0, keys.length - MENU_IMAGE_LIMIT))) {
      await cache.delete(oldKey);
    }
  });
  return imageCacheWrites;
}

async function menuImageResponse(request, event) {
  let cache;
  try {
    cache = await caches.open(MENU_IMAGE_CACHE);
    const cached = await cache.match(request);
    if (cached) {
      const cachedAt = Number(cached.headers.get(MENU_IMAGE_CACHED_AT));
      const age = Date.now() - cachedAt;
      if (cachedAt > 0 && age >= 0 && age <= MENU_IMAGE_MAX_AGE && isCacheableMenuImage(cached)) return cached;
      await cache.delete(request);
    }
  } catch { /* Cache failure must not stop an online image from displaying. */ }
  // Download URLs are public. CORS makes type/status inspectable; an opaque
  // fallback can display online, but is deliberately never persisted.
  const response = await fetch(new Request(request, { mode: 'cors', credentials: 'omit' }))
    .catch(() => fetch(request));
  if (cache && isCacheableMenuImage(response)) {
    event.waitUntil(storeMenuImage(cache, request, response.clone()).catch(() => {}));
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (isPublicMenuImage(request, url)) {
    event.respondWith(menuImageResponse(request, event));
    return;
  }
  if (url.origin !== self.location.origin || url.pathname.startsWith('/__/')) return;

  if (request.mode === 'navigate') {
    const destination = customerOrderRedirect(url);
    if (destination) {
      event.respondWith(Promise.resolve(Response.redirect(destination, 302)));
      return;
    }
    event.respondWith(
      fetch(request)
        .then((response) => response.ok ? response : Promise.reject(new Error('Navigation failed')))
        .catch(async () => {
          const cache = await caches.open(STATIC_CACHE);
          return (await cache.match('/index.html')) || (await cache.match('/offline.html')) || Response.error();
        }),
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
