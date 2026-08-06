import "server-only";

import type { SupabaseClient, User } from "@supabase/supabase-js";

import { createSupabaseServerClient } from "@/lib/supabase/server-client";

import { AuthError } from "../errors";
import type { AuthProvider } from "../provider";
import type {
  AuthAccount,
  AuthProfile,
  AuthUser,
  OAuthProviderId,
  SignInInput,
  SignUpInput,
  SignUpResult,
  UsernameResult,
} from "../types";
import {
  fallbackUsername,
  randomHex,
  validateUsername,
} from "../username";
import { isUniqueViolation, mapSupabaseAuthError } from "./map-error";

/** Columns of `public.profiles` this app reads. Explicit rather than `*`, the
 *  same allowlist discipline `toTrackingSummary()` uses — a column added later
 *  (a private one would be a policy violation, but still) cannot start
 *  arriving in the client payload without someone deciding it should. */
const PROFILE_COLUMNS = "id, username, display_name";

interface ProfileRow {
  id: string;
  username: string;
  display_name: string | null;
}

function toAuthUser(user: User): AuthUser {
  return {
    id: user.id,
    email: user.email ?? null,
    // GoTrue sets `email_confirmed_at` only once the address is verified.
    // `confirmed_at` also covers phone confirmation, which this app doesn't
    // use — reading the email-specific field keeps the flag meaning what its
    // name says.
    emailVerified: Boolean(user.email_confirmed_at),
    createdAt: new Date(user.created_at),
  };
}

function toAuthProfile(row: ProfileRow): AuthProfile {
  return { id: row.id, username: row.username, displayName: row.display_name };
}

async function fetchProfile(
  supabase: SupabaseClient,
  userId: string,
): Promise<AuthProfile | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select(PROFILE_COLUMNS)
    .eq("id", userId)
    .maybeSingle<ProfileRow>();

  // A missing profile row is an ordinary state (see AuthAccount.profile), and
  // `maybeSingle` reports it as `data: null` with no error. A real error here
  // is logged and degraded to null rather than thrown: failing to read the
  // profile must not log the user out.
  if (error) {
    console.error("[auth] failed to read profile", error);
    return null;
  }
  return data ? toAuthProfile(data) : null;
}

