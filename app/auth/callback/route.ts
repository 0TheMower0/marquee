import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";

import { getAuthProvider } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase/public-env";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";

/**
 * The single landing point for every link Supabase sends a user to: the OAuth
 * return, the email-confirmation link, and the password-recovery link.
 *
 * ============================================================================
 * TWO PARAMETER SHAPES, BOTH SUPPORTED, ON PURPOSE
 * ============================================================================
 * Which one arrives depends on a Supabase *dashboard* setting this code cannot
 * control, so it handles both rather than assuming one:
 *
 *   - `?code=...` — the PKCE exchange. Always what OAuth returns, and what the
 *     stock email templates produce (they route through
 *     `/auth/v1/verify?redirect_to=...`, which lands here with a code).
 *   - `?token_hash=...&type=...` — what a template customized to use
 *     `{{ .TokenHash }}` produces.
 *
 * The second is worth switching the templates to, and supabase/README.md says
 * so, because the PKCE code verifier lives in a cookie set on the device that
 * *started* the flow. A user who signs up on their laptop and opens the
 * confirmation email on their phone has no verifier there, so the exchange
 * fails with a confusing error. `token_hash` carries no such device affinity.
 *
 * A route handler rather than a page: it must write session cookies, and this
 * is one of the two places Next allows that.
 */
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const params = url.searchParams;

  // Same-origin paths only. This value comes back from an external redirect,
  // so it is untrusted input; an unvalidated `next` here would let a crafted
  // link bounce a freshly-signed-in user to an attacker's page.
  const rawNext = params.get("next") ?? "/account";
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/account";

  const redirectTo = (path: string) => {
    const target = url.clone();
    const [pathname, query = ""] = path.split("?");
    target.pathname = pathname;
    target.search = query;
    return NextResponse.redirect(target);
  };

  if (!isSupabaseConfigured()) {
    // Reachable only if the deployment lost its configuration after a link was
    // sent. Say so plainly rather than 404ing on a link the user was told to
    // click.
    return redirectTo("/signin?error=unavailable");
  }

  // The identity provider reports its own failures here — a denied consent
  // screen, an expired link. `error_description` is upstream text and is
  // logged, never reflected into the page.
  const providerError = params.get("error") ?? params.get("error_code");
  if (providerError) {
    console.error(
      "[auth] callback returned provider error",
      providerError,
      params.get("error_description"),
    );
    return redirectTo("/signin?error=oauth");
  }

  const supabase = await createSupabaseServerClient();
  const code = params.get("code");
  const tokenHash = params.get("token_hash");
  const type = params.get("type") as EmailOtpType | null;

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      console.error("[auth] code exchange failed", error.message);
      return redirectTo("/signin?error=link");
    }
  } else if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    if (error) {
      console.error("[auth] otp verification failed", error.message);
      return redirectTo("/signin?error=link");
    }
  } else {
    return redirectTo("/signin?error=link");
  }

  // First authenticated moment for an OAuth signup, and the point at which a
  // confirmed email-signup finally gets the username it asked for. Idempotent,
  // so running it on every callback is free after the first.
  //
  // A failure here must not strand a user who just successfully signed in —
  // they have a session either way, and /account calls this again on load.
  try {
    await getAuthProvider().ensureProfile();
  } catch (error) {
    console.error("[auth] ensureProfile failed after callback", error);
  }

  // A recovery link lands the user in a real (short-lived) session, which is
  // what makes "set a new password" possible at all. `/account?recovery=1`
  // scrolls them to the password form rather than leaving them to find it.
  if (type === "recovery" && next === "/account") {
    return redirectTo("/account?recovery=1");
  }

  return redirectTo(next);
}
