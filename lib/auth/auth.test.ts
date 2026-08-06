import { describe, expect, it } from "vitest";

import { anonymousAuthProvider } from "./anonymous";
import { AuthError, SAFE_AUTH_MESSAGE, authErrorMessage } from "./errors";
import { isUniqueViolation, mapSupabaseAuthError } from "./supabase/map-error";
import {
  RESERVED_USERNAMES,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  fallbackUsername,
  usernameKey,
  validateUsername,
} from "./username";

/**
 * These cover the three pure pieces of the auth layer: the username policy,
 * the Supabase-error mapping, and the anonymous provider's contract.
 *
 * That is a deliberate boundary, and worth stating because of what it leaves
 * out. There is no local Supabase stack available here (the CLI needs Docker),
 * so nothing below exercises a real auth server, real cookies, or real RLS.
 * What it does cover is every decision this codebase actually made — the
 * enumeration-resistance choices in particular, which are exactly the sort of
 * thing a later "simplification" would quietly undo.
 */

describe("validateUsername", () => {
  it("accepts an ordinary username and preserves its case", () => {
    expect(validateUsername("AliK")).toEqual({ ok: true, value: "AliK" });
  });

  it("trims surrounding whitespace before validating", () => {
    expect(validateUsername("  ali_k  ")).toEqual({ ok: true, value: "ali_k" });
  });

  it("rejects an empty or whitespace-only value", () => {
    expect(validateUsername("")).toEqual({ ok: false, reason: "empty" });
    expect(validateUsername("   ")).toEqual({ ok: false, reason: "empty" });
  });

  it("enforces the length bounds inclusively", () => {
    expect(validateUsername("ab")).toEqual({ ok: false, reason: "too_short" });
    expect(validateUsername("abc").ok).toBe(true);
    expect(validateUsername("a".repeat(USERNAME_MAX_LENGTH)).ok).toBe(true);
    expect(validateUsername("a".repeat(USERNAME_MAX_LENGTH + 1))).toEqual({
      ok: false,
      reason: "too_long",
    });
  });

  it("reports an over-long valid-charset name as too_long, not invalid_characters", () => {
    // Order-of-checks regression guard: "too long" is actionable, "invalid
    // characters" would send the user hunting for a character that is fine.
    expect(validateUsername("a".repeat(60))).toEqual({ ok: false, reason: "too_long" });
  });

  it("rejects leading and trailing underscores", () => {
    // Invisible at a glance, so `_ali`/`ali_`/`ali` would read as one person
    // in a comment thread.
    expect(validateUsername("_ali")).toEqual({ ok: false, reason: "invalid_characters" });
    expect(validateUsername("ali_")).toEqual({ ok: false, reason: "invalid_characters" });
    expect(validateUsername("a_l_i").ok).toBe(true);
  });

  it("rejects characters outside the allowed set", () => {
    for (const bad of ["ali k", "ali-k", "ali.k", "ali@k", "alık", "ali/k", "ali\\k"]) {
      expect(validateUsername(bad), bad).toEqual({
        ok: false,
        reason: "invalid_characters",
      });
    }
  });

  it("rejects reserved names regardless of case", () => {
    expect(validateUsername("admin")).toEqual({ ok: false, reason: "reserved" });
    expect(validateUsername("AdMiN")).toEqual({ ok: false, reason: "reserved" });
    expect(validateUsername("Marquee")).toEqual({ ok: false, reason: "reserved" });
  });

  it("reserves every current top-level route segment", () => {
    // Reserving these later is not possible without taking a name off someone,
    // so a new route added without a matching reservation should fail here.
    for (const route of ["search", "library", "profile", "account", "signin", "signup"]) {
      expect(RESERVED_USERNAMES.has(route), route).toBe(true);
    }
  });

  it("matches reserved names exactly, not by prefix", () => {
    // `admin` is reserved; `administrating` is a legitimate name, and the
    // generated fallbacks below depend on this staying exact-match.
    expect(validateUsername("administrating").ok).toBe(true);
    expect(validateUsername("searchlight").ok).toBe(true);
  });

  it("keeps the minimum consistent with the exported constant", () => {
    expect(validateUsername("a".repeat(USERNAME_MIN_LENGTH)).ok).toBe(true);
    expect(validateUsername("a".repeat(USERNAME_MIN_LENGTH - 1)).ok).toBe(false);
  });
});

describe("usernameKey", () => {
  it("folds case and trims, matching lower(username) in Postgres", () => {
    expect(usernameKey("  AliK ")).toBe("alik");
    expect(usernameKey("ALIK")).toBe(usernameKey("alik"));
  });
});

describe("fallbackUsername", () => {
  it("produces a valid username", () => {
    expect(validateUsername(fallbackUsername("a3f9c2d1"))).toEqual({
      ok: true,
      value: "user_a3f9c2d1",
    });
  });

  it("is never itself reserved, even though `user` is", () => {
    // Guards the exact-match assumption: if the reserved check ever became a
    // prefix check, every OAuth signup would fail to get a username.
    expect(RESERVED_USERNAMES.has("user")).toBe(true);
    expect(validateUsername(fallbackUsername("00000000")).ok).toBe(true);
  });

  it("strips non-hex input and pads short input", () => {
    expect(fallbackUsername("zz")).toBe("user_00000000");
    expect(fallbackUsername("ABCD")).toBe("user_abcd0000");
  });

  it("truncates to eight characters", () => {
    expect(fallbackUsername("0123456789abcdef")).toBe("user_01234567");
  });

  it("never ends in an underscore, whatever it is given", () => {
    for (const input of ["", "_", "zzzz", "0"]) {
      expect(fallbackUsername(input).endsWith("_"), input).toBe(false);
    }
  });
});

