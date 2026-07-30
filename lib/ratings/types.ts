import type { MediaType } from "@/lib/content/types";

/**
 * A user's own rating and private notes for one title.
 *
 * Deliberately a SEPARATE store from `lib/tracking/`, not a field bolted onto
 * `TrackingEntry` — same reasoning CLAUDE.md already gives for keeping watch
 * dates out of episode-progress data: different access pattern (edited
 * rarely, once per title, via a dedicated control) and a different
 * versioning lifecycle. Coupling them would mean every future tracking
 * migration has to reason about rating/notes fields it has nothing to do
 * with, and vice versa.
 *
 * `score` and `note` are independent — a title can have one without the
 * other. There is no "half-empty" state to represent: if BOTH become empty
 * (score null and note blank) the record is deleted rather than persisted as
 * an empty husk. See `mergeRatingPatch`.
 */
export interface RatingEntry {
  id: string;
  mediaType: MediaType;
  /** 0–100 inclusive, integer. Null = not rated. */
  score: number | null;
  /** Free text, local only — "not shared, not synced yet" per the Phase 4
   *  Step 5 brief. Empty string = no note. */
  note: string;
  updatedAt: Date;
}

/** Same `${mediaType}:${id}` shape as `entryKey` in lib/tracking/types.ts,
 *  kept as an independent copy rather than a shared import — these are two
 *  otherwise-unrelated stores and coupling them for one two-line format
 *  string is not worth it. */
export function ratingKey(mediaType: MediaType, id: string): string {
  return `${mediaType}:${id}`;
}

const MAX_NOTE_LENGTH = 2000;

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * The one place "does this patch leave anything worth storing" is decided.
 * Pure — no storage, no React — so it is unit-testable against plain values
 * rather than through a mounted component and a fake driver.
 *
 * `patch` fields are `undefined` to mean "leave unchanged", which is why they
 * are NOT the same type as `RatingEntry`'s own fields (`score` can
 * legitimately be patched TO `null`, which must be distinguishable from "no
 * score patch was given").
 *
 * Returns `null` when the resulting entry would be empty (no score AND no
 * note) — the caller is expected to treat that as "delete this record"
 * rather than write an empty one. A whitespace-only note counts as empty.
 */
export function mergeRatingPatch(
  existing: RatingEntry | undefined,
  id: string,
  mediaType: MediaType,
  patch: { score?: number | null; note?: string },
  now: Date,
): RatingEntry | null {
  const rawScore = patch.score !== undefined ? patch.score : (existing?.score ?? null);
  const score = rawScore === null ? null : clampScore(rawScore);

  const rawNote = patch.note !== undefined ? patch.note : (existing?.note ?? "");
  const note = rawNote.slice(0, MAX_NOTE_LENGTH);

  if (score === null && note.trim() === "") return null;

  return { id, mediaType, score, note, updatedAt: now };
}
