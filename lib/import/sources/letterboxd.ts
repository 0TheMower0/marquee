import { hasColumns, type CsvTable } from "../csv";
import { toDayKey } from "../dates";
import {
  normalizeLetterboxdRating,
  parseYear,
  type ImportRow,
  type ImportSource,
} from "../types";

/**
 * Letterboxd CSV exports (the files inside the account-export ZIP).
 *
 * Columns verified (design doc §0):
 *
 *   diary.csv      Date, Name, Year, Letterboxd URI, Rating, Rewatch, Tags,
 *                  Watched Date
 *   ratings.csv    Date, Name, Year, Letterboxd URI, Rating
 *   watchlist.csv  Date, Name, Year, Letterboxd URI
 *   watched.csv    Date, Name, Year, Letterboxd URI
 *
 * ============================================================================
 * NO IDS. THIS IS THE DEFINING CONSTRAINT.
 * ============================================================================
 * Letterboxd exports carry no IMDb id and no TMDB id — only a `Letterboxd
 * URI` — despite Letterboxd itself being TMDB-sourced. So **every Letterboxd
 * row goes through title+year matching**, and the review queue is the main
 * path for this source rather than an edge case. Scraping the film page for
 * its TMDB link was considered and rejected (design doc §0.1).
 *
 * `Letterboxd URI` is still parsed for its slug, which is used as a dedup key
 * and a matching signal — it is Letterboxd's own canonical, disambiguated
 * name for the film — but it is never fetched.
 */

/** Diary and ratings are identifiable from their headers alone. */
const DIARY_MARKERS = ["Name", "Watched Date"] as const;
const RATINGS_MARKERS = ["Name", "Rating"] as const;
const MINIMAL_MARKERS = ["Name", "Year", "Letterboxd URI"] as const;

/**
 * ============================================================================
 * WHY THIS TAKES A FILENAME
 * ============================================================================
 * `watchlist.csv` and `watched.csv` have **byte-identical headers**
 * (`Date, Name, Year, Letterboxd URI`). No amount of header inspection can
 * tell them apart, and confusing them is not a cosmetic error — it is the
 * difference between "I plan to watch this" and "I have seen this", which
 * would corrupt the user's library in a way that is tedious to undo.
 *
 * So the filename is the discriminator, which is reliable for the case that
 * matters: inside a Letterboxd export ZIP the names are Letterboxd's own. For
 * a loose file the user renamed, this returns null and the UI asks them which
 * it is — the honest outcome, rather than a coin flip on their watch history.
 */
export function detectLetterboxdSource(
  table: CsvTable,
  filename?: string,
): ImportSource | null {
  if (hasColumns(table, DIARY_MARKERS)) return "letterboxd-diary";
  if (hasColumns(table, RATINGS_MARKERS)) return "letterboxd-ratings";
  if (!hasColumns(table, MINIMAL_MARKERS)) return null;

  const name = (filename ?? "").toLowerCase();
  // "watchlist" is tested first even though neither string contains the
  // other — the ordering is defensive, not load-bearing, and cheap.
  if (name.includes("watchlist")) return "letterboxd-watchlist";
  if (name.includes("watched")) return "letterboxd-watched";
  return null;
}

/** True when a table is a Letterboxd file whose identity depends on its
 *  filename, so the UI knows to ask rather than to reject. */
export function isAmbiguousLetterboxdTable(table: CsvTable): boolean {
  return (
    hasColumns(table, MINIMAL_MARKERS) &&
    !hasColumns(table, DIARY_MARKERS) &&
    !hasColumns(table, RATINGS_MARKERS)
  );
}

/**
 * The film slug from a `Letterboxd URI`.
 *
 * Two URI shapes appear in one export, which is a real inconsistency in
 * Letterboxd's own output rather than something we introduced: ratings,
 * watched and watchlist link to the FILM page
 * (`letterboxd.com/film/the-godfather/`), while diary links to the
 * user-specific viewing entry (`letterboxd.com/<user>/film/<slug>/<n>/`).
 * Matching on `/film/<slug>` handles both.
 *
 * `boxd.it` short links carry no slug and yield null — a missing signal, not
 * an error.
 */
