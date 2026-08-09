import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Test-only tooling for the service worker's route-classification guard
 * (docs/phase-5-pwa-design.md §7.1). Nothing here is imported by app code —
 * it does filesystem I/O and has no reason to exist in a browser bundle.
 *
 * Discovers every route the App Router produces by walking `app/` for
 * `page.tsx` and `route.ts` files, structurally — NOT by spawning a real
 * `next build`, which takes seconds to tens of seconds and has no place in a
 * unit suite that otherwise runs in about a second. This was cross-checked BY
 * HAND against real `next build` output while building this guard (CLAUDE.md,
 * Phase 5 Step 6, 4/4) and produced the identical 30-route set. If the App
 * Router's own route-derivation rules ever change (new file conventions,
 * route groups actually get used, parallel/intercepting routes), re-verify
 * the same way — this function will not notice on its own.
 */

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "app");

/**
 * Metadata-file routes whose URL does not mechanically match their file's
 * directory nesting — Next names these by convention, not by path. Extend
 * this if `app/robots.ts`, `app/sitemap.ts`, `app/icon.tsx`, or
 * `app/apple-icon.tsx` are ever added. None exist today — confirmed by
 * listing `app/` directly while writing this guard.
 */
const SPECIAL_ROOT_FILES: Record<string, string> = {
  "manifest.ts": "/manifest.webmanifest",
};

/**
 * Routes Next always synthesizes with no corresponding source file to
 * discover. `_not-found` exists in the build's route table regardless of
 * whether `app/not-found.tsx` is present — a custom file only changes what
 * RENDERS there, not whether the route itself exists.
 */
const SYNTHETIC_ROUTES = ["/_not-found"];

function toRoutePath(relativeDir: string): string {
  if (relativeDir === "") return "/";
  const segments = relativeDir
    .split(/[\\/]/)
    // Route groups — `(name)` — are organizational only and contribute no
    // URL segment. None exist in this project today; handled anyway, since
    // silently mis-routing one later would be exactly the kind of thing this
    // guard exists to catch, applied to itself.
    .filter((segment) => !(segment.startsWith("(") && segment.endsWith(")")));
  return `/${segments.join("/")}`;
}

export function discoverAppRoutes(appDir: string = APP_DIR): string[] {
  const routes = new Set<string>(SYNTHETIC_ROUTES);

  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);

      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }

      if (dir === appDir && entry in SPECIAL_ROOT_FILES) {
        routes.add(SPECIAL_ROOT_FILES[entry]);
        continue;
      }

      if (entry === "page.tsx" || entry === "route.ts") {
        routes.add(toRoutePath(relative(appDir, dir)));
      }
    }
  }

  walk(appDir);
  return [...routes].sort();
}
