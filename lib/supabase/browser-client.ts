"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from "./public-env";

/**
 * The browser-side Supabase client.
 *
 * ============================================================================
 * WHY THIS EXISTS NOW AND DELIBERATELY DID NOT IN STEP 4
 * ============================================================================
 * Step 4 wrote this file, found nothing imported it, and deleted it — every
 * auth mutation is a Server Action, so no Supabase code reached the browser at
 * all. Step 5 changes that, and the reason is not convenience:
 *
 *   - Sync reads and writes **localStorage**, which only exists in the browser.
 *   - Sync must work **offline** and flush on reconnect. Routing it through
 *     Server Actions would make every queued write depend on our server being
 *     reachable, on top of Supabase being reachable.
 *   - A 300-row episode batch would otherwise cross two hops instead of one.
 *
 * So the sync engine talks to Supabase directly from the browser, which is
 * exactly what the anon key and RLS are designed for: the key is a routing
 * credential, every table forces row-level security, and a browser holding a
 * session can only ever reach its own rows. This is not a weakening of the
 * Step 4 boundary — the *service role* key still never leaves the server, and
 * that is the credential that would matter.
 *
 * Auth remains server-written: `signInWithPassword` and friends still run in
 * Server Actions so the session cookie is set where Server Components can read
 * it. This client only *reads* that session (`@supabase/ssr` stores it in
 * cookies, so both sides see the same one) and uses it to authorize data calls.
 *
 * A singleton is correct here and is the opposite of the rule on the server: a
 * browser process serves exactly one user, and `createBrowserClient` is
 * `isSingleton: true` by default anyway. Returns null when unconfigured, so
 * callers degrade without a network attempt against an empty URL.
 */
let cached: SupabaseClient | null = null;

export function getSupabaseBrowserClient(): SupabaseClient | null {
  if (!isSupabaseConfigured()) return null;
  cached ??= createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return cached;
}
