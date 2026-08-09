import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { discoverAppRoutes } from "./discover-routes";

/**
 * The service worker's route-classification guard — docs/phase-5-pwa-design.md
 * §7, Phase 5 Step 6 (4/4).
 *
 * Two DIFFERENT assertions, matching two DIFFERENT ways this could fail
 * silently:
 *
 *   1. A new route is added and nobody decides whether the worker may cache
 *      it — §7.1.
 *   2. A route already trusted as "safe to cache because it has no auth"
 *      quietly grows one — §7.2.
 *
 * Both are INVERTED the same way the Phase 7 Step 2 sync guard was: instead
 * of asserting a known-good state, they assert every discovered fact is
 * DECLARED somewhere a human had to write down on purpose. An unclassified
 * route, or an undeclared import, fails loudly instead of shipping silently.
 */

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SW_PATH = join(ROOT_DIR, "public", "sw.js");
const APP_DIR = join(ROOT_DIR, "app");
const API_CONTENT_DIR = join(ROOT_DIR, "app", "api", "content");

/**
 * Pulled out of public/sw.js's own CACHEABLE_ROUTES literal, between the
 * markers put there for exactly this — never hand-copied, so the test cannot
 * silently drift from what the worker actually does. A missing/empty result
 * fails loudly rather than passing on an accidentally-empty list.
 */
function parseCacheableRoutesFromServiceWorker(): string[] {
  const source = readFileSync(SW_PATH, "utf8");
  const block = /\/\* BEGIN CACHEABLE_ROUTES \*\/([\s\S]*?)\/\* END CACHEABLE_ROUTES \*\//.exec(
    source,
  );
  if (!block) {
    throw new Error(
      "Could not find the CACHEABLE_ROUTES markers in public/sw.js — " +
        "did the '/* BEGIN CACHEABLE_ROUTES */' / '/* END CACHEABLE_ROUTES */' " +
        "comments get renamed or removed? This guard parses them by design " +
        "(docs/phase-5-pwa-design.md §7.1) rather than duplicating the list.",
    );
  }
  const routes = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (routes.length === 0) {
    throw new Error("Parsed zero routes out of public/sw.js's CACHEABLE_ROUTES — the parser broke.");
  }
  return routes;
}

/**
 * `/api/content/**` is cached via a PREFIX check in the worker (`fetch`
 * handler in public/sw.js), not a literal list — every route under it is
 * cacheable by construction, on the strength of the §7.2 no-auth assumption
 * below. Kept as a constant here, not derived, so a rename of the directory
 * fails this test rather than silently changing what "content" means.
 */
const API_CONTENT_PREFIX = "/api/content/";

/**
 * Every OTHER route the worker will never write to any cache, under any
 * branch. Mirrors the SYNC_TABLES_BY_WRITE_KIND pattern in
 * lib/import/commit-sync.test.ts: a plain literal list living in the TEST,
 * not production code, that a new route must be added to on purpose.
 *
 * Each entry is commented with why it is NOT safe to cache, not just that it
 * isn't — the "why" is what stops someone "cleaning up" this list by moving
 * an entry into the cacheable side without re-deriving the reason it was
 * here.
 */
const NEVER_CACHED_ROUTES = [
  // Next's default 404 — content is fine to cache in principle, but it is
  // never reached via a normal navigation (notFound() renders it INLINE
  // within another route), so there is no navigation event that would ever
  // populate or read a cache entry for it. Cacheable in name only; excluding
  // it is the honest answer, not a missed opportunity.
  "/_not-found",
  // Renders the signed-in AccountCard.
  "/account",
  // A POST-only mutation endpoint; GETs are irrelevant here, but it sits
  // under /api/ and not /api/content/, so it must be named explicitly rather
  // than silently falling out of the prefix rule above.
  "/api/import/resolve",
  // OAuth/email-link return path — one-time, identity-bearing tokens in the
  // URL. Caching a REDIRECT here would be actively dangerous.
  "/auth/callback",
  // Lists are per-account and collaborator-gated.
  "/lists",
  "/lists/[id]",
  "/lists/new",
  // Static (no request-time API), but not a NAVIGATION — fetched as a
  // manifest resource, never `request.mode === "navigate"`. It is genuinely
  // side-effect-free to cache; it's just not one this guard's mechanism
  // (navigation caching) applies to. If the worker ever adds a branch for
  // non-navigation static assets, this belongs on the cacheable side of
  // THAT branch, not this one.
  "/manifest.webmanifest",
  // Renders the signed-in AccountCard, same as /account.
  "/profile",
  "/signin",
  "/signup",
  // Renders CommentSection, gated per reader against their own watch
  // history — see §1 of the design doc. The single most dangerous page in
  // this app to cache.
  "/title/[mediaType]/[id]",
];

