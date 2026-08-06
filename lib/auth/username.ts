/**
 * Username policy. Pure, no I/O, no React — deliberately, so it can carry the
 * tests. Same reasoning as `lib/content/omdb/normalize.ts` and
 * `lib/content/http/wire.ts`: this file must NOT be `server-only`, because the
 * sign-up form validates with it client-side before spending a round trip, and
 * the server validates with it again before writing.
 *
 * ============================================================================
 * WHERE EACH RULE IS ENFORCED, AND WHY THEY DIFFER
 * ============================================================================
 * Three rules, three enforcement points. This split is deliberate:
 *
 *   1. FORMAT (length, character set) — enforced HERE and again as a CHECK
 *      constraint in Postgres. The database is the last line: a bug in this
 *      file, or a direct PostgREST call bypassing the app entirely, still
 *      cannot write a malformed username.
 *
 *   2. UNIQUENESS — enforced ONLY by Postgres, via a unique index on
 *      `lower(username)`. Never by "select then insert": that is a race, and
 *      the check-then-act window is exactly when a concurrent signup takes the
 *      name. The availability check in the sign-up form is a courtesy that
 *      makes the common case pleasant; the index is what makes it correct.
 *
 *   3. RESERVED WORDS — enforced ONLY here, in the app layer. This one is a
 *      conscious asymmetry, so state it plainly: a direct PostgREST call with
 *      a user's own token could claim `admin`. The list is product policy that
 *      will change, and encoding it as a CHECK constraint means a migration
 *      every time a word is added or removed — including, awkwardly, a
 *      migration that would fail if an existing row already held the
 *      newly-reserved name. For a personal, non-commercial app the trade is
 *      right. If usernames ever become publicly addressable (`/@name`), move
 *      this to a `security definer` claim function and revoke direct UPDATE.
 */

/** Inclusive. 3 is short enough for real short handles; 24 fits a nav label
 *  without truncation at 375px. */
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 24;

/**
 * Letters, digits, and underscore; must begin and end with a letter or digit.
 *
 * Leading/trailing underscores are excluded because they are invisible at a
 * glance — `_ali` and `ali_` and `ali` read as the same person in a comment
 * thread, which is an impersonation vector in the Phase 6 Step 6 comments
 * feature this username exists to serve.
 *
 * ASCII-only, and that IS a limitation rather than an oversight. Unicode
 * usernames need confusable-script normalization (UTS #39) to not be an
 * impersonation hazard — Cyrillic `а` against Latin `a` — and half-doing that
 * is worse than not doing it. Display names are free text and unrestricted;
 * they are where a user writes their actual name.
 *
 * This pattern is mirrored by the CHECK constraint in the usernames migration.
 * The two must change together.
 */
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_]*[A-Za-z0-9]$/;

export type UsernameRejection =
  | "empty"
  | "too_short"
  | "too_long"
  | "invalid_characters"
  | "reserved";

export const USERNAME_REJECTION_MESSAGE: Record<UsernameRejection, string> = {
  empty: "Pick a username.",
  too_short: `Usernames need at least ${USERNAME_MIN_LENGTH} characters.`,
  too_long: `Usernames can be at most ${USERNAME_MAX_LENGTH} characters.`,
  invalid_characters:
    "Use letters, numbers, and underscores, starting and ending with a letter or number.",
  reserved: "That username is reserved.",
};

