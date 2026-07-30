import "server-only";

import { ContentError } from "@/lib/content/errors";
import {
  BAD_REQUEST_MESSAGE,
  KIND_STATUS,
  SAFE_MESSAGE,
  type ApiErrorBody,
} from "@/lib/content/http/wire";
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
} as const;

export function jsonOk<T>(data: T, sMaxAge: number): Response {
  return Response.json(data, {
    headers: {
      "cache-control": `public, max-age=0, s-maxage=${sMaxAge}, stale-while-revalidate=${sMaxAge}`,
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
