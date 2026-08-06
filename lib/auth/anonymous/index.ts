import { AuthError } from "../errors";
import type { AuthProvider } from "../provider";

/**
 * The provider for a deployment with no Supabase project configured.
 *
 * This is the DEFAULT and it is production behaviour, not a test double.
 * Marquee has promised since Phase 1 that it runs with no `.env` file at all;
 * with no Supabase URL and anon key, the account layer must be *inert* — the
 * app is exactly as functional as it was before Phase 6 existed.
 *
 * Read is the interesting half. `getAccount()` returns `null` rather than
 * throwing, because "nobody is signed in" is the honest answer and every
 * caller already handles it — that single decision is what keeps every account
 * -aware surface working unconfigured, with no `isSupabaseConfigured()` checks
 * sprinkled through the UI.
 *
 * Writes throw `not_configured` rather than silently no-op'ing. A sign-in form
 * that appears to work and does nothing is worse than one that says accounts
 * aren't available here; the UI's job is to not render the form in the first
 * place (see `isSupabaseConfigured()`), and this throw is the backstop for
 * when it does anyway.
 */
function unavailable(): never {
  throw new AuthError(
    "not_configured",
    "No Supabase project is configured; accounts are unavailable.",
  );
}

export const anonymousAuthProvider: AuthProvider = {
  async getAccount() {
    return null;
  },
  async signUp() {
    unavailable();
  },
  async signInWithPassword() {
    unavailable();
  },
  async signInWithOAuth() {
    unavailable();
  },
  async signOut() {
    // The one mutation that does NOT throw. "Sign out" when nobody is signed
    // in has already achieved its purpose, and making it throw would mean a
    // sign-out button had to know whether accounts exist. Idempotent success
    // is both correct and kinder.
  },
  async requestPasswordReset() {
    unavailable();
  },
  async updatePassword() {
    unavailable();
  },
  async resendVerification() {
    unavailable();
  },
  async ensureProfile() {
    throw new AuthError(
      "not_authenticated",
      "No session; there is no account to create a profile for.",
    );
  },
  async setUsername() {
    unavailable();
  },
  async isUsernameAvailable() {
    // Nothing can be taken when nothing can be registered. Returning `false`
    // here would make the sign-up form report every name as unavailable, which
    // reads as a bug rather than as "accounts are off".
    return true;
  },
};
