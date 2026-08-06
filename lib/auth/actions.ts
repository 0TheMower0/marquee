"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { RATE_LIMITS, checkRateLimit } from "@/lib/ratelimit";
import { isSupabaseConfigured } from "@/lib/supabase/public-env";

import { AuthError, authErrorMessage } from "./errors";
import {
  authFailure as failure,
  authSuccess as success,
  type AuthActionState,
} from "./form-state";
import { getAuthProvider } from "./index";
import type { OAuthProviderId } from "./types";
import { USERNAME_REJECTION_MESSAGE, validateUsername } from "./username";

/**
 * Server Actions are the client seam for auth — the counterpart of
 * `app/api/content/*` for content.
 *
 * Why actions rather than route handlers: a session is a cookie, cookies can
 * only be written from a Server Function or a Route Handler, and a Server
 * Action additionally re-renders the affected server tree in the same round
 * trip. Doing sign-in from the browser SDK instead would produce a session
 * that the *browser* knows about but the next server render does not, which is
 * precisely the "works correctly with Server Components" requirement failing.
 *
 * Every mutating action here rate-limits on the caller's IP before doing
 * anything, using the same limiter Phase 6 Step 2 built. These are as public as
 * `app/api/content/*` — a Server Action endpoint is callable by anyone who can
 * read the page's JS.
 */

/**
 * NOTE: `AuthActionState` and `IDLE_AUTH_STATE` deliberately live in
 * `./form-state`, NOT here. A `"use server"` module may only export async
 * functions — a constant exported from one arrives on the client as
 * `undefined`. See the comment in that file; it cost a build to find.
 */

/**
 * Rate-limit gate for actions.
 *
 * `checkRateLimit` takes a `Request` because every other caller is a route
 * handler and has one. A Server Action doesn't, so the incoming headers are
 * wrapped in a throwaway `Request` — the limiter only ever reads
 * `request.headers`, and giving it a synthetic URL is honest about the fact
 * that no URL is involved. The alternative, a second IP-extraction path, would
 * mean the `X-Forwarded-For`-from-the-right logic that is the whole security
 * property of `client-ip.ts` existed in two places.
 */
async function rateLimited(): Promise<boolean> {
  const requestHeaders = await headers();
  const decision = await checkRateLimit(
    new Request("http://server-action.local", { headers: requestHeaders }),
    RATE_LIMITS.auth,
  );
  return !decision.allowed;
}

const TOO_MANY = "Too many attempts. Wait a minute and try again.";

/** Guard for the unconfigured deployment. The forms are not rendered at all
 *  when Supabase is absent, so reaching one of these means someone posted to
 *  the action directly. */
function configuredOrFail(): AuthActionState | null {
  if (isSupabaseConfigured()) return null;
  return failure("Accounts aren't available on this deployment.");
}

function readString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

// ---------------------------------------------------------------------------
// Sign up
// ---------------------------------------------------------------------------

export async function signUpAction(
  _previous: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const unconfigured = configuredOrFail();
  if (unconfigured) return unconfigured;
  if (await rateLimited()) return failure(TOO_MANY);

  const email = readString(formData, "email");
  const password = String(formData.get("password") ?? "");
  const username = readString(formData, "username");

  const fieldErrors: Record<string, string> = {};
  if (!email.includes("@")) fieldErrors.email = "Enter a valid email address.";
  // 8 rather than Supabase's default 6. The server enforces its own minimum
  // regardless; this exists so the user is told before spending a round trip.
  if (password.length < 8) {
    fieldErrors.password = "Use at least 8 characters.";
  }
  const checkedUsername = validateUsername(username);
  if (!checkedUsername.ok) {
    fieldErrors.username = USERNAME_REJECTION_MESSAGE[checkedUsername.reason];
  }
  if (Object.keys(fieldErrors).length > 0) {
    return failure("Check the highlighted fields.", fieldErrors);
  }

  try {
    const result = await getAuthProvider().signUp({ email, password, username });

    if (result.needsEmailVerification) {
      return {
        status: "success",
        message: null,
        fieldErrors: {},
        awaitingVerification: true,
      };
    }
  } catch (error) {
    return failure(authErrorMessage(error), fieldErrors);
  }

  // Only reachable when the project has email confirmation switched off, in
  // which case signUp returns a live session. Outside the try/catch because
  // `redirect` signals by throwing, and catching it here would swallow the
  // navigation and report it as an unknown error.
  revalidatePath("/", "layout");
  redirect("/account");
}

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------

