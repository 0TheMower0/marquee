import type {
  AuthAccount,
  OAuthProviderId,
  SignInInput,
  SignUpInput,
  SignUpResult,
  UsernameResult,
} from "./types";

/**
 * The auth abstraction, deliberately shaped like `ContentProvider`.
 *
 * Two implementations, selected by `getAuthProvider()`:
 *
 *   - `anonymousAuthProvider` — reports "never signed in" and refuses every
 *     mutation with `AuthError('not_configured')`. This is the DEFAULT, active
 *     whenever no Supabase project is configured.
 *   - `supabaseAuthProvider` — the real one.
 *
 * The anonymous implementation is not a stub or a test double; it is the
 * production behaviour of a Marquee deployment with no `.env` file, which
 * CLAUDE.md has promised since Phase 1 and the sync design doc reaffirms in
 * §8. Making "signed out forever" a real implementation of the same interface
 * means the account layer is *inert* rather than *broken* when unconfigured —
 * exactly how `getContentProvider()` defaults to `mock`.
 *
 * ============================================================================
 * WHY EVERY METHOD IS ASYNC AND SERVER-SIDE
 * ============================================================================
 * Session cookies can only be written from a Server Function or a Route
 * Handler (Next 16 `cookies` reference: "HTTP does not allow setting cookies
 * after streaming starts"). So the provider is constructed per request against
 * the request's own cookie store, and mutations are reached from the browser
 * through Server Actions in `actions.ts`. That is the same shape as the
 * client-data seam in Phase 2 Step 1 — one interface, one transport hop — with
 * Server Actions standing in for `app/api/content/*`.
 */
export interface AuthProvider {
  /**
   * The signed-in account, or `null` when signed out.
   *
   * `null` is an ordinary state and must never be treated as an error: it is
   * what every anonymous visitor gets, which is most of them. Callers that
   * genuinely require a user throw `AuthError('not_authenticated')`
   * themselves rather than having this method do it for them.
   *
   * Verifies the token against the auth server rather than trusting the
   * cookie's contents. The cookie is user-controlled; a decoded-but-unverified
   * JWT is a claim, not a fact.
   */
  getAccount(): Promise<AuthAccount | null>;

  signUp(input: SignUpInput): Promise<SignUpResult>;

  signInWithPassword(input: SignInInput): Promise<void>;

  /**
   * Returns the URL to send the browser to. It does NOT redirect — redirecting
   * is the caller's job, because a Server Action and a Route Handler redirect
   * differently and the provider should not need to know which one it is in.
   */
  signInWithOAuth(
    provider: OAuthProviderId,
    redirectTo: string,
  ): Promise<{ url: string }>;

  signOut(): Promise<void>;

  /**
   * Sends the reset email. Resolves successfully even for an address with no
   * account — deliberately. Reporting "no such user" here would make this
   * endpoint an account-existence oracle, undoing the care taken over
   * `invalid_credentials`. The UI says "if that address has an account, a link
   * is on its way" for the same reason.
   */
  requestPasswordReset(email: string, redirectTo: string): Promise<void>;

  /** Requires an active session — including the short-lived one a recovery
   *  link establishes, which is how "forgot password" terminates. */
  updatePassword(newPassword: string): Promise<void>;

  /** Re-send the confirmation email. Same non-disclosure contract as
   *  `requestPasswordReset`. */
  resendVerification(email: string): Promise<void>;

  /**
   * Create the profile row if it doesn't exist yet, claiming the username the
   * user asked for at sign-up, or a generated placeholder if that name is gone
   * or was never supplied (OAuth).
   *
   * Idempotent, and called on every authenticated entry point rather than once
   * at sign-up: a profile row is created by the app as the user, under the
   * ordinary `profiles_insert_self` policy, so there is no privileged
   * bootstrap path and no `security definer` trigger to audit. The cost is
   * that the row appears one request later than the user does, which is why
   * `AuthAccount.profile` is nullable.
   */
  ensureProfile(): Promise<AuthAccount>;

  /** Change the username. Returns a result rather than throwing on `taken`,
   *  because a taken name is an ordinary form outcome. */
  setUsername(username: string): Promise<UsernameResult>;

  /**
   * Whether a username is free. A courtesy for the sign-up form, NOT the
   * uniqueness mechanism — the unique index is (see `username.ts`). Callable
   * while signed out, which is why it goes through an RPC rather than
   * selecting from `profiles` (that table is readable by authenticated users
   * only).
   */
  isUsernameAvailable(username: string): Promise<boolean>;
}