describe("mapSupabaseAuthError", () => {
  it("maps GoTrue codes to kinds", () => {
    expect(mapSupabaseAuthError({ code: "invalid_credentials", status: 400 }).kind).toBe(
      "invalid_credentials",
    );
    expect(mapSupabaseAuthError({ code: "user_already_exists", status: 422 }).kind).toBe(
      "email_taken",
    );
    expect(mapSupabaseAuthError({ code: "weak_password", status: 422 }).kind).toBe(
      "weak_password",
    );
    expect(
      mapSupabaseAuthError({ code: "over_email_send_rate_limit", status: 429 }).kind,
    ).toBe("rate_limited");
  });

  it("collapses email_not_confirmed into invalid_credentials", () => {
    // Deliberate: distinguishing it tells an attacker the address IS
    // registered, which is the disclosure the vague sign-in copy exists to
    // prevent. If this ever flips, the sign-in form becomes an account oracle.
    expect(mapSupabaseAuthError({ code: "email_not_confirmed", status: 400 }).kind).toBe(
      "invalid_credentials",
    );
  });

  it("recognizes a fetch failure by shape rather than by code", () => {
    expect(
      mapSupabaseAuthError({ name: "AuthRetryableFetchError", status: 0, message: "fail" })
        .kind,
    ).toBe("network");
    expect(mapSupabaseAuthError(new TypeError("fetch failed")).kind).toBe("network");
  });

  it("falls back to status when there is no code", () => {
    expect(mapSupabaseAuthError({ status: 429, message: "slow down" }).kind).toBe(
      "rate_limited",
    );
    expect(mapSupabaseAuthError({ status: 401, message: "nope" }).kind).toBe(
      "not_authenticated",
    );
    expect(mapSupabaseAuthError({ status: 503, message: "down" }).kind).toBe("network");
  });

  it("falls back to a substring match only as a last resort", () => {
    expect(
      mapSupabaseAuthError({ status: 400, message: "User already registered" }).kind,
    ).toBe("email_taken");
    expect(
      mapSupabaseAuthError({ status: 400, message: "Invalid login credentials" }).kind,
    ).toBe("invalid_credentials");
  });

  it("returns unknown rather than guessing", () => {
    expect(mapSupabaseAuthError({ status: 418, message: "teapot" }).kind).toBe("unknown");
    expect(mapSupabaseAuthError(null).kind).toBe("unknown");
    expect(mapSupabaseAuthError(undefined).kind).toBe("unknown");
  });

  it("passes an AuthError through unchanged", () => {
    const original = new AuthError("not_configured", "x");
    expect(mapSupabaseAuthError(original)).toBe(original);
  });

  it("keeps the upstream text in the error message, not in the user-facing copy", () => {
    const mapped = mapSupabaseAuthError({
      code: "invalid_credentials",
      status: 400,
      message: "Invalid login credentials",
    });
    // Available for the server log...
    expect(mapped.message).toContain("Invalid login credentials");
    // ...but never what the user is shown.
    expect(authErrorMessage(mapped)).toBe(SAFE_AUTH_MESSAGE.invalid_credentials);
    expect(authErrorMessage(mapped)).not.toContain("Invalid login credentials");
  });
});

describe("isUniqueViolation", () => {
  it("matches on SQLSTATE, not on the constraint name or message", () => {
    expect(isUniqueViolation({ code: "23505", message: "duplicate key" })).toBe(true);
    expect(isUniqueViolation({ code: "23503" })).toBe(false);
    expect(
      isUniqueViolation({ message: "duplicate key value violates unique constraint" }),
    ).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});

describe("anonymousAuthProvider", () => {
  it("reports signed out rather than throwing", async () => {
    // The single most load-bearing line in the zero-config promise: every
    // account-aware surface handles null, so none of them need to know whether
    // Supabase exists.
    await expect(anonymousAuthProvider.getAccount()).resolves.toBeNull();
  });

  it("treats sign out as an idempotent success", async () => {
    await expect(anonymousAuthProvider.signOut()).resolves.toBeUndefined();
  });

  it("refuses every other mutation with not_configured", async () => {
    const attempts: Array<[string, Promise<unknown>]> = [
      ["signUp", anonymousAuthProvider.signUp({ email: "a@b.c", password: "x", username: "abc" })],
      ["signInWithPassword", anonymousAuthProvider.signInWithPassword({ email: "a@b.c", password: "x" })],
      ["signInWithOAuth", anonymousAuthProvider.signInWithOAuth("github", "/")],
      ["requestPasswordReset", anonymousAuthProvider.requestPasswordReset("a@b.c", "/")],
      ["updatePassword", anonymousAuthProvider.updatePassword("x")],
      ["resendVerification", anonymousAuthProvider.resendVerification("a@b.c")],
      ["setUsername", anonymousAuthProvider.setUsername("abc")],
    ];

    for (const [name, promise] of attempts) {
      await expect(promise, name).rejects.toMatchObject({
        name: "AuthError",
        kind: "not_configured",
      });
    }
  });

  it("reports usernames as available so the sign-up form never looks broken", async () => {
    await expect(anonymousAuthProvider.isUsernameAvailable("anything")).resolves.toBe(true);
  });
});
