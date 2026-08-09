"use client";

import { useEffect } from "react";

/**
 * Registers the service worker. Renders nothing.
 *
 * Step 2 of docs/phase-5-pwa-design.md §10 — registration only. Detecting a
 * waiting worker and offering the reload is step 3; until that lands, an
 * update applies once every tab for the origin has been closed, which is the
 * browser's own default behaviour rather than a broken state.
 *
 * ============================================================================
 * BOTH HALVES OF THE UPDATE GUARD LIVE HERE AND IN next.config.ts
 * ============================================================================
 * `updateViaCache: "none"` stops the BROWSER's HTTP cache from being consulted
 * for the worker script itself, and the `Cache-Control: no-cache` header on
 * `/sw.js` (next.config.ts) stops anything in front of us from holding a copy.
 * Either one alone is insufficient: with only the header a browser may still
 * reuse a cached script per its own worker-update rules, and with only the
 * option a CDN can still hand back a day-old file. Miss both and a stale
 * worker can be served indefinitely with no recovery path from inside the app.
 *
 * The `?v=` parameter is what actually makes a deploy produce a NEW worker:
 * the browser compares the registered script URL and its bytes, so a build id
 * in the URL guarantees a fresh install even if the file itself is unchanged.
 * `sw.js` reads it back out of `self.location` to name its caches.
 */

const SW_URL = `/sw.js?v=${process.env.NEXT_PUBLIC_SW_VERSION ?? "dev"}`;

/**
 * Registered in production builds only, by default.
 *
 * This deliberately differs from the rate limiter, which CLAUDE.md argues
 * should run in development precisely so its bugs are not found in
 * production. The difference is that a service worker actively breaks the
 * development loop: it would cache Turbopack's dev assets and sit in front of
 * HMR, and `/_next/static/**` is not build-hashed the same way in dev, so the
 * cache-first rule that is safe in production is wrong there.
 *
 * The spirit of that rule is still met, because the worker IS exercised
 * locally before deploy — `npm run build && npm start` is a production build
 * on localhost, which is a secure context and registers normally. Set
 * `NEXT_PUBLIC_SW_IN_DEV=1` to force registration under `next dev` when
 * specifically debugging the worker; expect HMR to misbehave while it is on.
 */
const ENABLED =
  process.env.NODE_ENV === "production" || process.env.NEXT_PUBLIC_SW_IN_DEV === "1";

export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!ENABLED) return;
    if (!("serviceWorker" in navigator)) return;

    let cancelled = false;

    // Registration competes with the page's own resource loading, and the
    // install handler immediately fetches several documents plus their
    // assets. Deferring to `load` keeps that off the critical path of the
    // first paint, which is the one visit where the worker provides nothing.
    const register = () => {
      if (cancelled) return;
      navigator.serviceWorker.register(SW_URL, { scope: "/", updateViaCache: "none" }).catch(
        (error) => {
          // Registration failing is not a broken app — every feature works
          // without a worker. Log and move on rather than surfacing it.
          console.warn("[marquee] service worker registration failed", error);
        },
      );
    };

    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });

    return () => {
      cancelled = true;
      window.removeEventListener("load", register);
    };
  }, []);

  return null;
}
