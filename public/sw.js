const BUILD_ID = 'development';
const APP_ASSETS = [];
const SCOPE = new URL(self.registration.scope);
const CACHE_PREFIX = `custom-loxone-app:${SCOPE.pathname}:`;
const CACHE_NAME = CACHE_PREFIX + BUILD_ID;
const INDEX = new URL('./index.html', SCOPE);
const SHELL = new URL(`./shell-${BUILD_ID}.html`, SCOPE);
const SHELL_URLS = new Set(APP_ASSETS.map((path) => new URL(path, SCOPE).href));

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      await cache.addAll(
        Array.from(SHELL_URLS, (url) => new Request(url, { cache: 'reload', redirect: 'error' })),
      );
    } catch (error) {
      await caches.delete(CACHE_NAME);
      throw error;
    }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
        .map((key) => caches.delete(key)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'APPLY_UPDATE' ||
      !event.source || !event.source.url || !isInAppScope(event.source.url) || !event.ports[0]) {
    return;
  }
  event.waitUntil(applyUpdate(event.source, event.ports[0]));
});

async function applyUpdate(source, reply) {
  try {
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const otherTab = tabs.some((tab) => tab.id !== source.id && isInAppScope(tab.url));
    if (otherTab) {
      reply.postMessage('close-other-tabs');
      return;
    }
    // Normal activation waits for old pages. Only the requesting page reloads.
    await self.skipWaiting();
    reply.postMessage('accepted');
  } catch {
    reply.postMessage('unavailable');
  }
}

function isInAppScope(href) {
  const url = new URL(href);
  return url.origin === SCOPE.origin && url.pathname.startsWith(SCOPE.pathname);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== SCOPE.origin) return;

  if (
    request.mode === 'navigate' &&
    (url.pathname === SCOPE.pathname || url.pathname === INDEX.pathname)
  ) {
    event.respondWith(readShell(SHELL.href, request));
  } else if (SHELL_URLS.has(url.href)) {
    event.respondWith(readShell(request, request));
  }
});

async function readShell(cacheKey, request) {
  try {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  } catch {
    // A browser can evict or disable CacheStorage.
  }
  return fetch(request);
}
