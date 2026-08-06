import type { RateLimitRule } from "./types";

/**
 * The limits, in one place so they can be argued about without reading any
 * routing code.
 *
 * Sized against real page behaviour rather than picked round: a TV detail page
 * fires roughly six of these at once (title, similar, recommendations, watch
 * providers, ratings, seasons), and Home fires trending plus one `getSeasons`
 * per in-progress show. A limit that a normal page view can trip is not a
 * limit, it's an outage.
 */
export const RATE_LIMITS = {
  /**
   * Everything cached hard upstream: detail, similar, recommendations, watch
   * providers, seasons, trending. ~120/min leaves room for roughly 8-12 page
   * views a minute, well above human browsing, while still turning an
   * unbounded scrape into a trickle.
   */
  read: { name: "read", limit: 120, windowSeconds: 60 },

  /**
   * Tighter, because search is the one route that can defeat every cache
   * layer we have. CLAUDE.md says it outright: "a unique `?query=` string per
   * request defeats every cache layer" — so this is TMDB's real exposure, and
   * a human typing behind a debounce never approaches 30/min.
   */
  search: { name: "search", limit: 30, windowSeconds: 60 },

  /**
   * Tightest. OMDb's free tier is 1,000 requests/DAY across all callers, so
   * this route is the only one backed by a hard external quota rather than a
   * soft one. Per-IP alone cannot defend a global cap — see `budget.ts`, which
   * is the actual backstop; this just stops any single caller from being the
   * one who spends it.
   */
  ratings: { name: "ratings", limit: 15, windowSeconds: 60 },

  /**
   * The Phase 6 Step 4 auth Server Actions: sign in, sign up, password reset,
   * resend, and the username availability check.
   *
   * Supabase runs its own auth rate limits, so this is not the only guard —
   * but two of these are reachable while signed OUT and neither is protected
   * by Supabase's *email* limits. `username_available` is the sharper one: it
   * is a deliberate existence oracle for usernames (any signup form is), and
   * without a limit it is a free, unauthenticated endpoint for enumerating
   * every username on the deployment.
   *
   * 10/min is generous for a human filling in one form — a mistyped password
   * three times, plus availability checks while picking a name — and turns
   * credential stuffing or username enumeration into something too slow to be
   * worth running.
   */
  auth: { name: "auth", limit: 10, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitRule>;
