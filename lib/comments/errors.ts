/**
 * The only error shape a comments Server Action is allowed to throw or
 * return — same contract `AuthError`/`ContentError` hold for their layers, so
 * `components/comments/*` can switch on `kind` once instead of every call
 * site inventing its own error copy.
 */
export type CommentErrorKind =
  | "invalid_input"
  | "not_found"
  | "not_authenticated"
  | "forbidden"
  | "rate_limited"
  | "not_configured"
  | "network"
  | "unknown";

export class CommentError extends Error {
  readonly kind: CommentErrorKind;

  constructor(kind: CommentErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CommentError";
    this.kind = kind;
  }
}

/**
 * User-facing copy per kind — never an upstream Postgres/PostgREST message.
 * Same rule `handleRouteError` applies to TMDB's `status_message`: a raw
 * database error can leak column names, constraint internals, or (worse) tell
 * an attacker exactly which RLS check they tripped, which is itself
 * information about a scope's spoiler-gating state.
 */
export const SAFE_COMMENT_MESSAGE: Record<CommentErrorKind, string> = {
  invalid_input: "Check your comment and try again.",
  not_found: "That comment no longer exists.",
  not_authenticated: "Sign in to join the discussion.",
  forbidden: "You can't do that here.",
  rate_limited: "Slow down a little — try again in a minute.",
  not_configured: "Comments aren't available on this deployment.",
  network: "Couldn't reach the server. Check your connection.",
  unknown: "Something went wrong. Try again.",
};

export function commentErrorMessage(error: unknown): string {
  if (error instanceof CommentError) return SAFE_COMMENT_MESSAGE[error.kind];
  return SAFE_COMMENT_MESSAGE.unknown;
}

/**
 * Maps a Supabase/PostgREST failure onto a `CommentErrorKind`.
 *
 * Pure and deliberately NOT `server-only` — same reasoning as
 * `lib/auth/supabase/map-error.ts`: this is the layer real RLS rejections
 * exercise and no mock data can, so it needs to be unit-testable against
 * realistic error shapes without a live database.
 *
 * The RLS policies in `20260809000001_comments.sql` reject a disallowed
 * write with Postgres code `42501` (insufficient privilege) — that is what a
 * failed `WITH CHECK` surfaces as. A CHECK constraint violation (bad reason
 * enum, empty body slipping past client validation) is `23514`. Both map to
 * `forbidden`/`invalid_input` respectively; neither should ever reach the
 * user as raw SQL.
 */
export function mapCommentError(error: unknown): CommentError {
  if (error instanceof CommentError) return error;

  const candidate = (error ?? {}) as { code?: string; message?: string; name?: string };
  const code = candidate.code;
  const message = typeof candidate.message === "string" ? candidate.message : "";
  const detail = `[comments] ${code ?? "no-code"}: ${message}`;

  if (code === "42501") return new CommentError("forbidden", detail, { cause: error });
  if (code === "23514" || code === "23502") {
    return new CommentError("invalid_input", detail, { cause: error });
  }
  if (code === "PGRST116") return new CommentError("not_found", detail, { cause: error });
  if (
    candidate.name === "AuthRetryableFetchError" ||
    candidate.name === "TypeError" ||
    /fetch|network|ECONN|ENOTFOUND/i.test(message)
  ) {
    return new CommentError("network", detail, { cause: error });
  }

  return new CommentError("unknown", detail, { cause: error });
}
