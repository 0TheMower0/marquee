import type { Genre, MediaType, PlaceholderArt, TitleSummary } from "./types";

/**
 * Runtime validation for domain types that arrive from OUTSIDE the content
 * layer's own providers — local storage and the sync server.
 *
 * ============================================================================
 * WHY THIS EXISTS, AND WHAT IT IS PROTECTING AGAINST
 * ============================================================================
 * `TitleSummary` is stored twice over: as a denormalized snapshot inside every
 * `TrackingEntry` in local storage, and as a `jsonb` column in
 * `tracked_titles.summary` on the server. Neither round trip is typed at
 * runtime — the server row's `summary` is `unknown` by construction, and
 * TypeScript cannot police what comes back off the wire or off disk.
 *
 * A real crash proved that matters. `isTrackingEntry` validated `summary` as
 * nothing more than `typeof === "object" && !== null`, so a snapshot missing
 * `placeholder` passed validation, was written to local storage, and then took
 * down whole pages: `PosterImage` reads `placeholder.gradientFrom` directly,
 * and an undefined `placeholder` throws during render, which React escalates
 * to the nearest error boundary. Library, Schedule and Up Next all render
 * posters, so all three showed "Something broke" instead of the user's data.
 *
 * ============================================================================
 * DELIBERATELY STRICT ON SOME FIELDS AND LENIENT ON OTHERS
 * ============================================================================
 * `lib/storage`'s contract is that a record failing `validate()` reads back as
 * `null` while its bytes stay on disk. That makes over-strictness genuinely
 * dangerous here: a validator that rejected records real users already hold
 * would empty their library on the next load. So the line is drawn at
 * consequence, not at completeness:
 *
 *   - REQUIRED: the fields whose absence breaks rendering or identity — `id`,
 *     `mediaType`, `name`, and a well-formed `placeholder` with both stops.
 *   - TYPE-CHECKED IF PRESENT: everything else. A summary with no `overview`
 *     renders an empty description; one with no `genres` contributes nothing
 *     to stats. Both degrade quietly and neither can crash, so neither is
 *     worth discarding a user's tracked title over.
 *
 * If a future field becomes load-bearing for rendering, move it up to the
 * required set — and expect that to be a decision with data-loss consequences
 * for anyone whose stored records predate it.
 */

const MEDIA_TYPES: readonly MediaType[] = ["movie", "tv"];

function isPlaceholderArt(value: unknown): value is PlaceholderArt {
  if (typeof value !== "object" || value === null) return false;
  const art = value as Record<string, unknown>;
  // Both stops are interpolated straight into a CSS gradient string, so a
  // non-string here is the exact shape of the crash this guards.
  return typeof art.gradientFrom === "string" && typeof art.gradientTo === "string";
}

function isGenre(value: unknown): value is Genre {
  if (typeof value !== "object" || value === null) return false;
  const genre = value as Record<string, unknown>;
  return typeof genre.id === "string" && typeof genre.name === "string";
}

/** `null` and `undefined` both pass — see the leniency note above. */
function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "number";
}

export function isTitleSummary(value: unknown): value is TitleSummary {
  if (typeof value !== "object" || value === null) return false;
  const summary = value as Record<string, unknown>;

  // --- required: absence breaks rendering or identity ---
  if (typeof summary.id !== "string") return false;
  if (!MEDIA_TYPES.includes(summary.mediaType as MediaType)) return false;
  if (typeof summary.name !== "string") return false;
  if (!isPlaceholderArt(summary.placeholder)) return false;

  // --- type-checked if present: wrong type is a bug, absence is survivable ---
  if (!isOptionalNumber(summary.year)) return false;
  if (!isOptionalNumber(summary.rating)) return false;
  if (!isOptionalString(summary.posterUrl)) return false;
  if (!isOptionalString(summary.overview)) return false;
  if (summary.genres !== undefined && summary.genres !== null) {
    if (!Array.isArray(summary.genres) || !summary.genres.every(isGenre)) return false;
  }

  return true;
}