export const supabaseAuthProvider: AuthProvider = {
  async getAccount(): Promise<AuthAccount | null> {
    const supabase = await createSupabaseServerClient();

    // getUser(), not getSession(). getSession() returns whatever the cookie
    // decodes to WITHOUT verifying the JWT signature against the auth server,
    // so on the server it is a user-supplied claim rather than a fact —
    // anyone could hand-craft a cookie asserting any user id. getUser() costs
    // a round trip and is the only correct choice server-side.
    const { data, error } = await supabase.auth.getUser();

    if (error || !data.user) {
      // No session is by far the most common case here (every anonymous
      // visitor) and is emphatically not an error condition — see the note on
      // AuthProvider.getAccount.
      return null;
    }

    const user = toAuthUser(data.user);
    return { user, profile: await fetchProfile(supabase, user.id) };
  },

  async signUp({ email, password, username }: SignUpInput): Promise<SignUpResult> {
    const supabase = await createSupabaseServerClient();

    const checked = validateUsername(username);
    if (!checked.ok) {
      throw new AuthError("invalid_input", `invalid username: ${checked.reason}`);
    }

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        // Carried on the user until the profile row is created, which may be
        // minutes later if email confirmation is on. There is no privileged
        // trigger writing `profiles` (see ensureProfile), so this metadata is
        // how the chosen name survives the gap.
        data: { username: checked.value },
        emailRedirectTo: `${siteUrl()}/auth/callback`,
      },
    });

    if (error) throw mapSupabaseAuthError(error);

    // ========================================================================
    // AN ALREADY-REGISTERED EMAIL IS NOT REPORTED AS AN ERROR, DELIBERATELY
    // ========================================================================
    // With email confirmation enabled, GoTrue answers a signup for an existing
    // address with a *fake* user carrying an empty `identities` array, rather
    // than an error, specifically so the form cannot be used to enumerate
    // registered addresses. Detecting that and showing "email already taken"
    // would hand back the exact disclosure Supabase went out of its way to
    // withhold — and the same one `invalid_credentials` copy is vague to
    // avoid. So this is left alone: both cases say "check your inbox", and the
    // real account holder gets an email telling them someone tried.
    return { needsEmailVerification: data.session === null };
  },

  async signInWithPassword({ email, password }: SignInInput): Promise<void> {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw mapSupabaseAuthError(error);
  },

  async signInWithOAuth(
    provider: OAuthProviderId,
    redirectTo: string,
  ): Promise<{ url: string }> {
    const supabase = await createSupabaseServerClient();

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo,
        // We are on the server; there is no browser to redirect. The caller
        // performs the redirect so the provider stays agnostic about whether
        // it is running inside a Server Action or a Route Handler, which
        // redirect differently.
        skipBrowserRedirect: true,
      },
    });

    if (error) throw mapSupabaseAuthError(error);
    if (!data.url) {
      throw new AuthError("unknown", "OAuth provider returned no redirect URL");
    }
    return { url: data.url };
  },

  async signOut(): Promise<void> {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.signOut();
    if (error) throw mapSupabaseAuthError(error);
  },

  async requestPasswordReset(email: string, redirectTo: string): Promise<void> {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });

    if (error) {
      const mapped = mapSupabaseAuthError(error);
      // Rate limiting and connectivity are worth telling the user about:
      // they are actionable and reveal nothing. Everything else is swallowed,
      // because the only remaining information it could carry is whether an
      // account exists for that address.
      if (mapped.kind === "rate_limited" || mapped.kind === "network") throw mapped;
      console.error("[auth] password reset request failed", mapped.message);
    }
  },

  async updatePassword(newPassword: string): Promise<void> {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) throw mapSupabaseAuthError(error);
  },

  async resendVerification(email: string): Promise<void> {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.resend({
      type: "signup",
      email,
      options: { emailRedirectTo: `${siteUrl()}/auth/callback` },
    });

    if (error) {
      const mapped = mapSupabaseAuthError(error);
      if (mapped.kind === "rate_limited" || mapped.kind === "network") throw mapped;
      console.error("[auth] resend verification failed", mapped.message);
    }
  },

  async ensureProfile(): Promise<AuthAccount> {
    const supabase = await createSupabaseServerClient();

    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
      throw new AuthError("not_authenticated", "no session");
    }

    const user = toAuthUser(data.user);
    const existing = await fetchProfile(supabase, user.id);
    if (existing) return { user, profile: existing };

    // The name asked for at sign-up, if there was one and it is still legal.
    // Re-validated rather than trusted: user metadata is user-controlled and
    // could have been set directly through the auth API.
    const desired = data.user.user_metadata?.username;
    const checked =
      typeof desired === "string" ? validateUsername(desired) : ({ ok: false } as const);

    // Candidates in order. If the wanted name is gone by the time we get here
    // — the sign-up availability check is a courtesy, not a lock — fall
    // through to obviously-generated placeholders the account page invites
    // renaming. Signing up must never fail because a name was taken during
    // the minutes spent in an inbox.
    const candidates = [
      ...(checked.ok ? [checked.value] : []),
      fallbackUsername(randomHex()),
      fallbackUsername(randomHex()),
      fallbackUsername(randomHex()),
    ];

    for (const candidate of candidates) {
      const { data: inserted, error: insertError } = await supabase
        .from("profiles")
        .insert({ id: user.id, username: candidate })
        .select(PROFILE_COLUMNS)
        .single<ProfileRow>();

      if (!insertError && inserted) {
        return { user, profile: toAuthProfile(inserted) };
      }

      if (!isUniqueViolation(insertError)) {
        throw mapSupabaseAuthError(insertError);
      }

      // 23505 covers BOTH unique indexes on this table: `lower(username)` and
      // the primary key. The second means a concurrent request already
      // created this user's profile, so re-reading is the correct resolution
      // and retrying with a different username would be wrong. Re-select
      // rather than inspecting the constraint name, which would break the
      // moment an index is renamed.
      const raced = await fetchProfile(supabase, user.id);
      if (raced) return { user, profile: raced };
    }

    throw new AuthError(
      "unknown",
      "could not claim a username after several attempts",
    );
  },

  async setUsername(username: string): Promise<UsernameResult> {
    const supabase = await createSupabaseServerClient();

    const checked = validateUsername(username);
    if (!checked.ok) return { ok: false, reason: checked.reason };

    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw new AuthError("not_authenticated", "no session");

    const { error: updateError } = await supabase
      .from("profiles")
      .update({ username: checked.value })
      .eq("id", data.user.id);

    // Taken is a form outcome, not an exception — the caller re-renders the
    // field with a message rather than showing an error panel.
    if (isUniqueViolation(updateError)) return { ok: false, reason: "taken" };
    if (updateError) throw mapSupabaseAuthError(updateError);

    return { ok: true, username: checked.value };
  },

  async isUsernameAvailable(username: string): Promise<boolean> {
    const supabase = await createSupabaseServerClient();

    const checked = validateUsername(username);
    if (!checked.ok) return false;

    // An RPC rather than a select, because this runs while signed OUT and
    // `profiles` is readable by authenticated users only. The function is
    // `security definer` and returns a bare boolean — see the migration.
    const { data, error } = await supabase.rpc("username_available", {
      candidate: checked.value,
    });

    if (error) {
      // Degrade to "available". The unique index is the real gate, so the
      // worst case is the user submits and is told it is taken — whereas
      // reporting every name as unavailable when the RPC is missing would
      // make the form unusable and look like a bug.
      console.error("[auth] username_available rpc failed", error);
      return true;
    }
    return data === true;
  },
};

/**
 * Absolute origin for links Supabase emails to the user.
 *
 * Read lazily (never at module scope) so it is a runtime value rather than
 * something baked in at build time, and because Vercel only populates
 * `VERCEL_URL` in the deployed environment. `NEXT_PUBLIC_SITE_URL` wins when
 * set, because `VERCEL_URL` is the *deployment* URL — a per-deploy hostname
 * that changes on every push, which would send users a confirmation link
 * pointing at a preview build rather than the site.
 */
function siteUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");

  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) return `https://${vercel}`;

  return "http://localhost:3000";
}
