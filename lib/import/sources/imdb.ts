import { hasColumns, type CsvTable } from "../csv";
import { toDayKey } from "../dates";
import {
  normalizeImdbRating,
  parseYear,
  type ImportRow,
  type ImportSource,
  type MediaTypeHint,
} from "../types";

/**
 * IMDb CSV exports.
 *
 * Columns verified against multiple independent sources (see
 * `docs/phase-7-import-design.md` §0) rather than recalled:
 *
 *   ratings.csv    Const, Your Rating, Date Rated, Title, URL, Title Type,
 *                  IMDb Rating, Runtime (mins), Year, Genres, Num Votes,
 *                  Release Date, Directors
 *
 *   watchlist.csv  Position, Const, Created, Modified, Description, Title,
 *                  Original Title, URL, Title Type, IMDb Rating,
 *                  Runtime (mins), Year, Genres, Num Votes, Release Date,
 *                  Directors, Your Rating, Date Rated
 *
 * `Const` is the IMDb id (`tt0068646`), which is what makes IMDb imports
 * almost entirely Tier 1 exact matching — the review queue barely engages.
 * Letterboxd has no equivalent, which is why it does.
 */

const RATINGS_MARKERS = ["Const", "Your Rating", "Date Rated"] as const;
const WATCHLIST_MARKERS = ["Const", "Position", "Created"] as const;

/**
 * Identifies which IMDb export a table is from its HEADER, never its filename
 * — people rename downloads, and both files live in the same account export.
 *
 * Watchlist is checked first: a watchlist export also carries `Your Rating`
 * and `Date Rated` columns, so testing for ratings first would misidentify it.
 * The columns unique to a watchlist (`Position`, `Created`) are the
 * discriminator.
 */
export function detectImdbSource(table: CsvTable): ImportSource | null {
  if (hasColumns(table, WATCHLIST_MARKERS)) return "imdb-watchlist";
  if (hasColumns(table, RATINGS_MARKERS)) return "imdb-ratings";
  return null;
}

/**
 * IMDb's `Title Type` vocabulary.
 *
 * Shorts map to `movie` rather than being rejected: TMDB carries a great many
 * short films, and refusing them would silently discard rows a user
 * deliberately rated. They will simply fail to match more often than features
 * do, which surfaces honestly in the review queue instead of vanishing.
 *
 * `tvEpisode` maps to `episode`, which this step classifies as unsupported —
 * resolvable via TMDB's `/find` (`tv_episode_results`), and deferred rather
 * than dismissed. See design doc §9.
 */
const TITLE_TYPE: Record<string, MediaTypeHint> = {
  movie: "movie",
  tvmovie: "movie",
  video: "movie",
  short: "movie",
  tvshort: "movie",
  tvspecial: "movie",
  tvseries: "tv",
  tvminiseries: "tv",
  tvepisode: "episode",
};

function mediaTypeHint(raw: string | null): MediaTypeHint {
  if (!raw) return "unknown";
  return TITLE_TYPE[raw.trim().toLowerCase().replace(/[\s_-]/g, "")] ?? "unknown";
}

/** `tt0068646`. Anything else is not an IMDb id and must not be sent to
 *  TMDB's `/find` as if it were — a malformed id there returns empty results,
 *  which would look like "no such film" rather than "bad input". */
function imdbId(raw: string | null): string | null {
  if (!raw) return null;
  const value = raw.trim();
  return /^tt\d{7,10}$/i.test(value) ? value.toLowerCase() : null;
}

function baseRow(
  record: CsvTable["rows"][number],
  source: ImportSource,
): Omit<ImportRow, "intent" | "score" | "watchedOn"> {
  return {
    source,
    // The line number alone is a stable, unique key within one file, and it
    // subsumes every finer distinction (two rows for the same film on the
    // same date are still two lines). A re-export with different content is a
    // different file and therefore a different importId.
    sourceRowId: `${source}:${record.line}`,
    imdbId: imdbId(record.get("Const")),
    title: record.get("Title") ?? "",
    originalTitle: record.get("Original Title"),
    year: parseYear(record.get("Year")),
    slug: null,
    mediaTypeHint: mediaTypeHint(record.get("Title Type")),
    ratedOn: toDayKey(record.get("Date Rated")),
    isRewatch: false,
    sourceLine: record.line,
  };
}

/**
 * A ratings export.
 *
 * `intent: "rating-only"` — a rating implies the title was watched (and the
 * commit step sets `watched` accordingly), but IMDb records no watch DATE, so
 * `watchedOn` is null and no watch-log event is created. `Date Rated` is when
 * you rated it, which is a different fact; using it as a watch date is an
 * explicit opt-in handled at commit time, never here. Inventing dates is what
 * the watch log's no-backfill rule exists to refuse.
 */
export function parseImdbRatings(table: CsvTable): ImportRow[] {
  return table.rows
    .map((record) => ({
      ...baseRow(record, "imdb-ratings"),
      score: normalizeImdbRating(record.get("Your Rating")),
      watchedOn: null,
      intent: "rating-only" as const,
    }))
    .filter((row) => row.title.length > 0);
}

/**
 * A watchlist export.
 *
 * `Created` is when the title was added to the watchlist — genuinely not a
 * watch date, and not used as one. A watchlist row that also carries a
 * `Your Rating` value keeps it: the two facts are independent, and the commit
 * step's max-progress rule resolves the apparent conflict.
 */
export function parseImdbWatchlist(table: CsvTable): ImportRow[] {
  return table.rows
    .map((record) => ({
      ...baseRow(record, "imdb-watchlist"),
      score: normalizeImdbRating(record.get("Your Rating")),
      watchedOn: null,
      intent: "watchlist" as const,
    }))
    .filter((row) => row.title.length > 0);
}
