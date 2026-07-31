import "server-only";

/**
 * The service role key — the third upstream credential, held to exactly the
 * same rules as `TMDB_READ_ACCESS_TOKEN` and `OMDB_API_KEY` (CLAUDE.md,
 * "Secret handling"):
 *
 *   1. `SUPABASE_SERVICE_ROLE_KEY`, never prefixed `NEXT_PUBLIC_`.
 *   2. This module is `server-only`, so an accidental client import is a BUILD
 *      error rather than a runtime credential leak.
 *   3. It never reaches a browser by any path.
 *
 * ============================================================================
 * WHY THIS ONE IS WORSE TO LEAK THAN THE OTHER TWO
 * ============================================================================
 * Leaking the TMDB or OMDb key costs us a quota and a rotation. The service
 * role key carries **BYPASSRLS**: every policy in
 * `supabase/migrations/20260801000001_initial_schema.sql` is simply not
 * applied to it. A leak is not "someone can read some data" — it is total,
 * silent access to every user's library, ratings, private notes and watch
 * history, with no audit trail distinguishing it from legitimate traffic.
 *
 * There is currently NO code path that needs it. It is defined here so the
 * boundary exists — and is tested — before anything is tempted to reach for
 * it. If you find yourself wanting it in a request handler, check first
 * whether the user's own JWT (subject to RLS) would do; it almost always
 * will. Legitimate uses are narrow: admin/maintenance jobs and webhook
 * handlers that act with no user context.
 *
 * ============================================================================
 * READ LAZILY, NOT AT MODULE SCOPE
 * ============================================================================
 * Same reasoning as `lib/content/omdb/client.ts`. CLAUDE.md notes that reading
 * `process.env` at module scope can be inlined at BUILD time; reading it
 * inside the function keeps the value out of the compiled output entirely, so
 * it is absent from `.next/server` as well as `.next/static`. Verified with a
 * sentinel value — see the Phase 6 Step 3 notes in CLAUDE.md.
 */
export function serviceRoleKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set. This key bypasses Row Level Security — " +
        "confirm the operation genuinely cannot use the user's own token before configuring it.",
    );
  }
  return key;
}

/** Whether the service role key is available, without reading its value.
 *  Lets a caller degrade instead of throwing when it is absent. */
export function hasServiceRoleKey(): boolean {
  return Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
}
