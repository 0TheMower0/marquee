import { hasColumns, type CsvRecord, type CsvTable } from "../csv";
import { instantToLocalMoment, toDayKey } from "../dates";
import { parseYear, type ImportRow, type ImportSource, type MediaTypeHint } from "../types";

/**
 * Trakt exports.
 *
 * "A Trakt CSV" is two unrelated formats — see `docs/phase-7-import-design.md`
 * §11, where both were verified rather than assumed.
 *
 *   VIP export      wide, and carries `tmdb_id` DIRECTLY — a tier above
 *                   anything else supported, because a TMDB id needs no
 *                   lookup at all. The leading timestamp column names the
 *                   export type: watched_at / rated_at / collected_at /
 *                   listed_at.
 *
 *   Community tool  narrow, and the id column's NAME is its type:
 *                   `imdb,trakt,watched_at,title`. No `year` column at all.
 *
 * ⚠️ **Episode rows describe the SHOW.** `title`, `year` and the ids map to
 * the series; the episode is identified only by `season`/`episode`. That is a
 * hard requirement of `lib/import/review-units.ts`: a parser that put the
 * episode's own id or name in `title` would give every episode a distinct
 * dedup key, and a 62-episode show would arrive as 62 separate review
 * decisions instead of one.
 */

/* ---------------------------------------------------------------------------
 * Ratings — the single most dangerous field in any supported format
 * ------------------------------------------------------------------------ */

/** The user's own score. The ONLY rating column that may ever be read. */
export const TRAKT_USER_RATING_COLUMN = "rating";

/**
 * Community averages. Present in the export, deliberately named here, and
 * never read.
 *
 * Listing them as DATA rather than describing them in a comment is the point:
 * a reviewer can see exactly what is being excluded, and
 * `trakt-rating.test.ts` iterates this list to assert no returned score ever
 * matches one of them. A comment could not be swept over.
 */
export const TRAKT_COMMUNITY_RATING_COLUMNS = [
  "trakt_rating",
  "episode_trakt_rating",
] as const;

/**
 * The user's rating for a row, on our 0–100 scale, or null.
 *
 * ============================================================================
 * THE ONLY PLACE ANY TRAKT RATING COLUMN IS READ
 * ============================================================================
 * Trakt's VIP export puts the user's score and the community average side by
 * side. Reading a community column as the user's score would replace someone's
 * entire rating history with crowd averages — every row plausible, every row
 * wrong, and nothing in the UI to distinguish them from real ratings.
 *
 * **There is deliberately no fallback.** An absent or unparseable `rating`
 * returns null and stops. That is not an oversight to be "fixed" with
 * `?? record.get("trakt_rating")`: the titles with an empty `rating` are
 * exactly the ones the user chose NOT to rate, so a fallback would silently
 * assign a crowd score to precisely the wrong set. It is the mistake most
 * likely to ship, because it reads as defensive coding.
 *
 * Trakt rates 1–10 like IMDb, so ×10 lands on the same 0–100 grid as every
 * other source — a user importing from several does not end up with three
 * scales in one library.
 */
export function readTraktUserRating(record: CsvRecord): number | null {
  const raw = record.get(TRAKT_USER_RATING_COLUMN);
  if (!raw) return null;

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1 || value > 10) return null;
  return Math.round(value * 10);
}

/* ---------------------------------------------------------------------------
 * Detection
 * ------------------------------------------------------------------------ */

/** The leading timestamp column names the export type. Unlike Letterboxd's
 *  watchlist/watched collision, this is unambiguous from the header alone. */
const TIMESTAMP_COLUMNS = ["watched_at", "rated_at", "collected_at", "listed_at"] as const;

/** Id columns we can actually resolve, best first. `trakt` and `tvdb` are
 *  deliberately absent — see `unresolvableIdColumns`. */
const RESOLVABLE_ID_COLUMNS = ["tmdb_id", "imdb_id", "tmdb", "imdb"] as const;

const UNRESOLVABLE_ID_COLUMNS = ["trakt_id", "tvdb_id", "trakt", "tvdb"] as const;

function firstPresent(table: CsvTable, columns: readonly string[]): string | null {
  const present = new Set(table.headers.map((h) => h.trim().toLowerCase()));
  return columns.find((column) => present.has(column)) ?? null;
}

function timestampColumn(table: CsvTable): string | null {
  return firstPresent(table, TIMESTAMP_COLUMNS);
}

/** A Trakt export of either family. Both carry a timestamp column and a
 *  `title`; the VIP one additionally carries `type`. */
export function detectTraktSource(table: CsvTable): ImportSource | null {
  if (!timestampColumn(table)) return null;
  if (!hasColumns(table, ["title"]) && !hasColumns(table, ["show_title"])) return null;

  // `listed_at` is a custom list, which is a watchlist in everything but
  // name; `collected_at` is a library of owned media, which says nothing
  // about having watched it, so it maps to watchlist too rather than
  // silently marking things watched.
  const column = timestampColumn(table);
  if (column === "rated_at") return "trakt-ratings";
  if (column === "watched_at") return "trakt-history";
  return "trakt-watchlist";
}