/**
 * Names nobody may claim.
 *
 * Three groups, and the third is the one worth explaining:
 *
 *   - IMPERSONATION: `admin`, `staff`, `marquee`, `support`. A comment signed
 *     "marquee" reads as the app speaking.
 *   - SECURITY-ADJACENT: `security`, `billing`, `password`. Same reason.
 *   - EVERY CURRENT AND PLAUSIBLE ROUTE SEGMENT: `search`, `library`,
 *     `profile`, `settings`, `account`, `signin`. Usernames are not
 *     top-level-addressable today. Reserving these now is free; reserving them
 *     LATER is not, because by then someone owns the name and unreserving is
 *     the only non-destructive option. Cheap insurance against a routing
 *     decision that hasn't been made yet.
 *
 * Matched case-insensitively against the trimmed input.
 */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  // Impersonation
  "admin",
  "administrator",
  "marquee",
  "official",
  "staff",
  "team",
  "support",
  "help",
  "moderator",
  "mod",
  "system",
  "root",
  "owner",
  // Security-adjacent
  "security",
  "billing",
  "password",
  "verify",
  "verification",
  // Auth surface
  "auth",
  "login",
  "logout",
  "signin",
  "signout",
  "signup",
  "register",
  "session",
  "callback",
  "confirm",
  // Current and plausible future routes
  "api",
  "home",
  "search",
  "library",
  "profile",
  "account",
  "settings",
  "stats",
  "title",
  "titles",
  "movie",
  "movies",
  "tv",
  "show",
  "shows",
  "list",
  "lists",
  "about",
  "terms",
  "privacy",
  "legal",
  "contact",
  // Values that read as an absent value if they ever reach a template
  "null",
  "undefined",
  "none",
  "anonymous",
  "guest",
  "me",
  "you",
  "new",
  "edit",
  "delete",
  // `user` and `users` are reserved, while the generated `user_a3f9c2d1`
  // placeholder is not — the check is exact-match, never prefix. A test pins
  // that, because turning it into a prefix check would make every OAuth signup
  // fail to claim a username.
  "user",
  "users",
  "profiles",
]);

export type UsernameValidation =
  | { ok: true; value: string }
  | { ok: false; reason: UsernameRejection };

/**
 * Validate a raw username, returning the trimmed value on success.
 *
 * Trims but does NOT lowercase: the value is stored as typed so `AliK` renders
 * as `AliK`, while uniqueness is enforced on `lower(username)` in Postgres.
 * That is GitHub's model, and it is the one that avoids both "why did my
 * capitals disappear" and "AliK and alik are two different people."
 *
 * Order matters. Length is checked before the character pattern so a 40-
 * character valid-charset name reports `too_long` rather than the far less
 * actionable `invalid_characters`.
 */
export function validateUsername(raw: string): UsernameValidation {
  const value = raw.trim();

  if (value.length === 0) return { ok: false, reason: "empty" };
  if (value.length < USERNAME_MIN_LENGTH) return { ok: false, reason: "too_short" };
  if (value.length > USERNAME_MAX_LENGTH) return { ok: false, reason: "too_long" };
  if (!USERNAME_PATTERN.test(value)) {
    return { ok: false, reason: "invalid_characters" };
  }
  if (RESERVED_USERNAMES.has(value.toLowerCase())) {
    return { ok: false, reason: "reserved" };
  }

  return { ok: true, value };
}

/** The comparison key uniqueness is enforced on. Mirrors `lower(username)` in
 *  the unique index — if one changes, so must the other. */
export function usernameKey(username: string): string {
  return username.trim().toLowerCase();
}

/**
 * A username for someone who never chose one: an OAuth signup, or a signup
 * whose desired name was taken by the time the profile row was created.
 *
 * `user_` + 8 hex characters. Deliberately obviously-generated rather than
 * `alik2`, `alik3`: a name that looks chosen implies the user chose it, and
 * they will not know to change it. This one reads as a placeholder and the
 * account page invites renaming it.
 *
 * The hex is injected rather than generated internally so this stays pure and
 * the tests are deterministic — the same reason `lib/tracking` takes `now` as
 * a parameter. `user` itself is in RESERVED_USERNAMES; `user_a3f9c2d1` is not,
 * and the reserved check is exact-match, not prefix, so this is safe. Asserted
 * in the tests so a future switch to prefix matching fails loudly.
 */
export function fallbackUsername(hex: string): string {
  const suffix = hex.replace(/[^0-9a-f]/gi, "").toLowerCase().slice(0, 8) || "00000000";
  return `user_${suffix.padEnd(8, "0")}`;
}

/** Browser- and Node-safe random hex for `fallbackUsername`. Kept out of that
 *  function so it remains pure. */
export function randomHex(bytes = 4): string {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}
