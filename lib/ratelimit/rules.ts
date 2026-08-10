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

  /**
   * Phase 6 Step 6 comment Server Actions: post, edit, delete. Shared by all
   * three rather than split further — edit/delete are lower-risk than a fresh
   * post, but splitting them into their own buckets buys little (nobody
   * scripts "edit spam") for a real cost (three constants to keep in sync
   * instead of one). 12/min is generous for a human actually typing and well
   * above what a legitimate burst — post, then two quick edits fixing a typo —
   * would ever need, while still turning a scripted flood into a trickle.
   */
  comments: { name: "comments", limit: 12, windowSeconds: 60 },

  /**
   * Liking is the lowest-risk action here — it is a toggle, not content, and
   * a real person scrolling a big thread tapping several likes in a row is
   * normal, expected behaviour. Sized generously above that.
   */
  commentLikes: { name: "comment-likes", limit: 60, windowSeconds: 60 },

  /**
   * Reporting gets the tightest limit in this file, on the same reasoning as
   * `auth`: it is itself an abuse vector, not just a target of one. The
   * auto-hide trigger only needs 3 DISTINCT reporters per comment to fire
   * (supabase/migrations/20260809000001_comments.sql), so a single account
   * spamming reports across many DIFFERENT comments — trying to get lucky
   * finding two allies, or just being disruptive — is the thing worth
   * slowing down. A genuine user reports at most a handful of comments in any
   * real session.
   */
  commentReports: { name: "comment-reports", limit: 5, windowSeconds: 60 },

  /**
   * Phase 6 Step 6b: create/rename/re-describe/re-visibility/delete a list.
   * Rarer, more deliberate actions than posting a comment — a human creates
   * or edits a handful of lists in a session, never a stream of them. Tighter
   * than `comments` for that reason, not because the abuse risk is higher.
   */
  lists: { name: "lists", limit: 10, windowSeconds: 60 },

  /**
   * Adding/removing items. Sized for the realistic burst this app itself
   * creates: building a new list means adding many titles in quick
   * succession — one click each, no debounce — so this needs the same
   * generosity `commentLikes` gets, for the same reason (a legitimate human
   * action, not a scripted one, produces the burst).
   */
  listItems: { name: "list-items", limit: 60, windowSeconds: 60 },

  /**
   * Inviting a collaborator, and responding to an invite (accept/decline).
   * Tight, same severity class as `commentReports`: an invite is reachable
   * abuse — spamming invites at strangers is itself the nuisance, not just
   * something to be protected from. A real owner invites a handful of people
   * to a shared list, not dozens in a minute.
   */
  listCollaborators: { name: "list-collaborators", limit: 8, windowSeconds: 60 },

  /**
   * Follow/unfollow. A toggle with the same low-risk shape as `commentLikes`
   * — someone browsing a "discover public lists" page and following several
   * in a row is ordinary use, not abuse.
   */
  listFollowers: { name: "list-followers", limit: 60, windowSeconds: 60 },

  /**
   * Phase 7 Step 1: the CSV importer's batched match endpoint.
   *
   * ============================================================================
   * WHY THIS RULE HAD TO EXIST AT ALL
   * ============================================================================
   * A 3,000-row import resolved one row per request would hit `search`'s
   * 30/min after row 30 — the importer would 429 against our OWN limiter
   * before TMDB ever noticed it. The fix is not a looser limit, it is a
   * different request shape: `/api/import/resolve` takes a BATCH of rows
   * (capped at `IMPORT_BATCH_LIMIT`), so 3,000 rows becomes ~120 requests
   * rather than 3,000.
   *
   * 30/min against a 25-row batch is ~750 rows a minute, so a very large
   * import takes a few minutes of wall-clock time and stays inside the limit
   * throughout. That pacing is deliberate rather than reluctant: the work is
   * resumable, the user watches a progress bar either way, and an importer
   * that finishes in twenty seconds by saturating TMDB is not a better
   * outcome for anyone.
   *
   * The endpoint's real upstream cost is bounded twice over — by this rule,
   * and by the server-side concurrency cap inside `resolveRows`.
   */
  importResolve: { name: "import-resolve", limit: 30, windowSeconds: 60 },

  /**
   * Phase 7 Step 5: saving a push subscription, editing prefs, syncing a
   * timezone.
   *
   * Tight because none of these is a browsing action — a real user edits
   * quiet hours once and subscribes once per device. The timezone sync fires
   * automatically on mount, but only when the zone actually CHANGED, so it is
   * rare rather than per-visit.
   */
  notifications: { name: "notifications", limit: 15, windowSeconds: 60 },

  /**
   * Follow/unfollow a show for notifications. Same low-risk toggle shape as
   * `listFollowers` and `commentLikes`, and needs comparable headroom: someone
   * setting this up for the first time reasonably works down their library
   * turning several shows on in a row.
   */
  notificationFollows: { name: "notification-follows", limit: 60, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitRule>;