export async function signInAction(
  _previous: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const unconfigured = configuredOrFail();
  if (unconfigured) return unconfigured;
  if (await rateLimited()) return failure(TOO_MANY);

  const email = readString(formData, "email");
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return failure("Enter your email and password.");
  }

  // `next` lets the sign-in page return the user where they came from. It is
  // validated to be a same-origin PATH — an open redirect on a sign-in form is
  // a phishing primitive, since the URL a user is looking at while typing
  // their password is the one thing they can check.
  const next = safeInternalPath(readString(formData, "next")) ?? "/account";

  try {
    await getAuthProvider().signInWithPassword({ email, password });
  } catch (error) {
    return failure(authErrorMessage(error));
  }

  revalidatePath("/", "layout");
  redirect(next);
}

/**
 * Accepts only a path on this origin: must start with a single `/`, and must
 * NOT start with `//` — a browser reads `//evil.example` as a protocol-relative
 * URL to another host, so that one extra slash is the entire difference between
 * a redirect and an open redirect.
 *
 * Deliberately not exported. Every export from a `"use server"` module becomes
 * a callable server endpoint, so a helper that has no business being one stays
 * private.
 */
function safeInternalPath(value: string): string | null {
  if (!value.startsWith("/")) return null;
  if (value.startsWith("//")) return null;
  return value;
}

// ---------------------------------------------------------------------------
// Sign out
// ---------------------------------------------------------------------------

