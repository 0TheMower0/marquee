/**
 * Public surface of the rate-limiting layer. Route handlers import from here,
 * never from the individual modules — mirrors every other lib/ package.
 *
 * ============================================================================
 * WHY THIS LIVES IN ROUTE HANDLERS AND NOT IN `proxy.ts`
 * ============================================================================
 * A root `proxy.ts` looks like the obvious home — one file, every route
 * covered by a matcher. Next 16's own documentation rules it out:
 *
 *   "Proxy is meant to be invoked separately of your render code and in
 *    optimized cases deployed to your CDN for fast redirect/rewrite handling,
 *    you should not attempt relying on shared modules or globals."
 *   — node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md
 *
 * An in-process counter IS a shared global. Putting it in proxy would put the
 * limiter exactly where the framework tells you module state isn't dependable,
 * and it may run at the CDN edge where our Map doesn't exist at all.
 *
 * Calling the guard inside each handler also buys something proxy can't: the
 * rule is chosen per route, which is what makes the OMDb route's tighter
 * limit expressible at all. A matcher would have to encode limits by path
 * pattern, duplicating routing knowledge that already exists in the file tree.
 */
export { consumeDailyBudget, dailyBudgetUsed, OMDB_DAILY_BUDGET, resetDailyBudgets } from "./budget";
export { clientIp, normalizeIp } from "./client-ip";
export { checkRateLimit } from "./limiter";
export { MemoryRateLimitStore } from "./memory-store";
export { RATE_LIMITS } from "./rules";
export type { RateLimitDecision, RateLimitRule, RateLimitStore } from "./types";
