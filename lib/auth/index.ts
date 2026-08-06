import "server-only";

import { isSupabaseConfigured } from "@/lib/supabase/public-env";

import { anonymousAuthProvider } from "./anonymous";
import type { AuthProvider } from "./provider";
import { supabaseAuthProvider } from "./supabase";
import type { AuthAccount } from "./types";

export type { AuthProvider } from "./provider";
export type {
  AuthAccount,
  AuthProfile,
  AuthUser,
  OAuthProviderId,
  SignInInput,
  SignUpInput,
  SignUpResult,
  UsernameResult,
} from "./types";
export { AuthError, SAFE_AUTH_MESSAGE, authErrorMessage } from "./errors";
export type { AuthErrorKind } from "./errors";

/**
 * The only sanctioned way to get an auth provider — the direct counterpart of
 * `getContentProvider()`, and selected the same way: on the presence of
 * configuration, defaulting to the implementation that needs none.
 *
 * Note what is NOT here: any thrown error for a missing configuration. A typo'd
 * `NEXT_PUBLIC_CONTENT_PROVIDER` throws, because serving mock data when you
 * asked for TMDB is a silent lie. Absent Supabase config is the opposite — it
 * is the documented default state of this app, so it resolves quietly to the
 * anonymous provider. Two similar-looking functions, two different rules,
 * because "unconfigured" means something different in each.
 *
 * `import "server-only"` above is what stops a Client Component importing this
 * and dragging the server client's `cookies()` usage into the browser bundle.
 * Client Components read auth state from `useAuth()` instead.
 */
export function getAuthProvider(): AuthProvider {
  return isSupabaseConfigured() ? supabaseAuthProvider : anonymousAuthProvider;
}

/**
 * The signed-in account for the current request, or `null`.
 *
 * Convenience for Server Components, which is where most reads happen. The
 * shorter name matters: a page that needs the user should not have to know a
 * provider abstraction exists.
 *
 * ============================================================================
 * WHY NO CALL TO THIS SITS IN THE ROOT LAYOUT
 * ============================================================================
 * It would be the obvious place to put it, and it is the wrong one. `cookies()`
 * is a request-time API, so reading it in `app/layout.tsx` opts EVERY route
 * into dynamic rendering — Home, title pages, all of it — permanently trading
 * this app's static/ISR rendering for a banner that says a name. That is a real
 * cost paid by every anonymous visitor, who is the majority and gets nothing
 * back for it.
 *
 * So account-aware chrome hydrates client-side from `useAuth()` instead, and
 * this function is called only by the routes that genuinely need the identity
 * server-side (`/account`, the auth pages, and Phase 6 Step 5's sync entry
 * points). The visible cost is that the Profile page's account card renders
 * signed-out for one frame before hydration — which is the correct trade for
 * an app whose whole premise is that being signed out is a first-class state.
 */
export async function getAccount(): Promise<AuthAccount | null> {
  return getAuthProvider().getAccount();
}
