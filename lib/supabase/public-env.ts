/**
 * The two Supabase values that are PUBLIC BY DESIGN.
 *
 * Deliberately NO `import "server-only"` — unlike `server-env.ts` next door.
 * These are meant to reach the browser: the anon key is what the client SDK
 * authenticates with, and Supabase's security model assumes it is public. It
 * is safe **only because** Row Level Security is enabled on every table (see
 * supabase/migrations). Holding the anon key grants nothing on its own; it is
 * a routing credential, not an authorisation one.
 *
 * That is also the sharpest reason RLS is non-negotiable here: a table in the
 * `public` schema with RLS off is readable by anyone who views source.
 *
 * Both are read at module scope rather than lazily, which is correct for these
 * two specifically — being inlined into the client bundle is the intended
 * outcome, not a leak. `server-env.ts` does the opposite for the opposite
 * reason.
 */

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

/**
 * Whether Supabase is configured at all.
 *
 * The zero-config promise depends on this: with no Supabase env vars the app
 * must behave exactly as it does today — anonymous, local-only, fully
 * functional. Same shape as `getContentProvider()` defaulting to `mock`, so
 * the account layer is inert rather than broken when unconfigured.
 */
export function isSupabaseConfigured(): boolean {
  return SUPABASE_URL.length > 0 && SUPABASE_ANON_KEY.length > 0;
}
