import type { RateLimitDecision, RateLimitRule, RateLimitStore } from "./types";

/**
 * In-process sliding-window store.
 *
 * ============================================================================
 * ⚠️ THE LIMITATION, STATED UP FRONT
 * ============================================================================
 * This counts per PROCESS. On Vercel each warm serverless instance holds its
 * own Map, so with N instances live the effective ceiling is N x `limit`, and
 * a cold start resets a bucket to zero. This is **not** a strict distributed
 * limiter and must not be described as one.
 *
 * It is still worth having, and is the right first step:
 *
 *   - It caps a single abusive caller by orders of magnitude. Unbounded
 *     scraping becomes N x 30/min instead of "as fast as they can send".
 *   - It costs zero dependencies and zero credentials, which keeps the
 *     zero-config promise intact — the app still runs with no env file.
 *   - `RateLimitStore` is the swap point. A Redis/Upstash implementation is
 *     one more class and one line in `limiter.ts`; no route handler changes.
 *
 * The thing that genuinely does not depend on instance count is the global
 * daily budget in `budget.ts`, which is why the OMDb quota — the only HARD
 * external cap we have — is defended there rather than here.
 *
 * ============================================================================
 * WHY A SLIDING WINDOW AND NOT A FIXED ONE
 * ============================================================================
 * A fixed window lets a caller send `limit` requests at 11:59:59 and another
 * `limit` at 12:00:00 — a 2x burst straddling the boundary, which is exactly
 * the shape of a scrape. Keeping the timestamps costs at most `limit` numbers
 * per key (30-120 here) and makes `Retry-After` exact rather than a guess at
 * "time until the window resets".
 */

/** Keys held before eviction kicks in. At ~120 numbers per key worst case
 *  this bounds the store to a few MB — a ceiling, not an expected size. */
const MAX_KEYS = 10_000;

/** A key untouched for this long cannot be inside any window we define (the
 *  longest is 60s), so it is safe to drop during a sweep. */
const STALE_MS = 3_600_000;

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, number[]>();

  async hit(key: string, rule: RateLimitRule, nowMs: number): Promise<RateLimitDecision> {
    const windowMs = rule.windowSeconds * 1000;
    const cutoff = nowMs - windowMs;

    const existing = this.buckets.get(key) ?? [];
    // Drop everything that has aged out of the window.
    const timestamps = existing.filter((at) => at > cutoff);

    if (timestamps.length >= rule.limit) {
      // The window frees a slot when its OLDEST entry ages out.
      const oldest = timestamps[0];
      const retryAfterMs = oldest + windowMs - nowMs;
      this.touch(key, timestamps);
      return {
        allowed: false,
        limit: rule.limit,
        remaining: 0,
        // Never 0 — that invites an immediate retry guaranteed to fail again.
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      };
    }

    timestamps.push(nowMs);
    this.touch(key, timestamps);
    this.evictIfNeeded(nowMs);

    return {
      allowed: true,
      limit: rule.limit,
      remaining: rule.limit - timestamps.length,
      retryAfterSeconds: 0,
    };
  }

  /** Re-inserting (rather than overwriting) moves the key to the end of the
   *  Map's iteration order, which turns plain insertion order into LRU order
   *  for free — `evictIfNeeded` then just walks from the front. A JS Map's
   *  `set` on an EXISTING key does not reorder it, so the delete is required. */
  private touch(key: string, timestamps: number[]): void {
    this.buckets.delete(key);
    this.buckets.set(key, timestamps);
  }

  /** Only runs when over the cap, so the common path stays O(1). */
  private evictIfNeeded(nowMs: number): void {
    if (this.buckets.size <= MAX_KEYS) return;

    for (const [key, timestamps] of this.buckets) {
      const newest = timestamps[timestamps.length - 1] ?? 0;
      if (newest <= nowMs - STALE_MS) this.buckets.delete(key);
    }

    // Still over after dropping stale keys: evict least-recently-used.
    while (this.buckets.size > MAX_KEYS) {
      const oldestKey = this.buckets.keys().next().value;
      if (oldestKey === undefined) break;
      this.buckets.delete(oldestKey);
    }
  }

  /** Test seam only. */
  reset(): void {
    this.buckets.clear();
  }

  /** Test seam only. */
  get size(): number {
    return this.buckets.size;
  }
}
