import type { UsernameRejection } from "./username";

/**
 * Normalized auth domain types — OUR shapes, not Supabase's.
 *
 * Same contract `lib/content/types.ts` holds for TMDB: no component ever
 * renders against a `@supabase/supabase-js` `User`, so swapping the auth
 * backend is one directory rather than a find-and-replace across the app.
 * Notably absent: access tokens, refresh tokens, provider metadata. Those are
 * transport concerns that live inside the Supabase implementation and must not
 * leak into UI code — a component that can read the access token is a
 * component that can accidentally render it.
 */

/** A signed-in identity. `null` everywhere means signed out — see the note on
 *  `AuthProvider.getAccount`. */
export interface AuthUser {
  id: string;
  /** Always present for password accounts. An OAuth provider *can* withhold
   *  it (GitHub users with a private email), so this is nullable rather than
   *  assumed — code that needs an address must handle its absence. */
  email: string | null;
  /** Whether the address has been confirmed. Supabase is configured
   *  project-side to require this before a session is issued, but the flag is
   *  surfaced anyway: the requirement is a dashboard setting, not something
   *  this code can enforce, so it must not be assumed true. */
  emailVerified: boolean;
  createdAt: Date;
}

/** The public-facing half of an account: `public.profiles`, readable by any
 *  signed-in user. Never holds anything private — see the policy comment in
 *  the initial schema migration. */
export interface AuthProfile {
  id: string;
  username: string;
  displayName: string | null;
}

/**
 * A user plus their profile.
 *
 * `profile` is nullable and that is a real state, not a loading artifact: a
 * user exists from the moment they confirm their email, but the profile row is
 * created by the app on first authenticated load (see `ensureProfile`). An
 * OAuth user is in this state for exactly one request.
 */
export interface AuthAccount {
  user: AuthUser;
  profile: AuthProfile | null;
}

export interface SignUpInput {
  email: string;
  password: string;
  /** The username the user *wants*. Not guaranteed — it is stored as user
   *  metadata and claimed at profile-creation time, which may be minutes later
   *  if email verification is on. See `ensureProfile`. */
  username: string;
}

export interface SignInInput {
  email: string;
  password: string;
}

/**
 * OAuth providers this app supports.
 *
 * A union rather than a string so adding one is a type error at every switch
 * that handles them (button label, icon) instead of a silently unlabelled
 * button. GitHub is the one wired up: it is the provider whose consent screen
 * is least confusing for a personal, non-commercial project, and it does not
 * require the verification review Google imposes on apps requesting profile
 * scopes.
 */
export type OAuthProviderId = "github";

export interface SignUpResult {
  /**
   * True when the project requires email confirmation, so no session exists
   * yet and the UI must say "check your inbox" rather than navigating as if
   * signed in. Derived from Supabase returning a user with no session.
   */
  needsEmailVerification: boolean;
}

/** Result of claiming or changing a username. Not an exception, because
 *  "taken" is an ordinary outcome of a form submission, not a failure. */
export type UsernameResult =
  | { ok: true; username: string }
  | { ok: false; reason: UsernameRejection | "taken" };
