/**
 * The only error shape a lists Server Action is allowed to throw or return —
 * same contract `CommentError`/`AuthError` hold for their layers.
 */
export type ListErrorKind =
  | "invalid_input"
  | "not_found"
  | "not_authenticated"
  | "forbidden"
  | "rate_limited"
  | "not_configured"
  | "network"
  | "unknown";

export class ListError extends Error {
  readonly kind: ListErrorKind;

  constructor(kind: ListErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ListError";
    this.kind = kind;
  }
}

/** Never an upstream Postgres/PostgREST message — same rule
 *  `handleRouteError`/`commentErrorMessage` apply: a raw database error can
 *  leak column names or, worse, tell an attacker exactly which RLS check
 *  they tripped. */
export const SAFE_LIST_MESSAGE: Record<ListErrorKind, string> = {
  invalid_input: "Check what you entered and try again.",
  not_found: "That list no longer exists, or you don't have access to it.",
  not_authenticated: "Sign in to continue.",
  forbidden: "You can't do that here.",
  rate_limited: "Slow down a little — try again in a minute.",
  not_configured: "Lists aren't available on this deployment.",
  network: "Couldn't reach the server. Check your connection.",
  unknown: "Something went wrong. Try again.",
};

export function listErrorMessage(error: unknown): string {
  if (error instanceof ListError) return SAFE_LIST_MESSAGE[error.kind];
  return SAFE_LIST_MESSAGE.unknown;
}

/**
 * Maps a Supabase/PostgREST failure onto a `ListErrorKind`. Pure and
 * deliberately NOT `server-only` — same reasoning as
 * `lib/comments/errors.ts`'s `mapCommentError`: this is the layer real RLS
 * rejections exercise and no mock data can, so it needs to be unit-testable
 * against realistic error shapes without a live database.
 */
export function mapListError(error: unknown): ListError {
  if (error instanceof ListError) return error;

  const candidate = (error ?? {}) as { code?: string; message?: string; name?: string };
  const code = candidate.code;
  const message = typeof candidate.message === "string" ? candidate.message : "";
  const detail = `[lists] ${code ?? "no-code"}: ${message}`;

  if (code === "42501") return new ListError("forbidden", detail, { cause: error });
  if (code === "23514" || code === "23502") {
    return new ListError("invalid_input", detail, { cause: error });
  }
  if (code === "PGRST116") return new ListError("not_found", detail, { cause: error });
  if (
    candidate.name === "AuthRetryableFetchError" ||
    candidate.name === "TypeError" ||
    /fetch|network|ECONN|ENOTFOUND/i.test(message)
  ) {
    return new ListError("network", detail, { cause: error });
  }

  return new ListError("unknown", detail, { cause: error });
}
