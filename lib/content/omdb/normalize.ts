import type { ExternalRating } from "../types";

/**
 * OMDb payload -> our `ExternalRating[]`.
 *
 * Deliberately has NO `import "server-only"`, for the same reason
 * `lib/content/http/wire.ts` doesn't: this file is pure parsing with no
 * credential, no fetch and no environment access. That keeps it unit-testable
 * (`server-only` throws when imported outside a react-server condition, which
 * is exactly what Vitest is), and this is the file that most needs tests —
 * every field below is a string OMDb can and does return as `"N/A"`.
 *
 * Everything here is written against OMDb's real, quirky response shape:
 *
 *   - Failure is signalled in the BODY (`Response: "False"`), sometimes with
 *     HTTP 200. Status code alone is not sufficient — see ./client.ts.
 *   - Numbers are strings, and any of them may be the literal `"N/A"`.
 *   - `Ratings[]` carries display strings: "8.4/10", "85%", "72/100".
 *   - `imdbVotes` is comma-grouped: "1,234,567".
 *   - Whether a given source appears at all varies per title. A film with no
 *     Rotten Tomatoes entry simply omits it rather than sending a null.
 */

export interface OmdbRatingEntry {
  Source?: string | null;
  Value?: string | null;
}

export interface OmdbResponse {
  Response?: string;
  Error?: string;
  Ratings?: OmdbRatingEntry[];
  imdbRating?: string | null;
  imdbVotes?: string | null;
  Metascore?: string | null;
}

/** OMDb's own long-form name for IMDb inside `Ratings[]`. */
const IMDB_SOURCE_LABEL = "internet movie database";
const ROTTEN_TOMATOES_SOURCE_LABEL = "rotten tomatoes";
const METACRITIC_SOURCE_LABEL = "metacritic";

/** OMDb uses this string for every absent value, in every field. */
function isPresent(value: string | null | undefined): value is string {
  const trimmed = value?.trim();
  return !!trimmed && trimmed.toUpperCase() !== "N/A";
}

/**
 * Pulls the leading number out of an OMDb display string.
 * "8.4/10" -> 8.4, "85%" -> 85, "72/100" -> 72.
 *
 * Returns null for anything non-numeric rather than NaN, so a malformed value
 * drops that one source instead of rendering "NaN/10" on the page.
 */
function leadingNumber(value: string | null | undefined): number | null {
  if (!isPresent(value)) return null;
  const match = value.trim().match(/^-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number.parseFloat(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

/** "1,234,567" -> 1234567. */
function parseVotes(value: string | null | undefined): number | null {
  if (!isPresent(value)) return null;
  const parsed = Number.parseInt(value.replace(/,/g, ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Guards against a source reporting a value outside its own scale, which
 *  would render as a bar overflowing its track. */
function inRange(value: number, max: number): boolean {
  return value >= 0 && value <= max;
}

function findRating(
  ratings: OmdbRatingEntry[] | undefined,
  label: string,
): string | null {
  const entry = (ratings ?? []).find(
    (candidate) => candidate.Source?.trim().toLowerCase() === label,
  );
  return entry?.Value ?? null;
}

/**
 * Returns [] rather than throwing for a title OMDb simply has no record of —
 * "no data for this title" is a normal outcome, not a failure, and the detail
 * page still renders with TMDB's own score.
 */
export function toExternalRatings(raw: OmdbResponse): ExternalRating[] {
  // OMDb reports "not found" as a 200 with Response:"False". Treated as empty,
  // not as an error, deliberately — see the note above.
  if (raw.Response === "False") return [];

  const ratings: ExternalRating[] = [];

  // IMDb: prefer the top-level `imdbRating` over the Ratings[] entry. Both
  // carry the same number, but only the top level pairs with `imdbVotes`, and
  // the top level is present on some responses where Ratings[] is empty.
  const imdb =
    leadingNumber(raw.imdbRating) ?? leadingNumber(findRating(raw.Ratings, IMDB_SOURCE_LABEL));
  if (imdb !== null && inRange(imdb, 10)) {
    ratings.push({
      source: "imdb",
      value: imdb,
      scale: "ten",
      votes: parseVotes(raw.imdbVotes),
    });
  }

  // Rotten Tomatoes has no top-level field — Ratings[] is the only source.
  const rt = leadingNumber(findRating(raw.Ratings, ROTTEN_TOMATOES_SOURCE_LABEL));
  if (rt !== null && inRange(rt, 100)) {
    ratings.push({ source: "rotten_tomatoes", value: rt, scale: "percent", votes: null });
  }

  const metacritic =
    leadingNumber(raw.Metascore) ??
    leadingNumber(findRating(raw.Ratings, METACRITIC_SOURCE_LABEL));
  if (metacritic !== null && inRange(metacritic, 100)) {
    ratings.push({ source: "metacritic", value: metacritic, scale: "hundred", votes: null });
  }

  return ratings;
}