/**
 * Whether an export carries an id column we cannot resolve, AND no usable
 * alternative.
 *
 * ============================================================================
 * WHY THIS IS SURFACED BEFORE RESOLUTION, NOT AFTER
 * ============================================================================
 * A community-tool export configured with `trakt` or `tvdb` ids has no id we
 * can use and — because that format carries NO `year` column — no way to
 * reach `confident` by title either (design doc §2.3: a missing year can
 * never be an exact year agreement). Every row would land in review.
 *
 * Discovering that after a multi-minute resolve, having spent the upstream
 * budget, is the worst possible moment to learn it. So the UI checks this on
 * the parsed table and says so up front, while re-exporting with a different
 * id format is still a cheap thing to go and do.
 */
export function unresolvableIdColumns(table: CsvTable): string[] {
  if (firstPresent(table, RESOLVABLE_ID_COLUMNS)) return [];
  const present = new Set(table.headers.map((h) => h.trim().toLowerCase()));
  return UNRESOLVABLE_ID_COLUMNS.filter((column) => present.has(column));
}

/** True when a table has neither a resolvable id NOR a year — the shape where
 *  every row is destined for the review queue. */
export function hasNoResolvablePath(table: CsvTable): boolean {
  return (
    firstPresent(table, RESOLVABLE_ID_COLUMNS) === null && !hasColumns(table, ["year"])
  );
}

/* ---------------------------------------------------------------------------
 * Parsing
 * ------------------------------------------------------------------------ */

/** `movie` / `show` / `episode`. Absent in community exports, where the
 *  presence of `season`/`episode` columns is the only signal. */
function mediaTypeHint(record: CsvRecord, isEpisode: boolean): MediaTypeHint {
  if (isEpisode) return "episode";
  const type = record.get("type")?.toLowerCase();
  if (type === "movie") return "movie";
  if (type === "show" || type === "season") return "tv";
  return "unknown";
}

function imdbId(record: CsvRecord): string | null {
  // Show-level only. `episode_imdb_id` is deliberately never read — an
  // episode row must dedup on its SHOW (see the header comment).
  const raw = record.get("imdb_id") ?? record.get("imdb");
  if (!raw) return null;
  return /^tt\d{7,10}$/i.test(raw.trim()) ? raw.trim().toLowerCase() : null;
}

function positiveInt(raw: string | null): number | null {
  if (!raw) return null;
  const value = Number(raw.trim());
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * One Trakt row.
 *
 * Handles both families from one code path, because their differences are
 * all "is this column present" rather than structural.
 */
function toRow(record: CsvRecord, source: ImportSource, timestamp: string | null): ImportRow {
  const season = positiveInt(record.get("season_number") ?? record.get("season"));
  const episodeNumber = positiveInt(record.get("episode_number") ?? record.get("episode"));
  const isEpisode = season !== null && episodeNumber !== null && episodeNumber > 0;

  // The SHOW's title for an episode row. Community exports name it
  // `show_title`; the VIP export uses `title` for the show and puts the
  // episode's own name in `episode_title`, which is never used as identity.
  const title =
    (isEpisode ? record.get("show_title") ?? record.get("title") : record.get("title")) ?? "";

  const raw = timestamp ? record.get(timestamp) : null;
  // Trakt writes an INSTANT, so this converts rather than validates — and it
  // yields a real minute-of-day, which no other supported source can supply.
  // See `instantToLocalMoment` for why reusing `toDayKey` here would be wrong.
  const moment = instantToLocalMoment(raw);

  const watched = source === "trakt-history";

  return {
    source,
    sourceRowId: `${source}:${record.line}`,
    imdbId: imdbId(record),
    title,
    originalTitle: null,
    year: parseYear(record.get("year")),
    slug: null,
    mediaTypeHint: mediaTypeHint(record, isEpisode),
    score: readTraktUserRating(record),
    ratedOn: source === "trakt-ratings" ? moment?.day ?? toDayKey(raw) : null,
    watchedOn: watched ? moment?.day ?? null : null,
    watchedMinute: watched ? moment?.minute ?? null : null,
    season: isEpisode ? season : null,
    episode: isEpisode ? episodeNumber : null,
    isRewatch: false,
    // A `collected_at` row means the user OWNS it, which says nothing about
    // having watched it — mapping that to watched would invent history.
    intent:
      source === "trakt-history"
        ? "watched"
        : source === "trakt-ratings"
          ? "rating-only"
          : "watchlist",
    sourceLine: record.line,
  };
}

export function parseTrakt(table: CsvTable, source: ImportSource): ImportRow[] {
  const timestamp = timestampColumn(table);
  return table.rows
    .map((record) => toRow(record, source, timestamp))
    .filter((row) => row.title.length > 0);
}

/** The TMDB id a row supplies directly, if any — the one case where matching
 *  needs no upstream lookup at all. Returned separately from `ImportRow`
 *  because it is Trakt-specific plumbing, not a domain field every source
 *  would carry. */
export function traktTmdbId(record: CsvRecord): string | null {
  const raw = record.get("tmdb_id") ?? record.get("tmdb");
  if (!raw) return null;
  return /^\d+$/.test(raw.trim()) ? raw.trim() : null;
}
