/* Spirit Tracker service worker. Classic script, self-contained, no imports.
 *
 * BUILD and FILES are placeholders filled at deploy by tools/stamp_pwa.js (pages.yaml).
 * BUILD is a hash of the shell files, NOT the commit: Pages redeploys on every scrape
 * (~8x/day) and a commit-keyed BUILD would rotate the shell on every one of them.
 *
 * UNSTAMPED, this worker is a kill switch: it deletes its caches, unregisters, and reloads
 * its pages. That is what clears a stamped build tested earlier on localhost (its cached
 * pwa.js keeps registering sw.js, which now arrives unstamped), and a deploy that skips the
 * stamp step uninstalls the PWA everywhere instead of serving a stale shell forever.
 *
 * Every path is relative to the registration scope.
 */

const BUILD = '__BUILD__';
const FILES = [/*__FILES__*/];
// Split so the stamp step, which replaces the placeholder exactly once, leaves this alone.
const UNSTAMPED = BUILD === '__' + 'BUILD__';

const SHELL = `shell-${BUILD}`;
const DATA = 'data-v1';
const SKUS = 'skus-v1';
const CDN = 'cdn-v1';
const MINE = new Set([SHELL, DATA, SKUS, CDN]);
// Only caches this worker made are ever deleted; the page keeps its own (api.js stviz:raw:v1).
const OURS = /^(shell|data|skus|cdn)-/;

/* Per-SKU history files are ~2-10 KB each and there are ~13k of them, so only the ones
 * actually opened are kept. Their own cache, so FIFO eviction can never drop index.json. */
const SKU_CAP = 3000;

/* How long a data request may wait for response HEADERS before the cached copy answers.
 * Headers, not the body: a slow 16 MB download on a live connection is not a dead one.
 * The late response still lands in the cache, and pwa.js's ETag check reloads onto it. */
const DATA_TIMEOUT_MS = 8000;

const CDN_HOSTS = new Set(['cdn.jsdelivr.net', 'cdnjs.cloudflare.com']);

const scopePath = new URL(self.registration.scope).pathname;
const DATA_PREFIX = `${scopePath}data/`;
const SKUS_PREFIX = `${scopePath}data/skus/`;

self.addEventListener('install', (e) => {
  if (UNSTAMPED) {
    self.skipWaiting();
    return;
  }
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    /* `?v=BUILD` makes every URL new to the CDN. `cache: 'reload'` only skips the browser's
     * HTTP cache; Pages' CDN keeps the previous deploy for up to 10 minutes, and an old file
     * precached here would be served for the whole life of this build. Stored under the
     * clean URL, which is what the page requests. */
    await Promise.all(FILES.map(async (u) => {
      const res = await fetch(`${u}?v=${BUILD}`, { cache: 'reload' });
      if (res.status !== 200) throw new Error(`[sw] precache ${u}: HTTP ${res.status}`);
      await cache.put(u, res);
    }));
  })());
  // Deliberately NO skipWaiting() here. Swapping ES module versions under a running page
  // yields half-old-half-new state. pwa.js asks for the swap at launch, on resume, or on a tap.
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (OURS.test(name) && (UNSTAMPED || !MINE.has(name))) await caches.delete(name);
    }
    if (UNSTAMPED) {
      await self.registration.unregister();
      for (const c of await self.clients.matchAll({ type: 'window' })) c.navigate(c.url);
      return;
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

/* Data is NETWORK FIRST, always. The cache only ever answers when the network cannot: a
 * thrown fetch (offline), a 5xx, or no headers within DATA_TIMEOUT_MS. Never
 * stale-while-revalidate: that shows last launch's prices as if they were current.
 *
 * `no-cache`, not `no-store`: every request revalidates with Pages, which answers 304 when
 * the file is unchanged, so the data is never older than the server's.
 *
 * A cached answer carries `x-st-offline: 1`, which pwa.js turns into the offline bar, and
 * `x-st-saved-at`, when the copy was last confirmed current. (Not Last-Modified: an
 * unchanged sku history file keeps a months-old date while being current.) */
async function networkFirst(e, req, cacheName, cap) {
  const cache = await caches.open(cacheName);
  const network = fetch(new Request(req, { cache: 'no-cache' })).then((res) => {
    if (res.status === 200) {
      const headers = new Headers(res.headers);
      headers.set('x-st-saved-at', String(Date.now()));
      const copy = new Response(res.clone().body, { status: 200, statusText: res.statusText, headers });
      // waitUntil, or the worker may be stopped before a 16 MB index.json finishes writing.
      e.waitUntil(cache.put(req.url, copy).then(async () => {
        if (cap === null) return;
        const keys = await cache.keys(); // insertion order, so this is FIFO
        for (let i = 0; i < keys.length - cap; i++) await cache.delete(keys[i]);
      }));
    }
    return res;
  });
  const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), DATA_TIMEOUT_MS));

  let res = null;
  try {
    const first = await Promise.race([network, timeout]);
    if (first !== 'timeout') res = first;
    else e.waitUntil(network.catch(() => {})); // the late answer still refreshes the cache
  } catch { /* offline: fall through to the cache */ }

  if (res !== null && res.status === 200) return res;
  // A 404 is a real answer, and serving a cached copy over it would hide a broken deploy.
  if (res !== null && res.status < 500) return res;

  const hit = await cache.match(req.url);
  if (hit === undefined) return res ?? network;
  const headers = new Headers(hit.headers);
  headers.set('x-st-offline', '1');
  return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers });
}

