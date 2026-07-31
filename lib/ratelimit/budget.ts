/**
 * A global daily spend cap on a quota-bound upstream.
 *
 * ============================================================================
 * WHY PER-IP LIMITING IS NOT ENOUGH ON ITS OWN
 * ============================================================================
 * OMDb's free tier is 1,000 requests per DAY, counted globally across every
 * caller. A per-IP limit constrains one abuser; it does nothing about a
 * thousand IPs asking for one title each, and nothing about a caller who can
 * forge `X-Forwarded-For` (see the trust-model note in `client-ip.ts`). Both
 * of those exhaust the quota while every per-IP bucket stays green.
 *
 * This is the backstop that IP spoofing cannot evade, because it does not
 * depend on caller identity at all. It is deliberately the mechanism guarding
 * the only HARD external cap in the app.
 *
 * ============================================================================
 * WHAT IT COUNTS — and why that is conservative on purpose
 * ============================================================================
 * It counts **route invocations that reach the handler**, NOT confirmed OMDb
 * network calls. Those differ: a request served from the CDN never reaches us
 * at all (so is never counted, correctly), but a request that reaches us and
 * is then served from Next's 7-day data cache IS counted despite spending no
 * quota (so is over-counted).
 *
 * Over-counting is the safe direction. It trips early, and tripping degrades
 * to "no external ratings" — a state CLAUDE.md already documents as supported
 * rather than broken, since a blank `OMDB_API_KEY` produces exactly the same
 * result and the detail page renders fine on TMDB's own score. The budget is
 * therefore set well above realistic legitimate traffic, so the conservatism
 * costs nothing in practice.
 *
 * Counting true network calls would mean threading a counter into
 * `lib/content/omdb/client.ts` and still could not distinguish a cache hit
 * from a real fetch, because Next's fetch cache is transparent to the caller.
 * Not worth the precision it wouldn't actually buy.
 */

/** Of OMDb's 1,000/day, leaving deliberate headroom for the over-count above
 *  and for anything spent outside this route. */
export const OMDB_DAILY_BUDGET = 800;

interface BudgetState {
  day: string;
  used: number;
}

const budgets = new Map<string, BudgetState>();

/**
 * The UTC calendar day.
 *
 * ⚠️ Note this is the `toISOString().slice(0, 10)` pattern that
 * `lib/watchlog/types.ts` warns against — and here it is CORRECT, which is
 * worth stating so nobody "fixes" it to match. That warning is about a user's
 * personal watch history, where the day is a fact about where the *user* was
 * and must be frozen in their local timezone. This is an external vendor's
 * global quota counter: it has nothing to do with any user's timezone, every
 * server must agree on the same boundary, and UTC is the only defensible
 * choice. Using a local date here would make the reset point depend on which
 * region a serverless instance happened to run in.
 *
 * The exact instant OMDb resets its own counter is undocumented, so this is an
 * approximation of their boundary, not a mirror of it. The headroom in
 * `OMDB_DAILY_BUDGET` is what absorbs the difference.
 */
function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Records one unit of spend against `name` and reports whether it was within
 * budget. Rolls over automatically when the UTC day changes.
 *
 * Returns `false` once exhausted — the caller is expected to degrade, not to
 * error (see the note above on why "no external ratings" is a supported state).
 */
export function consumeDailyBudget(name: string, limit: number, now: Date = new Date()): boolean {
  const day = utcDay(now);
  const state = budgets.get(name);

  if (state === undefined || state.day !== day) {
    budgets.set(name, { day, used: 1 });
    return true;
  }

  if (state.used >= limit) return false;

  state.used += 1;
  return true;
}

/** Read-only peek, for diagnostics and tests. */
export function dailyBudgetUsed(name: string, now: Date = new Date()): number {
  const state = budgets.get(name);
  if (state === undefined || state.day !== utcDay(now)) return 0;
  return state.used;
}

/** Test seam only. */
export function resetDailyBudgets(): void {
  budgets.clear();
}
