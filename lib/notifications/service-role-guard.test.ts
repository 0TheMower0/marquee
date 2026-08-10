import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The service-role containment guard — Phase 7 Step 5, design doc §11.
 *
 * ============================================================================
 * THIS TEST IS THE ONLY MECHANICAL THING PREVENTING A SECOND SERVICE-ROLE
 * CODE PATH.
 * ============================================================================
 * `SUPABASE_SERVICE_ROLE_KEY` carries BYPASSRLS. Every policy in every
 * migration under `supabase/` is simply not applied to a client holding it, so
 * a second importer is not "more code using a helper" — it is a second place
 * where every user's library, ratings, private notes and watch history are
 * reachable with nothing in the database able to intervene.
 *
 * Nothing else stops that from happening. `server-only` prevents the key
 * reaching a BROWSER, and the typed allowlist inside `store.ts` constrains
 * what THAT module can touch — but neither prevents a new file from importing
 * `server-env` and creating its own unconstrained client. Only this does.
 *
 * Inverted in the same way as the Phase 7 Step 2 sync guard and the Phase 5
 * Step 6 route guard: the allowlist is a literal that a human must edit, so
 * adding an importer fails loudly rather than passing silently.
 */

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Directories that contain application code. Deliberately does not include
 *  `.next`, `node_modules`, or `supabase` — build output and SQL. */
const SCANNED_DIRS = ["app", "components", "lib", "scripts"];

const SERVER_ENV_MODULE = "@/lib/supabase/server-env";

/**
 * The complete list of files permitted to import the service-role key.
 *
 * Adding an entry here is a deliberate act with real consequences. Before
 * doing so, check whether the operation could use the USER's own JWT instead
 * — subject to RLS, and almost always sufficient. Legitimate reasons are
 * narrow: a job with no user context at all (the notification cron) or a
 * webhook handler acting on an external system's behalf.
 */
const ALLOWED_IMPORTERS = [
  // The notification cron's data layer. Needs to read EVERY user's follow rows
  // and write to their queue, which own-rows RLS exists to forbid and which
  // has no auth.uid() to act as. Never exports its client; its table access is
  // a typed allowlist. See that file's header.
  "lib/notifications/server/store.ts",
] as const;

function sourceFiles(): string[] {
  const files: string[] = [];

  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx|mjs|js)$/.test(entry)) {
        files.push(full);
      }
    }
  }

  for (const dir of SCANNED_DIRS) walk(join(ROOT_DIR, dir));
  return files;
}

function relativePath(file: string): string {
  return relative(ROOT_DIR, file).replace(/\\/g, "/");
}

/**
 * Matches a real import, not a mention.
 *
 * A plain `source.includes(module)` was the first attempt and it was wrong:
 * `lib/notifications/detect.ts` NAMES the store in a doc comment explaining
 * that suppression deliberately lives elsewhere, and got flagged as an
 * importer. A guard that fires on prose trains people to add exclusions,
 * which is precisely how a guard stops guarding.
 */
function importsModule(source: string, moduleSpecifier: string): boolean {
  const escaped = moduleSpecifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`from\\s+["'\`]${escaped}["'\`]`).test(source);
}

