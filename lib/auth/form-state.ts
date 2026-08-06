/**
 * The shape every auth form action returns, and its initial value.
 *
 * ============================================================================
 * WHY THIS IS NOT IN actions.ts
 * ============================================================================
 * It was, and that was a real bug — one only a production build with Supabase
 * *configured* could surface, because unconfigured builds render the
 * "accounts unavailable" page and never mount a form at all.
 *
 * Every export from a `"use server"` module is compiled into a callable server
 * endpoint reference. A plain object export cannot be one, so the client
 * received `undefined` for `IDLE_AUTH_STATE`, `useActionState` was seeded with
 * it, and the first render died on `state.fieldErrors.email`. Types alone will
 * not catch this: `IDLE_AUTH_STATE` is correctly typed on both sides, and the
 * value only goes missing at the module boundary.
 *
 * So: constants and types live here, in an ordinary module both sides may
 * import. `actions.ts` exports functions and nothing else.
 */
export interface AuthActionState {
  status: "idle" | "error" | "success";
  /** Form-level message. Always drawn from SAFE_AUTH_MESSAGE — never an
   *  upstream string, for the same reason route handlers never forward TMDB's
   *  `status_message`. */
  message: string | null;
  /** Field name -> message, for inline errors. */
  fieldErrors: Record<string, string>;
  /** Sign-up only: the account was created but no session exists yet, so the
   *  UI must show "check your inbox" instead of navigating. */
  awaitingVerification?: boolean;
}

export const IDLE_AUTH_STATE: AuthActionState = {
  status: "idle",
  message: null,
  fieldErrors: {},
};

export function authFailure(
  message: string,
  fieldErrors: Record<string, string> = {},
): AuthActionState {
  return { status: "error", message, fieldErrors };
}

export function authSuccess(message: string | null = null): AuthActionState {
  return { status: "success", message, fieldErrors: {} };
}