describe("service worker route classification — every route must be declared", () => {
  const discovered = discoverAppRoutes();
  const cacheableExact = new Set(parseCacheableRoutesFromServiceWorker());
  const neverCached = new Set(NEVER_CACHED_ROUTES);

  function classify(route: string): "cacheable" | "api-content" | "never-cached" | "UNCLASSIFIED" {
    if (cacheableExact.has(route)) return "cacheable";
    if (route.startsWith(API_CONTENT_PREFIX)) return "api-content";
    if (neverCached.has(route)) return "never-cached";
    return "UNCLASSIFIED";
  }

  it("found a real, non-trivial set of routes to check (sanity check on discovery itself)", () => {
    // A silently-broken discoverAppRoutes (wrong APP_DIR, wrong filenames)
    // would make every assertion below vacuously true. This is the guard
    // for the guard.
    expect(discovered.length).toBeGreaterThan(20);
    expect(discovered).toContain("/");
    expect(discovered).toContain("/title/[mediaType]/[id]");
  });

  it("classifies every discovered route as cacheable, api-content, or never-cached", () => {
    const unclassified = discovered.filter((route) => classify(route) === "UNCLASSIFIED");
    expect(
      unclassified,
      `${unclassified.length} route(s) exist in app/ but are not declared ANYWHERE the ` +
        `service worker's caching rules can see — the default outcome for a new route ` +
        `must be "loud and unfinished", not "silently uncached" (which is safe) or ` +
        `"silently cached" (which might not be, if it turns out to be account-scoped). ` +
        `Add each one to CACHEABLE_ROUTES in public/sw.js (only if it is static and safe ` +
        `for every user) or to NEVER_CACHED_ROUTES in this file, with a reason. ` +
        `See docs/phase-5-pwa-design.md §7.1.\n\nUnclassified: ${unclassified.join(", ")}`,
    ).toEqual([]);
  });

  it("has no route listed as both cacheable and never-cached", () => {
    const overlap = [...cacheableExact].filter((route) => neverCached.has(route));
    expect(overlap, `Listed in BOTH public/sw.js CACHEABLE_ROUTES and this file's NEVER_CACHED_ROUTES — remove it from one.`).toEqual([]);
  });

  it("has no NEVER_CACHED_ROUTES or CACHEABLE_ROUTES entry that no longer exists as a real route", () => {
    // The opposite failure mode: a route gets deleted from app/ and its
    // classification entry is never cleaned up. Harmless to the worker, but
    // it means this guard is reviewing routes that no longer exist instead
    // of the ones that do — the completeness check above would still pass
    // even if a REAL new route were unclassified, purely by coincidence of
    // count. Keeping both lists live is what keeps the guard honest.
    const discoveredSet = new Set(discovered);
    const staleNeverCached = NEVER_CACHED_ROUTES.filter((route) => !discoveredSet.has(route));
    const staleCacheable = [...cacheableExact].filter((route) => !discoveredSet.has(route));
    expect({ staleNeverCached, staleCacheable }).toEqual({
      staleNeverCached: [],
      staleCacheable: [],
    });
  });
});

/* ---------------------------------------------------------------------------
 * §7.2 — /api/content/** has no auth, asserted rather than trusted to a comment
 * ------------------------------------------------------------------------ */

interface ForbiddenImport {
  pattern: RegExp;
  label: string;
}

/**
 * What "no auth" means, made checkable: none of these may be imported from
 * anywhere under app/api/content/. A regex over import specifiers, not a
 * real AST parse — deliberately: this exists to catch an ORDINARY accidental
 * addition (someone adding session-aware personalization to a content
 * route), not to defeat someone trying to hide one. That is the same level
 * of rigor the CACHEABLE_ROUTES parser above uses.
 */