export async function signOutAction(): Promise<void> {
  // Not rate-limited and not gated on configuration: the anonymous provider's
  // signOut is a successful no-op by design, and throttling someone's attempt
  // to end their own session would be a hostile failure mode.
  try {
    await getAuthProvider().signOut();
  } catch (error) {
    console.error("[auth] sign out failed", error);
  }
  revalidatePath("/", "layout");
  redirect("/");
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

export async function startOAuthAction(formData: FormData): Promise<void> {
  // Returns `void`, so failures surface as a redirect back to /signin carrying
  // an error code rather than as form state — there is no form state to return
  // to once the browser has been sent to an identity provider.
  if (!isSupabaseConfigured()) redirect("/signin?error=unavailable");
  if (await rateLimited()) redirect("/signin?error=rate_limited");

  const provider = readString(formData, "provider") as OAuthProviderId;
  if (provider !== "github") redirect("/signin?error=unsupported");

  const next = safeInternalPath(readString(formData, "next")) ?? "/account";
  const origin = await requestOrigin();

  let url: string;
  try {
    ({ url } = await getAuthProvider().signInWithOAuth(
      provider,
      `${origin}/auth/callback?next=${encodeURIComponent(next)}`,
    ));
  } catch (error) {
    console.error("[auth] oauth start failed", error);
    redirect("/signin?error=oauth");
  }

  // An external absolute URL — the one place in this file where redirecting
  // off-origin is the whole point. It comes from the Supabase SDK, not from
  // user input, which is why it does not go through `safeInternalPath`.
  redirect(url);
}

// ---------------------------------------------------------------------------
// Password reset and verification email
// ---------------------------------------------------------------------------

export async function requestPasswordResetAction(
  _previous: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const unconfigured = configuredOrFail();
  if (unconfigured) return unconfigured;
  if (await rateLimited()) return failure(TOO_MANY);

  const email = readString(formData, "email");
  if (!email.includes("@")) {
    return failure("Enter a valid email address.", {
      email: "Enter a valid email address.",
    });
  }

  const origin = await requestOrigin();

  try {
    await getAuthProvider().requestPasswordReset(
      email,
      `${origin}/auth/callback?next=${encodeURIComponent("/account?recovery=1")}`,
    );
  } catch (error) {
    return failure(authErrorMessage(error));
  }

  // Deliberately identical whether or not that address has an account. The
  // provider swallows the difference; this copy is worded so it is not a lie
  // in either case.
  return success("If that address has an account, a reset link is on its way.");
}

export async function resendVerificationAction(
  _previous: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const unconfigured = configuredOrFail();
  if (unconfigured) return unconfigured;
  if (await rateLimited()) return failure(TOO_MANY);

  const email = readString(formData, "email");
  if (!email.includes("@")) {
    return failure("Enter a valid email address.", {
      email: "Enter a valid email address.",
    });
  }

  try {
    await getAuthProvider().resendVerification(email);
  } catch (error) {
    return failure(authErrorMessage(error));
  }

  return success("If that address needs confirming, a new link is on its way.");
}

// ---------------------------------------------------------------------------
// Account management (requires a session)
// ---------------------------------------------------------------------------

export async function updatePasswordAction(
  _previous: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const unconfigured = configuredOrFail();
  if (unconfigured) return unconfigured;
  if (await rateLimited()) return failure(TOO_MANY);

  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirmPassword") ?? "");

  if (password.length < 8) {
    return failure("Check the highlighted field.", {
      password: "Use at least 8 characters.",
    });
  }
  if (password !== confirm) {
    return failure("Check the highlighted field.", {
      confirmPassword: "Those passwords don't match.",
    });
  }

  try {
    await getAuthProvider().updatePassword(password);
  } catch (error) {
    return failure(authErrorMessage(error));
  }

  revalidatePath("/account");
  return success("Password updated.");
}

export async function updateUsernameAction(
  _previous: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const unconfigured = configuredOrFail();
  if (unconfigured) return unconfigured;
  if (await rateLimited()) return failure(TOO_MANY);

  const username = readString(formData, "username");

  try {
    const result = await getAuthProvider().setUsername(username);
    if (!result.ok) {
      const message =
        result.reason === "taken"
          ? "That username is already taken."
          : USERNAME_REJECTION_MESSAGE[result.reason];
      return failure("Check the highlighted field.", { username: message });
    }
  } catch (error) {
    if (error instanceof AuthError && error.kind === "not_authenticated") {
      return failure("You need to be signed in to do that.");
    }
    return failure(authErrorMessage(error));
  }

  revalidatePath("/account");
  return success("Username updated.");
}

/**
 * Availability check for the sign-up form. Not a form action — called directly
 * from the client as the user types, behind a debounce.
 *
 * Returns a plain boolean and never throws: this is decoration on top of a
 * unique index, so a failure here must degrade to "looks fine" rather than
 * block a legitimate signup. Rate-limited, because it is an unauthenticated
 * existence oracle (see RATE_LIMITS.auth).
 */
export async function checkUsernameAction(username: string): Promise<boolean> {
  if (!isSupabaseConfigured()) return true;
  if (await rateLimited()) return true;

  const checked = validateUsername(username);
  if (!checked.ok) return false;

  try {
    return await getAuthProvider().isUsernameAvailable(checked.value);
  } catch {
    return true;
  }
}

/**
 * The origin of the request being served, for building absolute callback URLs.
 *
 * Read from headers rather than from `NEXT_PUBLIC_SITE_URL` so a local dev
 * session, a preview deployment, and production each get a callback pointing
 * back at themselves. `x-forwarded-host` wins over `host` because behind
 * Vercel's proxy `host` is the internal one.
 *
 * This value ends up in a `redirect_to` parameter that Supabase will only
 * honour if it matches the project's configured redirect allowlist, so a
 * forged `Host` header cannot turn this into an open redirect — the allowlist
 * is the actual control, and it is a dashboard setting (documented in
 * supabase/README.md), not something this code can enforce.
 */
async function requestOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const protocol =
    h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${protocol}://${host}`;
}
