import "server-only";

import { ContentError } from "@/lib/content/errors";
import {
  BAD_REQUEST_MESSAGE,
  KIND_STATUS,
  RATE_LIMITED_MESSAGE,
  SAFE_MESSAGE,
  type ApiErrorBody,
} from "@/lib/content/http/wire";
import { checkRateLimit, type RateLimitRule } from "@/lib/ratelimit";
import { BadRequestError } from "./validate";

/**
 * Response construction for `app/api/content/*`.
 *
 * The single rule this file exists to enforce: **nothing about the upstream
 * failure crosses the wire.** Only our `kind` and a fixed message from
 * `SAFE_MESSAGE` are sent. The real error — including TMDB's own status
 * message, which `tmdbProvider` folds into `ContentError.message` — is logged
 * server-side and goes no further.
 */

/**
 * Cache lifetimes, mirroring the intent of `REVALIDATE` in
 * lib/content/tmdb/index.ts but applied at the HTTP edge instead of at the
 * TMDB fetch. Both layers matter: `REVALIDATE` saves TMDB API calls, this
 * saves round trips to our own server, and it applies in mock mode too.
 *
 * `max-age=0` keeps the browser honest (it always revalidates) while
 * `s-maxage` lets a CDN absorb the load — which is what actually matters for
 * a public surface. Nothing here is user-specific, so shared caching is safe.
 */
export const CACHE_SECONDS = {
  search: 300,
  trending: 3_600,
  detail: 86_400,
  related: 86_400,
  watchProviders: 43_200,
  /** 7 days, matching OMDB_REVALIDATE_SECONDS. OMDb's free tier is only
   *  1,000 requests/day, so this CDN layer is a real part of staying inside
   *  the quota rather than a nicety — see lib/content/omdb/client.ts. */
  ratings: 604_800,
  /**
   * 5 minutes, for the empty ratings response served once the daily OMDb
   * budget is spent (see lib/ratelimit/budget.ts).
   *
   * It MUST NOT reuse `ratings` above: caching a degraded "no external
   * ratings" answer for 7 days would keep serving it long after the budget
   * resets at midnight UTC, turning a few hours of throttling into a week of
   * missing data. Short enough to recover promptly, long enough that the
   * degraded path itself can't become a load source.
   */
  ratingsDegraded: 300,
} as const;

export function jsonOk<T>(data: T, sMaxAge: number): Response {
  return Response.json(data, {
    headers: {
      "cache-control": `public, max-age=0, s-maxage=${sMaxAge}, stale-while-revalidate=${sMaxAge}`,
    },
  });
}

/**
 * The rate-limit guard every `app/api/content/*` handler runs first.
 *
 * Returns a ready-to-send 429 when the caller is over their limit, or `null`
 * to proceed — so the call site reads:
 *
 *     const limited = await enforceRateLimit(request, RATE_LIMITS.search);
 *     if (limited) return limited;
 *
 * An explicit call rather than a wrapper HOF, matching `handleRouteError`'s
 * existing idiom in these same files: it is greppable, it keeps the rule
 * choice visible in the route it applies to, and it does not obscure the
 * handler's signature (which Next's generated `RouteContext<>` types depend
 * on).
 */
export async function enforceRateLimit(
  request: Request,
  rule: RateLimitRule,
): Promise<Response | null> {
  const decision = await checkRateLimit(request, rule);
  if (decision.allowed) return null;

  const body: ApiErrorBody = {
    error: { kind: "rate_limited", message: RATE_LIMITED_MESSAGE },
  };

  return Response.json(body, {
    status: 429,
    headers: {
      // The one header a well-behaved client actually acts on. Seconds, per
      // RFC 9110 — `checkRateLimit` guarantees it is never 0, since a
      // `Retry-After: 0` invites an immediate retry certain to fail again.
      "retry-after": String(decision.retryAfterSeconds),
      // draft-ietf-httpapi-ratelimit-headers, widely understood by tooling.
      "ratelimit-limit": String(decision.limit),
      "ratelimit-remaining": "0",
      "ratelimit-reset": String(decision.retryAfterSeconds),
      // MUST NOT be cached. A CDN that cached one caller's 429 would serve it
      // to every other caller for its lifetime — turning a per-IP limit into
      // an outage for everyone sharing that edge.
      "cache-control": "no-store",
    },
  });
}

function jsonError(
  kind: ApiErrorBody["error"]["kind"],
  status: number,
  message: string,
): Response {
  const body: ApiErrorBody = { error: { kind, message } };
  return Response.json(body, {
    status,
    // An error must never be cached — a transient upstream blip would
    // otherwise be served to every subsequent caller for the full lifetime.
    headers: { "cache-control": "no-store" },
  });
}

/**
 * The only `catch` a route handler needs. Every route funnels through this so
 * no handler can accidentally invent its own error shape or forward a raw
 * message.
 */
export function handleRouteError(error: unknown, context: string): Response {
  if (error instanceof BadRequestError) {
    // Safe to echo: this message describes the caller's own input constraints
    // and contains nothing about our server or the upstream source.
    return jsonError("unknown", 400, `${BAD_REQUEST_MESSAGE} ${error.message}`);
  }

  if (error instanceof ContentError) {
    // error.message may embed TMDB's status_message — logged, never sent.
    console.error(`[api/content] ${context} failed:`, error.kind, error.message);
    return jsonError(error.kind, KIND_STATUS[error.kind], SAFE_MESSAGE[error.kind]);
  }

  // A provider is contractually allowed to throw only ContentError, so
  // reaching here means a genuine bug. Log loudly, tell the client nothing.
  console.error(`[api/content] ${context} threw a non-ContentError:`, error);
  return jsonError("unknown", 500, SAFE_MESSAGE.unknown);
}
