/**
 * Marquee service worker — Phase 5 Step 6, step 2 of docs/phase-5-pwa-design.md §10.
 *
 * ============================================================================
 * THE ONE RULE — read this before adding anything to a cache
 * ============================================================================
 * **Only responses that are byte-identical for EVERY user may be cached.**
 *
 * Cache Storage is origin-scoped, not user-scoped. On a shared device Alice's
 * cache IS Bob's cache, and signing out does not partition it. "Identical for
 * everyone" is therefore the only property that makes this safe structurally
 * rather than by remembering to be careful.
 *
 * That line is drawn by the BUILD, not by judgement: `next build` prints
 * `○ (Static)` vs `ƒ (Dynamic)`, and a statically prerendered route is by
 * definition the same bytes for every visitor. CACHEABLE_ROUTES below is
 * exactly the `○` set. A route that is not in it is never written to any
 * cache, on any code path.
 *
 * The sharpest case: `/title/[mediaType]/[id]` is `ƒ` and renders
 * CommentSection, whose visibility is gated per reader against that reader's
 * own synced watch history. Caching it would serve one account's spoiler
 * gating to the next person on the device. It is excluded by being absent
 * from the list, with no special case needed.
 *
 * See docs/phase-5-pwa-design.md §1 and §2.
 */

/**
 * Supplied by the registration URL (`/sw.js?v=<build id>`), which is what
 * makes a deploy produce a byte-different worker URL and therefore an
 * update. Read from `self.location` because a service worker's own location
 * retains the query string it was registered with.
 */
const VERSION = new URL(self.location.href).searchParams.get("v") || "dev";

/**
 * Shell and static caches are versioned per build and thrown away on
 * activate; API and image caches deliberately are NOT.
 *
 * The reason is what the contents are coupled to. Route HTML and
 * `/_next/static/**` are build artifacts — a new build makes the old ones
 * meaningless. Poster images and TMDB responses are CONTENT: they are just as
 * valid after a deploy as before it, and versioning them would silently
 * re-download a user's entire poster cache on every release for no benefit.
 */
const SHELL_CACHE = `marquee-shell-${VERSION}`;
const STATIC_CACHE = `marquee-static-${VERSION}`;
const API_CACHE = "marquee-api-v1";
const IMAGE_CACHE = "marquee-image-v1";

/**
 * Bounds are a DATA-SAFETY measure, not tidiness — see design doc §8.
 * Browsers evict per ORIGIN under quota pressure, and this app keeps the
 * user's entire watch history in localStorage. An unbounded poster cache can
 * push the origin over quota and get that history evicted, which would be a
 * spectacular way for an offline-convenience feature to destroy real data.
 * Do not raise these for a smoother scroll.
 */
const IMAGE_CACHE_LIMIT = 60;
const API_CACHE_LIMIT = 150;

/* ---------------------------------------------------------------------------
 * The allowlist
 *
 * Kept as a plain literal array between these markers so the guard test in
 * step 4 can parse it out of this file and assert it still equals the real
 * `○ (Static)` set from `next build`. Do not make it computed.
 * ------------------------------------------------------------------------ */

/* BEGIN CACHEABLE_ROUTES */
const CACHEABLE_ROUTES = [
  "/",
  "/search",
  "/library",
  "/schedule",
  "/import",
  "/profile/stats",
  "/forgot-password",
  "/offline",
];
/* END CACHEABLE_ROUTES */

/**
 * Routes actually fetched during install. A subset of the above: everything
 * here is useful with no network. `/forgot-password` is cacheable (it is
 * static, so it is safe) but is not precached — you cannot reset a password
 * offline, so spending install bandwidth on it buys nothing.
 */
const PRECACHE_ROUTES = [
  "/",
  "/library",
  "/schedule",
  "/search",
  "/offline",
];

const CACHEABLE = new Set(CACHEABLE_ROUTES);

/**
 * EXACT match, never a prefix match.
 *
 * A prefix check is the specific shape this bug takes: `/profile/stats` is
 * static and cacheable, `/profile` is dynamic and renders the signed-in
 * AccountCard. `pathname.startsWith("/profile")` would happily cache the
 * account page. Set membership cannot make that mistake.
 */
function isCacheableRoute(pathname) {
  return CACHEABLE.has(normalizePath(pathname));
}

/** Strips a trailing slash and any query/hash, so `/library?x=1` and
 *  `/library/` share the one cache entry `/library`. None of the cacheable
 *  routes vary by search params — they are static shells that read local
 *  storage on the client. */
function normalizePath(pathname) {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname;
}

/* ---------------------------------------------------------------------------
 * Install — precache the shell
 * ------------------------------------------------------------------------ */

self.addEventListener("install", (event) => {
  event.waitUntil(precache());
});