self.addEventListener('fetch', (e) => {
  if (UNSTAMPED) return;
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      /* THE CACHED SHELL WINS. Modules are served cache-first from `shell-<BUILD>`, so a
       * network-first navigation would hand the browser a FRESH index.html alongside the
       * PREVIOUS build's JavaScript. HTML and modules swap together when the new worker
       * activates (pwa.js does that at launch and on resume). Data is unaffected: it is
       * network-first whichever shell is running. */
      const hit = await (await caches.open(SHELL)).match('./index.html');
      return hit ?? fetch(req);
    })());
    return;
  }

  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith(SKUS_PREFIX)) {
      e.respondWith(networkFirst(e, req, SKUS, SKU_CAP));
      return;
    }
    if (url.pathname.startsWith(DATA_PREFIX)) {
      e.respondWith(networkFirst(e, req, DATA, null));
      return;
    }
    // The local-dev write API (viz/serve.js) must never be cached.
    if (url.pathname.startsWith('/__stviz/')) return;
    // Shell: cache-first. Never caches a non-200, since a cached 404 lives as long as the build.
    e.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const hit = await cache.match(req);
      if (hit !== undefined) return hit;
      const res = await fetch(req);
      if (res.status === 200 && res.type !== 'opaque') await cache.put(req, res.clone());
      return res;
    })());
    return;
  }

  /* CDN libraries (Chart.js, Font Awesome + its webfonts, SweetAlert2): served from cache so
   * the app opens offline, refreshed behind the scenes. The tags in index.html carry
   * `crossorigin`, which makes these CORS responses; an opaque one is padded to megabytes of
   * quota and is never cached here. */
  if (CDN_HOSTS.has(url.hostname)) {
    e.respondWith((async () => {
      const cache = await caches.open(CDN);
      const hit = await cache.match(req);
      const refresh = fetch(req).then(async (res) => {
        if (res.status === 200 && res.type === 'cors') await cache.put(req, res.clone());
        return res;
      });
      if (hit === undefined) return refresh;
      // NOT waitUntil: a pending extended event makes a waiting worker's activation wait for
      // it, so a slow CDN would delay every code update. The refresh is best-effort.
      refresh.catch((err) => console.warn('[sw] cdn refresh failed:', req.url, err));
      return hit;
    })());
  }
  // Everything else cross-origin (the accounts API, GitHub, store product images) goes
  // straight to the network. The accounts API keeps its own offline copy in cloud.js.
});
