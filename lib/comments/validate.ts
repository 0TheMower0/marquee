import type { ReportReason } from "./types";

/**
 * Comment-body validation and sanitization. Pure — no I/O, no React — for the
 * same reason `lib/auth/username.ts` is: the client validates with this
 * before spending a round trip, the server validates with it AGAIN before
 * writing (never trust the client), and it needs to be unit-testable without
 * a database.
 *
 * ============================================================================
 * COMMENTS ARE PLAIN TEXT, NEVER HTML — WHY THAT MAKES XSS STRUCTURAL, NOT
 * A SANITIZATION PROBLEM
 * ============================================================================
 * There is no markdown parser and no `dangerouslySetInnerHTML` anywhere in
 * this feature. A comment body is rendered as a React text child, and React
 * escapes text content by construction — `<script>` in a comment renders as
 * the literal four characters, never executes. That is a stronger guarantee
 * than any sanitizer, because it cannot be bypassed by a sanitizer bug. So
 * "sanitisation" here is NOT about stripping HTML/script tags (there is
 * nothing to strip that could ever execute) — it is about the things plain-
 * text rendering does NOT protect against on its own: excessive whitespace
 * abuse, invisible/control characters, and length.
 */

/** Matches `MAX_NOTE_LENGTH` in `lib/ratings/types.ts` — reusing a number
 *  this app already picked for "a real block of prose about a title," rather
 *  than inventing a fresh one for a very similar kind of field. */
export const MAX_COMMENT_LENGTH = 2000;
export const MIN_COMMENT_LENGTH = 1;

/** Mirrors the `note` column's cap in `comment_reports` exactly. */
export const MAX_REPORT_NOTE_LENGTH = 500;

export type CommentBodyRejection =
  | "empty"
  | "too_long"
  | "only_whitespace";

export const COMMENT_BODY_REJECTION_MESSAGE: Record<CommentBodyRejection, string> = {
  empty: "Write something first.",
  too_long: `Comments can be at most ${MAX_COMMENT_LENGTH} characters.`,
  only_whitespace: "Write something first.",
};

/**
 * Builds a character class from a run of numeric code points, e.g.
 * `codepointRange(0x200b, 0x200f)`.
 *
 * This exists so `INVISIBLE_CONTROL_CHARS` below can be built WITHOUT ever
 * containing an actual invisible character, or a JS `\u` escape sequence for
 * one, anywhere in this file's source — both render identically once parsed
 * and both are unreviewable in a diff, for a file whose entire job is
 * stripping exactly these characters. Numeric code points, spelled out in
 * decimal/hex, are unambiguous plain ASCII and the safest way to write this.
 */
function codepointRange(startInclusive: number, endInclusive: number): string {
  let chars = "";
  for (let codepoint = startInclusive; codepoint <= endInclusive; codepoint += 1) {
    chars += String.fromCharCode(codepoint);
  }
  return chars;
}

/** Zero-width spacing/joining marks (U+200B–U+200F: zero-width space, ZWNJ,
 *  ZWJ, LRM, RLM), bidi embedding/override controls (U+202A–U+202E), and bidi
 *  isolate controls (U+2066–U+2069). */
const INVISIBLE_CONTROL_CHARS = new RegExp(
  `[${codepointRange(0x200b, 0x200f)}${codepointRange(0x202a, 0x202e)}${codepointRange(0x2066, 0x2069)}]`,
  "g",
);

/**
 * Collapses runs of 3+ consecutive newlines down to 2 (one visible blank
 * line), and strips characters that exist only to manipulate rendering
 * rather than to be read. Both are real, observed abuse patterns on plain-
 * text comment systems — a wall of blank lines pushing a thread off-screen,
 * or a bidi override making a comment DISPLAY as something other than what
 * it literally contains, a spoof vector that exists independently of any
 * markup and that plain-text rendering does nothing to prevent on its own.
 *
 * Trims leading/trailing whitespace. Does NOT collapse internal single
 * spaces or single newlines — those are normal formatting a user typed on
 * purpose.
 */
export function sanitizeCommentBody(raw: string): string {
  return raw
    .replace(INVISIBLE_CONTROL_CHARS, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type CommentBodyValidation =
  | { ok: true; value: string }
  | { ok: false; reason: CommentBodyRejection };

/**
 * Sanitizes, then validates. Always run the raw client input through this —
 * never `sanitizeCommentBody` alone — so a value that survives validation is
 * guaranteed to also be the exact value that gets stored; storing something
 * different from what was validated is how a length-limit bug slips past
 * review.
 */
export function validateCommentBody(raw: string): CommentBodyValidation {
  const value = sanitizeCommentBody(raw);

  if (value.length === 0) return { ok: false, reason: "empty" };
  if (value.length > MAX_COMMENT_LENGTH) return { ok: false, reason: "too_long" };

  return { ok: true, value };
}

const REPORT_REASON_VALUES: readonly ReportReason[] = [
  "spam",
  "harassment",
  "spoiler",
  "other",
];

export function isReportReason(value: unknown): value is ReportReason {
  return (
    typeof value === "string" && REPORT_REASON_VALUES.includes(value as ReportReason)
  );
}

export type ReportNoteValidation =
  | { ok: true; value: string | null }
  | { ok: false; reason: "too_long" };

/** The optional free-text note on a report. Blank collapses to `null` rather
 *  than an empty string — mirrors `mergeRatingPatch`'s "nothing worth storing
 *  becomes null" discipline in lib/ratings/types.ts. */
export function validateReportNote(raw: string): ReportNoteValidation {
  const trimmed = sanitizeCommentBody(raw);
  if (trimmed.length === 0) return { ok: true, value: null };
  if (trimmed.length > MAX_REPORT_NOTE_LENGTH) return { ok: false, reason: "too_long" };
  return { ok: true, value: trimmed };
}