describe("service-role key containment", () => {
  const files = sourceFiles();

  it("scanned a real, non-trivial number of files (guard for the guard)", () => {
    // A broken walk would make every assertion below vacuously true.
    expect(files.length).toBeGreaterThan(100);
  });

  it("only the declared module imports the service-role key", () => {
    const importers = files
      .filter((file) => importsModule(readFileSync(file, "utf8"), SERVER_ENV_MODULE))
      .map(relativePath);

    const undeclared = importers.filter(
      (file) => !(ALLOWED_IMPORTERS as readonly string[]).includes(file),
    );

    expect(
      undeclared,
      `${undeclared.length} file(s) import ${SERVER_ENV_MODULE} without being declared in ` +
        `ALLOWED_IMPORTERS.\n\n` +
        `This key carries BYPASSRLS: a client holding it is exempt from EVERY policy in ` +
        `supabase/migrations, so this is not "another file using a helper" — it is another ` +
        `place with unmediated read/write access to every user's library, ratings, private ` +
        `notes and watch history, with no audit trail distinguishing it from legitimate ` +
        `traffic.\n\n` +
        `Before adding an entry: can this use the USER's own JWT instead? It is subject to ` +
        `RLS and is almost always sufficient. If it genuinely cannot (a job with no user ` +
        `context, a webhook), add the file to ALLOWED_IMPORTERS with a comment saying why, ` +
        `and give it the same shape as lib/notifications/server/store.ts — a module-private ` +
        `client that is never exported, and a typed table allowlist.\n\n` +
        `See docs/phase-7-notifications-design.md §4 and §11.\n\n` +
        `Undeclared: ${undeclared.join(", ")}`,
    ).toEqual([]);
  });

  it("every declared importer still exists", () => {
    // The opposite failure: a permitted file is deleted or moved and the
    // allowlist keeps granting permission to a path that no longer exists,
    // leaving the guard reviewing a file that isn't there.
    const present = new Set(files.map(relativePath));
    const missing = ALLOWED_IMPORTERS.filter((file) => !present.has(file));
    expect(missing).toEqual([]);
  });

  it("the service-role module never exports its client", () => {
    // The typed table allowlist in store.ts is only meaningful while the raw
    // client stays module-private — one `export` on the client factory and
    // every constraint in that file becomes advisory.
    const source = readFileSync(join(ROOT_DIR, "lib/notifications/server/store.ts"), "utf8");
    expect(
      /export\s+(async\s+)?function\s+client\b/.test(source),
      "store.ts exports its service-role client. Every table restriction in that file " +
        "becomes advisory the moment a caller can reach the raw client — add a named " +
        "operation instead.",
    ).toBe(false);
    expect(source.includes("export const client")).toBe(false);
  });

  it("the cron route is the only caller of the service-role store", () => {
    // A second caller would not be a leak by itself, but it would mean the
    // "what can the notifier touch" inventory in store.ts is no longer the
    // whole story for who can touch it.
    const importers = files
      .filter((file) => {
        // Siblings inside the server directory import each other's types
        // legitimately (push.ts takes a DeviceSubscription).
        if (relativePath(file).startsWith("lib/notifications/server/")) return false;
        return importsModule(readFileSync(file, "utf8"), "@/lib/notifications/server/store");
      })
      .map(relativePath);

    expect(importers).toEqual(["app/api/cron/notifications/route.ts"]);
  });
});

describe("push credentials are not public", () => {
  const files = sourceFiles();

  it("VAPID_PRIVATE_KEY and CRON_SECRET are never NEXT_PUBLIC_ prefixed", () => {
    // A NEXT_PUBLIC_ prefix inlines a value into the client bundle. For the
    // VAPID private key that means anyone can send notifications as us; for
    // CRON_SECRET it means anyone can invoke the service-role code path.
    //
    // The forbidden strings are CONCATENATED rather than written literally,
    // so this file does not contain the very patterns it searches for and can
    // therefore scan itself like any other. Same trick, for the same reason,
    // as `lib/comments/validate.ts` building its zero-width-character regex
    // from numeric code points: a detector that has to exempt itself is one
    // exemption away from exempting something real.
    const prefix = "NEXT_PUBLIC" + "_";
    const forbidden = [`${prefix}VAPID_PRIVATE_KEY`, `${prefix}CRON_SECRET`];

    const violations: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      if (forbidden.some((name) => source.includes(name))) violations.push(relativePath(file));
    }
    expect(violations).toEqual([]);
  });

  it("the private key and cron secret are read only from server-only modules", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const readsSecret = /process\.env\.(VAPID_PRIVATE_KEY|CRON_SECRET)/.test(source);
      if (!readsSecret) continue;

      const rel = relativePath(file);
      // A route handler is server-only by construction; anything else must say
      // so explicitly with the `server-only` import.
      const isRouteHandler = /^app\/.*\/route\.ts$/.test(rel);
      if (!isRouteHandler && !source.includes('import "server-only"')) {
        offenders.push(rel);
      }
    }
    expect(
      offenders,
      `These read VAPID_PRIVATE_KEY or CRON_SECRET but are neither a route handler nor ` +
        `marked \`import "server-only"\`, so nothing prevents them being pulled into a ` +
        `client bundle: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
