/**
 * Rate limiting contracts for the public `app/api/content/*` surface.
 *
 * Deliberately has NO `import "server-only"`, for the same reason
 * `lib/content/omdb/normalize.ts` and `lib/content/http/wire.ts` don't: there
 * is no credential anywhere in this package, it's pure counting logic, and the
 * guard would make it un-unit-testable. Nothing here is imported by client
 * code — the `server-only` boundary that matters already sits on
 * `lib/api/respond.ts`.
 */

/** One limit: `limit` requests per `windowSeconds`, per key. */
export interface RateLimitRule {
  /** Namespaces the counter, so `search` and `ratings` never share a bucket
   *  for the same IP. */
  name: string;
  limit: number;
  windowSeconds: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  /** Requests still available in the current window. 0 when denied. */
  remaining: number;
  /**
   * Whole seconds until the window frees at least one slot. Always >= 1 when
   * denied, because a `Retry-After: 0` invites an immediate retry that is
   * guaranteed to fail again.
   */
  retryAfterSeconds: number;
}

/**
 * The swap point, mirroring `StorageDriver` in lib/storage.
 *
 * The in-process implementation is per-instance, which on serverless means the
 * effective limit multiplies by the number of warm instances (see the doc
 * comment on `MemoryRateLimitStore`). Replacing it with Redis/Upstash later is
 * one more implementation of this interface plus a line in `limiter.ts` — no
 * route handler moves. Async from the start precisely so that swap needs no
 * call-site changes, the same reasoning `StorageDriver` documents.
 */
export interface RateLimitStore {
  /**
   * Records a hit against `key` and reports whether it is allowed. MUST be
   * atomic per key: check-then-record as two steps would let concurrent
   * requests both observe "under the limit" and both proceed.
   */
  hit(key: string, rule: RateLimitRule, nowMs: number): Promise<RateLimitDecision>;
}
