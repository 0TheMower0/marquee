import { AuthError, type AuthErrorKind } from "../errors";

/**
 * Supabase auth failure -> `AuthErrorKind`.
 *
 * Pure, and deliberately NOT `server-only` — same reasoning as
 * `lib/content/omdb/normalize.ts` and `lib/content/http/wire.ts`: it holds no
 * credential, it is the layer real data exercises and mock data cannot, and
 * it needs to be unit-testable without standing up an auth server. There is
 * no local Supabase stack to test against here (no Docker), which makes
 * covering this mapping with tests over realistic payloads the *only* way it
 * gets exercised at all before a real project is connected.
 *
 * ============================================================================
 * WHY `code` FIRST, `status` SECOND, MESSAGE LAST
 * ============================================================================
 * `AuthApiError.code` is GoTrue's stable machine-readable identifier and is
 * the only field intended to be branched on. `status` is coarse — 400 covers
 * bad credentials, a weak password, and a malformed email alike. The message
 * is human-facing English that changes without notice, so matching on it is a
 * latent break; it is used only as a last resort for older responses that
 * predate `code`, and every such match is a substring test rather than an
 * equality test for exactly that reason.
 *
 * Anything unrecognized becomes `unknown`, never a guess. A wrong `kind` shows
 * the user confidently incorrect advice ("that password is too weak" when the
 * real problem was connectivity), which is worse than the generic message.
 */

interface SupabaseLikeError {
  code?: string;
  status?: number;
  message?: string;
  name?: string;
}

/** GoTrue error codes, mapped to our kinds. */
const CODE_KIND: Record<string, AuthErrorKind> = {
  invalid_credentials: "invalid_credentials",
  // GoTrue reports an unconfirmed address as its own code rather than as bad
  // credentials. Mapped to invalid_credentials on purpose: see below.
  email_not_confirmed: "invalid_credentials",
  user_already_exists: "email_taken",
  email_exists: "email_taken",
  weak_password: "weak_password",
  validation_failed: "invalid_input",
  bad_json: "invalid_input",
  over_request_rate_limit: "rate_limited",
  over_email_send_rate_limit: "rate_limited",
  over_sms_send_rate_limit: "rate_limited",
  session_not_found: "not_authenticated",
  no_authorization: "not_authenticated",
  session_expired: "not_authenticated",
  refresh_token_not_found: "not_authenticated",
  same_password: "invalid_input",
};

/**
 * `email_not_confirmed` collapsing into `invalid_credentials` is a deliberate
 * privacy choice, not laziness.
 *
 * Distinguishing it tells an attacker "this address HAS an account, it just
 * isn't confirmed" — the exact account-existence disclosure the vague
 * `invalid_credentials` copy exists to prevent, arriving through a side door.
 * The cost is a genuine user who forgot to click the link seeing unhelpful
 * copy; that is paid for by the sign-in form always offering "resend
 * confirmation email" rather than only offering it when we can prove it is
 * needed.
 */

export function mapSupabaseAuthError(error: unknown): AuthError {
  if (error instanceof AuthError) return error;

  const candidate = (error ?? {}) as SupabaseLikeError;
  const code = typeof candidate.code === "string" ? candidate.code : undefined;
  const status = typeof candidate.status === "number" ? candidate.status : undefined;
  const message = typeof candidate.message === "string" ? candidate.message : "";

  const detail = `[supabase] ${code ?? "no-code"} ${status ?? "no-status"}: ${message}`;

  if (code && code in CODE_KIND) {
    return new AuthError(CODE_KIND[code], detail, { cause: error });
  }

  // A fetch failure surfaces as `AuthRetryableFetchError` with status 0 (or no
  // status at all) rather than as a code, so it has to be caught by shape.
  if (
    candidate.name === "AuthRetryableFetchError" ||
    candidate.name === "TypeError" ||
    status === 0 ||
    (status === undefined && /fetch|network|ECONN|ENOTFOUND/i.test(message))
  ) {
    return new AuthError("network", detail, { cause: error });
  }

  if (status === 429) return new AuthError("rate_limited", detail, { cause: error });
  if (status === 401 || status === 403) {
    return new AuthError("not_authenticated", detail, { cause: error });
  }
  if (status !== undefined && status >= 500) {
    return new AuthError("network", detail, { cause: error });
  }

  // Last resort, for responses predating `code`. Substring, never equality.
  const lower = message.toLowerCase();
  if (lower.includes("already registered") || lower.includes("already been registered")) {
    return new AuthError("email_taken", detail, { cause: error });
  }
  if (lower.includes("invalid login credentials")) {
    return new AuthError("invalid_credentials", detail, { cause: error });
  }
  if (lower.includes("password should be") || lower.includes("password is too weak")) {
    return new AuthError("weak_password", detail, { cause: error });
  }

  return new AuthError("unknown", detail, { cause: error });
}

/**
 * Postgres unique-violation detection, for the `lower(username)` index.
 *
 * PostgREST forwards the SQLSTATE as `code`, so `23505` is the exact and only
 * signal that a username was taken between the availability check and the
 * write. Matching the constraint name instead would break the moment the index
 * is renamed, and matching the message would break on a Postgres locale
 * change.
 */
export function isUniqueViolation(error: unknown): boolean {
  const candidate = (error ?? {}) as { code?: string };
  return candidate.code === "23505";
}