export function letterboxdSlug(uri: string | null): string | null {
  if (!uri) return null;
  const match = /\/film\/([^/?#\s]+)/.exec(uri);
  return match ? match[1].toLowerCase() : null;
}

function baseRow(
  record: CsvTable["rows"][number],
  source: ImportSource,
): Omit<ImportRow, "intent" | "score" | "watchedOn" | "isRewatch"> {
  return {
    source,
    sourceRowId: `${source}:${record.line}`,
    // Never present. Stated explicitly rather than left implicit, because the
    // whole matching strategy branches on it.
    imdbId: null,
    tmdbId: null,
    title: record.get("Name") ?? "",
    originalTitle: null,
    year: parseYear(record.get("Year")),
    slug: letterboxdSlug(record.get("Letterboxd URI")),
    // Letterboxd is films only.
    mediaTypeHint: "movie",
    ratedOn: null,
    // Films only, so never an episode.
    season: null,
    episode: null,
    // `Watched Date` is a bare calendar date — Letterboxd records no time.
    watchedMinute: null,
    sourceLine: record.line,
  };
}

/**
 * The diary — the only file in any supported export that carries real watch
 * dates, and therefore the only one that can make an imported history produce
 * meaningful streaks and a meaningful Year in Review.
 *
 * `Watched Date` is the date the film was watched. `Date` is the date the
 * entry was logged, which is a different fact and is not used.
 *
 * **Rewatches produce multiple rows for one film, and every one of them
 * becomes its own watch event.** That is correct: three viewings of the same
 * film on three dates is real history, and collapsing them would flatten
 * exactly the data that makes the log worth importing into.
 */
export function parseLetterboxdDiary(table: CsvTable): ImportRow[] {
  return table.rows
    .map((record) => ({
      ...baseRow(record, "letterboxd-diary"),
      score: normalizeLetterboxdRating(record.get("Rating")),
      watchedOn: toDayKey(record.get("Watched Date")),
      isRewatch: (record.get("Rewatch") ?? "").toLowerCase() === "yes",
      intent: "watched" as const,
    }))
    .filter((row) => row.title.length > 0);
}

/** Ratings. Implies watched, carries no watch date — same shape as an IMDb
 *  ratings export, which is why both use `rating-only`. */
export function parseLetterboxdRatings(table: CsvTable): ImportRow[] {
  return table.rows
    .map((record) => ({
      ...baseRow(record, "letterboxd-ratings"),
      score: normalizeLetterboxdRating(record.get("Rating")),
      watchedOn: null,
      isRewatch: false,
      intent: "rating-only" as const,
    }))
    .filter((row) => row.title.length > 0);
}

/**
 * The watched list.
 *
 * `watchedOn` is null despite the name, and that is deliberate: this file's
 * `Date` column is when the film was LOGGED on Letterboxd, not when it was
 * watched. A user who logged 400 films during one evening in 2016 would
 * otherwise import a 400-film day that never happened. The diary is where
 * real dates live; this file contributes status only.
 */
export function parseLetterboxdWatched(table: CsvTable): ImportRow[] {
  return table.rows
    .map((record) => ({
      ...baseRow(record, "letterboxd-watched"),
      score: null,
      watchedOn: null,
      isRewatch: false,
      intent: "watched" as const,
    }))
    .filter((row) => row.title.length > 0);
}

export function parseLetterboxdWatchlist(table: CsvTable): ImportRow[] {
  return table.rows
    .map((record) => ({
      ...baseRow(record, "letterboxd-watchlist"),
      score: null,
      watchedOn: null,
      isRewatch: false,
      intent: "watchlist" as const,
    }))
    .filter((row) => row.title.length > 0);
}
