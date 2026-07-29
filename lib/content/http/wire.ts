import type { ContentErrorKind } from "../errors";

/**
 * The wire contract between `app/api/content/*` and `httpProvider`.
 *
 * Deliberately has NO `import "server-only"`: this is shared by the route
 * handlers (server) and by httpProvider (client). It contains only types and
 * constants — never a provider, a credential, or a fetch.
 *
 * Both sides importing the same file is the point. If the error envelope ever
 * changes shape, it changes in one place and both ends move together.
 */

/** The only error body shape the API is allowed to return. */
export interface ApiErrorBody {
  error: {
    kind: ContentErrorKind;
    message: string;
  };
}

const KINDS: readonly ContentErrorKind[] = [
  "not_found",
  "unauthorized",
  "rate_limited",
  "network",
  "unknown",
];

export function isContentErrorKind(value: unknown): value is ContentErrorKind {
  return typeof value === "string" && KINDS.includes(value as ContentErrorKind);
}

/**
 * `kind` -> HTTP status.
 *
 * `unauthorized` maps to **502, not 401**, and that is deliberate. The caller
 * is not unauthorized — our server's upstream credential is. Returning 401
 * would misdescribe whose problem it is, and can make a browser surface a
 * credential prompt for a request that has no user auth at all.
 */
export const KIND_STATUS: Record<ContentErrorKind, number> = {
  not_found: 404,
  unauthorized: 502,
  rate_limited: 429,
  network: 504,
  unknown: 500,
};

/**
 * Fallback used by httpProvider when a non-OK response is *not* our envelope —
 * a CDN error page, a proxy timeout, an HTML 502 from infrastructure that
 * never reached the route handler at all.
 */
export function kindFromStatus(status: number): ContentErrorKind {
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status === 408 || status === 502 || status === 504) return "network";
  return "unknown";
}

/**
 * The ONLY messages the API sends to a client.
 *
 * Provider error messages are not safe to forward: `tmdbProvider` folds TMDB's
 * own `status_message` into `ContentError.message`, which is upstream detail
 * about our server's configuration. Route handlers send these fixed strings
 * instead and log the real error server-side.
 */
export const SAFE_MESSAGE: Record<ContentErrorKind, string> = {
  not_found: "The requested title could not be found.",
  unauthorized: "The content source rejected the request.",
  rate_limited: "Too many requests to the content source.",
  network: "The content source could not be reached.",
  unknown: "The request could not be completed.",
};

/** Sent for malformed input. Kept separate so it can't be confused with a
 *  provider failure — see the note on validation in lib/api/validate.ts. */
export const BAD_REQUEST_MESSAGE = "Invalid request parameters.";
