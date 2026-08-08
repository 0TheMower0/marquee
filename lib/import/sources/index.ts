import type { CsvTable } from "../csv";
import type { ImportRow, ImportSource } from "../types";

import { detectImdbSource, parseImdbRatings, parseImdbWatchlist } from "./imdb";
import {
  detectLetterboxdSource,
  parseLetterboxdDiary,
  parseLetterboxdRatings,
  parseLetterboxdWatched,
  parseLetterboxdWatchlist,
} from "./letterboxd";

export { isAmbiguousLetterboxdTable } from "./letterboxd";

/**
 * Which export a file is, from its header (and, for the one case headers
 * cannot resolve, its name).
 *
 * IMDb is tested first because its markers are strictly more specific: an
 * IMDb export carries `Const`, which no Letterboxd file has, so there is no
 * ordering hazard in either direction. The order is stated rather than
 * incidental so a later source added to this list gets the same consideration.
 */
export function detectSource(table: CsvTable, filename?: string): ImportSource | null {
  return detectImdbSource(table) ?? detectLetterboxdSource(table, filename);
}

const PARSERS: Record<ImportSource, (table: CsvTable) => ImportRow[]> = {
  "imdb-ratings": parseImdbRatings,
  "imdb-watchlist": parseImdbWatchlist,
  "letterboxd-diary": parseLetterboxdDiary,
  "letterboxd-ratings": parseLetterboxdRatings,
  "letterboxd-watched": parseLetterboxdWatched,
  "letterboxd-watchlist": parseLetterboxdWatchlist,
};

/** Parses a table as a KNOWN source. Detection is a separate step so the UI
 *  can let the user override a guess (or answer the watchlist/watched
 *  question) before any rows are produced. */
export function parseAs(table: CsvTable, source: ImportSource): ImportRow[] {
  return PARSERS[source](table);
}

/** Convenience for the common path: detect, then parse. Returns null when the
 *  file is not a supported export, so the caller can say so specifically
 *  rather than reporting zero rows. */
export function parseTable(
  table: CsvTable,
  filename?: string,
): { source: ImportSource; rows: ImportRow[] } | null {
  const source = detectSource(table, filename);
  if (!source) return null;
  return { source, rows: parseAs(table, source) };
}
