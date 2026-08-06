import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";

import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./public-env";

/**
 * A request-scoped Supabase client, authenticated as whoever the request's
 * cookies say it is.
 *
 * Lives in `lib/supabase/` rather than `lib/auth/supabase/` on purpose: Phase 6
 * Step 5's sync layer needs exactly this client for its own reads and writes,
 * and having `lib/sync/` import from `lib/auth/` for a reason that has nothing
 * to do with auth would be the wrong dependency edge. This is SDK plumbing;
 * `lib/auth/` is the domain.
 *
 * ============================================================================
 * NEVER CACHE OR SHARE THIS CLIENT
 * ============================================================================
 * A new one per request, every time. The client carries the caller's session,
 * so a module-scope singleton on the server would let one visitor's request be
 * served with another visitor's identity — the same class of bug that makes
 * the memory storage driver forbidden during SSR (CLAUDE.md, "Three
 * environments, three drivers"). @supabase/ssr's own documentation says the
 * same thing in stronger terms. There is deliberately no memoization here, not
 * even React `cache()`: the win would be trivial and the failure mode is
 * catastrophic and silent.
 */
export async function createSupabaseServerClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies();

  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        // ====================================================================
        // WHY THIS SWALLOWS THE THROW, AND WHY THAT IS SAFE *ONLY* BECAUSE
        // proxy.ts EXISTS
        // ====================================================================
        // Next 16's `cookies` reference is explicit: "HTTP does not allow
        // setting cookies after streaming starts, so you must use `.set` in a
        // Server Function or Route Handler." Calling `.set` during a Server
        // Component render therefore throws.
        //
        // But the client legitimately needs to write here — a refreshed access
        // token has to be persisted or the next request refreshes again. The
        // resolution is that `proxy.ts` performs the refresh BEFORE any render
        // begins, where cookies are writable, so by the time a Server
        // Component renders, the cookie jar is already current and there is
        // nothing left for this call to persist.
        //
        // So the catch is not "ignore an error and hope". It is: this write is
        // redundant in the one context where it fails. Delete proxy.ts and
        // this becomes the silent-random-logout bug @supabase/ssr warns about.
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Component render — see above.
        }
      },
    },
  });
}