const FORBIDDEN_IMPORTS: ForbiddenImport[] = [
  { pattern: /from\s+["']@\/lib\/auth/, label: "@/lib/auth" },
  { pattern: /from\s+["']@\/lib\/supabase/, label: "@/lib/supabase" },
  {
    pattern: /from\s+["']next\/headers["']/,
    label: 'next/headers (cookies()/headers() — reads request identity)',
  },
];

function findFiles(dir: string, basename: string): string[] {
  const files: string[] = [];
  function walk(current: string) {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry === basename) files.push(full);
    }
  }
  walk(dir);
  return files;
}

/** Inverse of discover-routes.ts's `toRoutePath`, for the one direction it
 *  needs to run: given a known-static cacheable route (never dynamic, never
 *  bracketed), find the page.tsx that renders it. */
function cacheablePageFile(route: string): string {
  const segments = route.split("/").filter(Boolean);
  return join(APP_DIR, ...segments, "page.tsx");
}

function scanForbiddenImports(
  files: readonly string[],
  rules: readonly ForbiddenImport[],
  describeViolation: (relPath: string, label: string) => string,
): string[] {
  const violations: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const relPath = relative(ROOT_DIR, file).replace(/\\/g, "/");
    for (const { pattern, label } of rules) {
      if (pattern.test(source)) violations.push(describeViolation(relPath, label));
    }
  }
  return violations;
}

describe("/api/content/** has no auth — asserted, not trusted to a comment", () => {
  const files = findFiles(API_CONTENT_DIR, "route.ts");

  it("found real route files to check (sanity check on discovery itself)", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it("no app/api/content/** route file imports auth, Supabase, or request identity", () => {
    const violations = scanForbiddenImports(
      files,
      FORBIDDEN_IMPORTS,
      (relPath, label) =>
        `${relPath} imports ${label}. This BREAKS the caching rule in ` +
        `docs/phase-5-pwa-design.md §2 and §7.2: the service worker caches ` +
        `every response under /api/content/** with stale-while-revalidate, ON ` +
        `THE ASSUMPTION that it is identical for every caller. An import like ` +
        `this means the route may now vary per user or per session — caching it ` +
        `would serve one person's response to the next person on a shared device. ` +
        `Either remove the import, or if the personalization is intentional, this ` +
        `route must be excluded from public/sw.js's /api/content/ prefix rule AND ` +
        `added to NEVER_CACHED_ROUTES's reasoning in lib/pwa/route-guard.test.ts.`,
    );
    expect(violations).toEqual([]);
  });
});

/**
 * A NARROWER rule than FORBIDDEN_IMPORTS above, for cacheable navigation
 * routes specifically — `@/lib/supabase/public-env` is excluded.
 *
 * `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY` are documented
 * in CLAUDE.md as "public by design", and `isSupabaseConfigured()` (which
 * reads only those) is a deterministic, build-time-constant check — it does
 * not read a session, a cookie, or anything else that could vary between two
 * visitors of the same static page. Found for real while writing this check:
 * `app/forgot-password/page.tsx` calls it to decide whether to render the
 * form or an "accounts unavailable" message, and that decision is identical
 * for everyone.
 *
 * `@/lib/auth`, `@/lib/supabase/server-*`, and `next/headers` stay forbidden
 * here without exception — those genuinely can vary per request, which is
 * the actual property this check exists to protect.
 */
const FORBIDDEN_IMPORTS_FOR_CACHEABLE_ROUTES: ForbiddenImport[] = [
  { pattern: /from\s+["']@\/lib\/auth/, label: "@/lib/auth" },
  {
    pattern: /from\s+["']@\/lib\/supabase(?!\/public-env["'])/,
    label: "@/lib/supabase (a submodule other than the public, non-identity public-env)",
  },
  {
    pattern: /from\s+["']next\/headers["']/,
    label: 'next/headers (cookies()/headers() — reads request identity)',
  },
];

/**
 * PARTIAL protection for §7.1's cacheable navigation routes, not the same
 * guarantee §7.3 asks for. This only sees a DIRECT import in the page.tsx
 * file itself — the design doc's own worked example is a `cookies()` call
 * "several layers down, with no local edit to the route file at all", which
 * this cannot see because it never follows an import graph. That case is
 * only caught by a real `next build`'s static/dynamic split, which is a
 * MANUAL verification discipline here (see the note above
 * NEVER_CACHED_ROUTES's declaration point, and §7.3 in the design doc) —
 * the same one this project already uses for the credential greps in Phase 4
 * Step 4 and the sentinel checks in Phase 6 Step 3, not a spawned build
 * wired into every `npm test` run. This check exists anyway because it is
 * near-zero cost and catches the cheapest version of the mistake for free.
 */
describe("cacheable navigation routes have no DIRECT auth/identity import (partial — see above)", () => {
  const files = parseCacheableRoutesFromServiceWorker().map(cacheablePageFile);

  it("every CACHEABLE_ROUTES entry resolves to a real page.tsx (sanity check)", () => {
    for (const file of files) expect(statSync(file).isFile()).toBe(true);
  });

  it("no cacheable route's own page.tsx directly imports auth, Supabase, or request identity", () => {
    const violations = scanForbiddenImports(
      files,
      FORBIDDEN_IMPORTS_FOR_CACHEABLE_ROUTES,
      (relPath, label) =>
        `${relPath} imports ${label}. This route is in public/sw.js's CACHEABLE_ROUTES ` +
        `(docs/phase-5-pwa-design.md §1/§2) on the assumption that it renders identical ` +
        `HTML for every visitor — cookies()/headers() or an auth/Supabase import means it ` +
        `may not. A direct import here is enough to make that assumption false even before ` +
        `checking whether the route ACTUALLY went dynamic (this check cannot see a ` +
        `transitive import several components deep — only a real 'next build' can). ` +
        `Remove it from CACHEABLE_ROUTES, or confirm the route is still '○ (Static)' in a ` +
        `real build and this import is a false positive (e.g. a type-only import).`,
    );
    expect(violations).toEqual([]);
  });
});
