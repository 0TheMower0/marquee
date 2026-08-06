/**
 * The only error shape an AuthProvider is allowed to throw — the same contract
 * `ContentError` holds for content providers, for the same reason: error UI is
 * written once, switches on `kind`, and works identically against the Supabase
 * implementation or the anonymous one.
 *
 * Note what is NOT here: no HTTP status, no upstream message field. Supabase's
 * own error strings are logged server-side and mapped to a `kind`; they are
 * never forwarded to the browser verbatim. That is the same rule
 * `handleRouteError` applies to TMDB messages (CLAUDE.md, "Route handlers never
 * forward an upstream message"), and it matters more here — auth error strings
 * are the classic accidental account-enumeration channel.
 */
export type AuthErrorKind =
  /** Wrong email or password. Deliberately does NOT distinguish "no such
   *  account" from "wrong password" — see SAFE_AUTH_MESSAGE. */
  | "invalid_credentials"
  /** The address already has an account. */
  | "email_taken"
  /** Password rejected by the project's strength policy. */
  | "weak_password"
  /** Malformed input that should have been caught client-side. */
  | "invalid_input"
  /** A session was required and there wasn't one. */
  | "not_authenticated"
  /** Supabase's own auth rate limiter (its email sending limits are strict). */
  | "rate_limited"
  /** No Supabase project is configured. The anonymous provider throws this for
   *  every mutation — it is the zero-config state, not a misconfiguration. */
  | "not_configured"
  | "network"
  | "unknown";

export class AuthError extends Error {
  readonly kind: AuthErrorKind;

  constructor(kind: AuthErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AuthError";
    this.kind = kind;
  }
}

/**
 * User-facing copy per kind. One place, so no call site invents its own
 * phrasing and accidentally leaks more than another does.
 *
 * `invalid_credentials` is deliberately vague. "No account with that email"
 * turns the sign-in form into an account-existence oracle: anyone can test
 * whether an address is registered here. Supabase itself returns one
 * indistinguishable error for both cases, and this preserves that rather than
 * helpfully undoing it.
 */
export const SAFE_AUTH_MESSAGE: Record<AuthErrorKind, string> = {
  invalid_credentials: "That email and password don't match an account.",
  email_taken: "An account already exists for that email.",
  weak_password: "That password is too weak. Use at least 8 characters.",
  invalid_input: "Check the details you entered and try again.",
  not_authenticated: "You need to be signed in to do that.",
  rate_limited: "Too many attempts. Wait a minute and try again.",
  not_configured: "Accounts aren't available on this deployment.",
  network: "Couldn't reach the account service. Check your connection.",
  unknown: "Something went wrong. Try again.",
};

/** Narrow an unknown thrown value to user-facing copy without ever surfacing
 *  the original message. */
export function authErrorMessage(error: unknown): string {
  if (error instanceof AuthError) return SAFE_AUTH_MESSAGE[error.kind];
  return SAFE_AUTH_MESSAGE.unknown;
}
