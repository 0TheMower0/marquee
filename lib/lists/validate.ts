import type { ListVisibility } from "./types";

/**
 * Pure validation — no I/O, no React — same reasoning as
 * `lib/comments/validate.ts` and `lib/auth/username.ts`: the client validates
 * with this before spending a round trip, the server validates with it AGAIN
 * before writing (never trust the client), and it needs to be unit-testable
 * without a database.
 */

export const MAX_LIST_NAME_LENGTH = 100;
export const MAX_LIST_DESCRIPTION_LENGTH = 500;

const VISIBILITY_VALUES: readonly ListVisibility[] = ["private", "unlisted", "public"];

export function isListVisibility(value: unknown): value is ListVisibility {
  return typeof value === "string" && VISIBILITY_VALUES.includes(value as ListVisibility);
}

export type ListNameRejection = "empty" | "too_long";

export const LIST_NAME_REJECTION_MESSAGE: Record<ListNameRejection, string> = {
  empty: "Give the list a name.",
  too_long: `List names can be at most ${MAX_LIST_NAME_LENGTH} characters.`,
};

export type ListNameValidation =
  | { ok: true; value: string }
  | { ok: false; reason: ListNameRejection };

export function validateListName(raw: string): ListNameValidation {
  const value = raw.trim();
  if (value.length === 0) return { ok: false, reason: "empty" };
  if (value.length > MAX_LIST_NAME_LENGTH) return { ok: false, reason: "too_long" };
  return { ok: true, value };
}

export type ListDescriptionValidation =
  | { ok: true; value: string | null }
  | { ok: false; reason: "too_long" };

/** Blank collapses to `null` rather than an empty string — same "nothing
 *  worth storing becomes null" discipline `mergeRatingPatch` uses. */
export function validateListDescription(raw: string): ListDescriptionValidation {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if (trimmed.length > MAX_LIST_DESCRIPTION_LENGTH) return { ok: false, reason: "too_long" };
  return { ok: true, value: trimmed };
}