/**
 * Fetches the precacheable route documents, then scrapes them for their own
 * `/_next/static/` references and caches those too.
 *
 * The scrape is what makes an offline COLD start work on the very first
 * visit rather than the second: runtime caching alone has nothing cached
 * until something has already been requested. The HTML literally lists its
 * own scripts and stylesheets, so this needs no build manifest and no
 * coupling to `.next/` internals — which matters, because Turbopack is free
 * to reorganize those and a postbuild script reading them would break
 * silently when it did.
 *
 * Every step is best-effort. A failed precache must not fail the install:
 * degrading to runtime caching costs a visit's worth of offline capability,
 * whereas a rejected install leaves the user with no worker at all.
 *
 * `self.skipWaiting()` is deliberately NOT called — see the note on activate.
 */
async function precache() {
  const shell = await caches.open(SHELL_CACHE);
  const assets = new Set();

  await Promise.all(
    PRECACHE_ROUTES.map(async (route) => {
      try {
        // `cache: "reload"` bypasses the HTTP cache, so install can never
        // precache a stale copy the browser happened to be holding.
        const response = await fetch(route, { cache: "reload" });
        if (!response.ok || response.redirected) return;
        const body = await response.clone().text();
        await shell.put(route, response);
        for (const asset of extractStaticAssets(body)) assets.add(asset);
      } catch {
        /* best effort */
      }
    }),
  );

  if (assets.size === 0) return;

  const staticCache = await caches.open(STATIC_CACHE);
  await Promise.all(
    [...assets].map(async (url) => {
      try {
        const response = await fetch(url, { cache: "reload" });
        if (response.ok) await staticCache.put(url, response);
      } catch {
        /* best effort */
      }
    }),
  );
}

/**
 * Re-runs the precache if the shell cache has gone missing, at most once per
 * worker startup.
 *
 * ============================================================================
 * WHY THIS IS NEEDED — `install` DOES NOT RUN AGAIN
 * ============================================================================
 * `install` fires once per worker VERSION. An already-installed worker that
 * loses its caches never rebuilds them, and simply carries on serving with
 * nothing cached — offline silently stops working until the next deploy.
 *
 * That is not hypothetical, and it is not just something a developer does in
 * devtools: it is precisely what browser storage eviction under quota
 * pressure produces, which is the scenario the cache bounds above exist to
 * manage in the first place (design doc §8). Discovered while verifying this
 * step, by deleting the caches out from under a live worker and finding it
 * never recovered.
 *
 * Most of the cache self-heals already without this — navigations re-cache
 * allowlisted routes on every visit, and `/_next/static/**` is cache-first so
 * a miss refetches. The real gap is documents the user has not visited this
 * session, `/offline` above all: the one entry that is only ever needed at
 * the moment the network is gone and cannot be fetched on demand then.
 *
 * So `/offline` is the sentinel. Cheap (one `match` per worker startup),
 * never blocks a response, and failure is swallowed — a heal that cannot run
 * must not take the request down with it.
 */
let healing = null;
function ensureShellPrecached() {
  if (!healing) {
    healing = (async () => {
      const cache = await caches.open(SHELL_CACHE);
      if (await cache.match("/offline")) return;
      await precache();
    })().catch(() => {
      // Reset so a later navigation can retry rather than being stuck with a
      // permanently rejected promise for the life of the worker.
      healing = null;
    });
  }
  return healing;
}

/** Deliberately narrow: an explicit extension allowlist rather than "anything
 *  after /_next/static/", so a truncated or JSON-escaped match can't turn
 *  into a garbage request. Turbopack chunk names contain `[`, `]` and `%`. */
function extractStaticAssets(html) {
  const found = new Set();
  const pattern = /\/_next\/static\/[A-Za-z0-9._@%/[\]-]+?\.(?:js|css|woff2?)/g;
  let match;
  while ((match = pattern.exec(html)) !== null) found.add(match[0]);
  return found;
}

