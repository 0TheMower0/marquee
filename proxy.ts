import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import {
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
  isSupabaseConfigured,
} from "@/lib/supabase/public-env";

/**
 * Session refresh, and nothing else.
 *
 * ============================================================================
 * WHY THIS IS IN proxy.ts WHEN RATE LIMITING DELIBERATELY IS NOT
 * ============================================================================
 * `lib/ratelimit/index.ts` quotes Next's proxy documentation to argue the
 * limiter must NOT live here: "you should not attempt relying on shared
 * modules or globals." That reasoning stands, and it does not apply to this
 * file, because the two need different things from the environment:
 *
 *   - The limiter needs a counter that survives between requests. That is
 *     process state, and process state is exactly what proxy cannot promise.
 *   - Session refresh needs nothing but THIS request's cookies and THIS
 *     response's `Set-Cookie` headers. It is pure per-request I/O with no
 *     memory of any other request, so every caveat in that warning is
 *     irrelevant to it.
 *
 * And unlike the limiter, this genuinely cannot live anywhere else. Next 16's
 * `cookies` reference: "HTTP does not allow setting cookies after streaming
 * starts, so you must use `.set` in a Server Function or Route Handler." A
 * Server Component render therefore cannot persist a refreshed token. Proxy
 * runs *before* rendering, where the response headers are still open, which
 * makes it the only place a refresh can be written back on an ordinary page
 * navigation.
 *
 * Delete this file and the failure is not immediate — it is the intermittent,
 * hard-to-diagnose one @supabase/ssr warns about: every server render triggers
 * another refresh whose result is discarded, and with refresh-token rotation
 * on, users get logged out at random.
 */
export async function proxy(request: NextRequest) {
  // Zero-config path: no Supabase project, nothing to refresh. This runs on
  // every matched request, so it must be the cheapest possible no-op for the
  // deployment that has no accounts at all.
  if (!isSupabaseConfigured()) return NextResponse.next();

  // Anonymous visitors are the majority and have no auth cookie. Skipping them
  // here keeps the whole Supabase client out of their request path rather than
  // constructing one to discover there is no session.
  const hasAuthCookie = request.cookies
    .getAll()
    .some((cookie) => cookie.name.startsWith("sb-"));
  if (!hasAuthCookie) return NextResponse.next();

  let response = NextResponse.next({ request });

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        // Written to BOTH sides on purpose, and both are load-bearing:
        //
        //   - onto `request`, so the Server Components rendered later in THIS
        //     same request read the refreshed token rather than the expired
        //     one they arrived with;
        //   - onto a freshly derived `response`, so the browser is actually
        //     told to store it.
        //
        // Mutating `request.cookies` and then rebuilding the response from it
        // is the documented @supabase/ssr pattern; skipping the rebuild is the
        // classic way to get a refresh that works for exactly one request.
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }

        // The library hands back `Cache-Control: private, no-store, ...` with
        // these. Applying them is not optional politeness: a CDN that cached a
        // response carrying someone's `Set-Cookie` would hand that session to
        // the next visitor sharing the edge. Same failure this project already
        // guarded against by putting `no-store` on the 429 in Phase 6 Step 2 —
        // there it leaked a rate-limit state, here it would leak an identity.
        for (const [key, value] of Object.entries(headers)) {
          response.headers.set(key, value);
        }
      },
    },
  });

  // The call that does the work. `getUser()` validates the access token with
  // the auth server and refreshes it when expired, which triggers `setAll`
  // above. The result is intentionally unused — proxy's job is to make the
  // cookies current, not to make an authorization decision. Every such
  // decision belongs to RLS in Postgres, which is enforced no matter how the
  // request arrived; a check here would be a second, weaker copy of it that
  // could silently drift out of agreement with the real one.
  await supabase.auth.getUser();

  return response;
}

export const config = {
  /**
   * Everything except static assets and the image optimizer.
   *
   * Without a matcher, proxy runs on every request including `_next/static`
   * and `public/` — which would mean a Supabase round trip attached to every
   * CSS file, JS chunk, and optimized poster on the page. `_next/image` is
   * excluded explicitly for that reason: a grid of 20 posters would otherwise
   * be 20 extra auth calls for one page view.
   */
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|txt)$).*)",
  ],
};
