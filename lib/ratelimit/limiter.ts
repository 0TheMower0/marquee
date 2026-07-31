import { clientIp } from "./client-ip";
import { MemoryRateLimitStore } from "./memory-store";
import type { RateLimitDecision, RateLimitRule, RateLimitStore } from "./types";

/**
 * The single process-wide store. Swapping in Redis later replaces exactly this
 * line — every call site goes through `checkRateLimit` and none of them know
 * which implementation is behind it (the same arrangement `drivers.ts` uses to
 * keep lib/storage's IndexedDB path open).
 */
const store: RateLimitStore = new MemoryRateLimitStore();

/**
 * Escape hatch for local load testing. Deliberately NOT `NEXT_PUBLIC_` — it
 * must never be settable from, or visible to, a browser. Off unless explicitly
 * set to "1", so the limiter is active in development too: a limiter that only
 * runs in production is a limiter whose bugs are found in production.
 */
function isDisabled(): boolean {
  return process.env.RATE_LIMIT_DISABLED === "1";
}

const ALWAYS_ALLOWED: RateLimitDecision = {
  allowed: true,
  limit: 0,
  remaining: 0,
  retryAfterSeconds: 0,
};

/**
 * Records a hit for this request against `rule` and reports the decision.
 *
 * Callers with no resolvable IP share a single `unknown` bucket rather than
 * being waved through. That direction matters: letting them through would
 * make "strip your `X-Forwarded-For`" a one-header bypass of the whole
 * limiter. Sharing a bucket can throttle unrelated anonymous callers
 * together, which is the correct trade for a public, unauthenticated surface.
 *
 * `nowMs` is injectable so the window behaviour is testable against fixed
 * inputs, the same pattern `lib/watchlog`'s queries use for `today`.
 */
export async function checkRateLimit(
  request: Request,
  rule: RateLimitRule,
  nowMs: number = Date.now(),
): Promise<RateLimitDecision> {
  if (isDisabled()) return ALWAYS_ALLOWED;

  const ip = clientIp(request.headers) ?? "unknown";
  return store.hit(`${rule.name}:${ip}`, rule, nowMs);
}