/* ---------------------------------------------------------------------------
 * Activate — drop superseded caches
 * ------------------------------------------------------------------------ */

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const expected = new Set([SHELL_CACHE, STATIC_CACHE, API_CACHE, IMAGE_CACHE]);
      const names = await caches.keys();
      await Promise.all(
        names
          // Scoped to our own prefix so this can never delete a cache some
          // other tool on the origin owns.
          .filter((name) => name.startsWith("marquee-") && !expected.has(name))
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

/**
 * Applied only when the page asks, never on install.
 *
 * Automatic `skipWaiting()` swaps the worker under a running page, and that
 * page's already-loaded JS references build-hashed chunk URLs the new build
 * no longer serves — producing chunk-load errors mid-session. So a new worker
 * installs and WAITS; the app surfaces it and posts this message only when
 * the user accepts, immediately before reloading. See design doc §4.
 */
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

/* ---------------------------------------------------------------------------
 * Fetch
 * ------------------------------------------------------------------------ */

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Non-GET is never cached and never intercepted: Server Actions, the
  // import resolver, and every Supabase mutation are POSTs.
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Cross-origin is passed straight through, untouched — Supabase auth and
  // PostgREST are the ones that matter here. Not caching them is the point;
  // not even observing them keeps the CSP surface and the failure modes small.
  if (url.origin !== self.location.origin) return;

  // Build-hashed and therefore immutable: the filename changes when the bytes
  // do, so a stale entry is impossible by construction.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(event, STATIC_CACHE, null));
    return;
  }

  // Optimized TMDB posters. Content, not personal.
  if (url.pathname === "/_next/image") {
    event.respondWith(cacheFirst(event, IMAGE_CACHE, IMAGE_CACHE_LIMIT));
    return;
  }

  // A pure content proxy over TMDB/mock: no auth, no session read, no
  // per-user variation. That assumption is what makes this cacheable at all,
  // and it is asserted by a test rather than trusted to this comment — see
  // design doc §7.2.
  if (url.pathname.startsWith("/api/content/")) {
    event.respondWith(staleWhileRevalidate(event, API_CACHE, API_CACHE_LIMIT));
    return;
  }

  if (request.mode === "navigate") {
    // Kept off the response path deliberately: this must never delay a
    // navigation, only run alongside it.
    event.waitUntil(ensureShellPrecached());
    event.respondWith(handleNavigation(event, url));
    return;
  }

  // Everything else — including App Router RSC payload requests
  // (`?_rsc=…`) — falls through to the network untouched.
  //
  // RSC payloads are deliberately not cached even for static routes. They
  // vary on the `RSC` and `Next-Router-State-Tree` request headers, so
  // caching them correctly means hand-rolling `Vary` handling, and getting
  // that subtly wrong on a route family that includes dynamic pages is
  // precisely the silent leak this file is organized to prevent. The cost of
  // skipping them is small: offline, Next's RSC fetch fails and it falls back
  // to a full browser navigation, which IS served from the shell cache below.
});

/**
 * Network-first, cache as fallback.
 *
 * Network-first rather than cache-first specifically so a stale worker can
 * never pin an online user to an old page — the cache is purely the offline
 * path. Non-cacheable routes still get the `/offline` fallback; they are just
 * never written.
 */
async function handleNavigation(event, url) {
  const cacheable = isCacheableRoute(url.pathname);
  const key = normalizePath(url.pathname);

  try {
    const response = await fetch(event.request);
    // `redirected` matters: a cached redirect replayed into a navigation is
    // rejected by the browser. `/account` 307s to `/signin` when signed out,
    // and while that route is not cacheable anyway, guarding here means the
    // rule holds if the allowlist ever changes.
    if (cacheable && response.ok && !response.redirected) {
      const clone = response.clone();
      event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.put(key, clone)));
    }
    return response;
  } catch {
    if (cacheable) {
      const cached = await caches.match(key);
      if (cached) return cached;
    }
    const offline = await caches.match("/offline");
    if (offline) return offline;
    return new Response("You are offline.", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
}

async function cacheFirst(event, cacheName, limit) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(event.request);
  if (cached) return cached;

  try {
    const response = await fetch(event.request);
    if (response.ok && !response.redirected) {
      const clone = response.clone();
      event.waitUntil(
        cache.put(event.request, clone).then(() => (limit ? trim(cacheName, limit) : undefined)),
      );
    }
    return response;
  } catch {
    return Response.error();
  }
}

async function staleWhileRevalidate(event, cacheName, limit) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(event.request);

  const network = fetch(event.request)
    .then(async (response) => {
      if (response.ok && !response.redirected) {
        await cache.put(event.request, response.clone());
        await trim(cacheName, limit);
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    event.waitUntil(network);
    return cached;
  }

  const fresh = await network;
  // No cache and no network: fail exactly as we would with no worker
  // installed, so `httpProvider`'s existing error handling sees the same
  // thing it already knows how to report rather than a synthetic status.
  return fresh || Response.error();
}

/**
 * FIFO eviction, not true LRU — stated plainly because the design doc called
 * it an LRU and it is not one. `cache.keys()` returns insertion order, so
 * this drops the oldest-WRITTEN entries. True LRU would mean re-putting an
 * entry on every read to move it to the end, doubling writes on every cache
 * hit to better order a bound that exists only to stop unbounded growth.
 * Not worth it; the bound is what matters, not which entry loses.
 */
async function trim(cacheName, limit) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= limit) return;
  await Promise.all(keys.slice(0, keys.length - limit).map((key) => cache.delete(key)));
}
