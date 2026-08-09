import type { MediaType, PagedResult, TitleSummary } from "@/lib/content/types";

import {
  isUnsupportedRow,
  resolveByExternalId,
  resolveByTitle,
  unmatchedRow,
} from "./classify";
import { normalizeTitle } from "./normalize";
import type { ImportRow, ResolvedRow } from "./types";

/**
 * Turning parsed rows into resolved ones — the only part of the matching
 * pipeline that talks to a content provider.
 *
 * Takes its dependencies as a parameter rather than importing
 * `getContentProvider()`, so the whole orchestration (dedup, tiering,
 * concurrency, per-row failure isolation) is testable against a fake with no
 * network and no mocking framework. The real caller is the batched
 * `/api/import/resolve` route.
 */

/** The narrow slice of `ContentProvider` this needs. Deliberately not the
 *  whole interface: it documents exactly which two calls an import can make,
 *  which is also the answer to "what does a 3,000-row import cost upstream?" */
export interface ResolveDeps {
  findByExternalId(imdbId: string): Promise<TitleSummary[]>;
  searchTitles(query: string): Promise<PagedResult<TitleSummary>>;
  /** Confirms a TMDB id the SOURCE supplied. Rejects with `not_found` for an
   *  id that no longer exists, which is why this is a confirmation rather
   *  than a bare trust. */
  getTitle(id: string, mediaType: MediaType): Promise<TitleSummary>;
}

/**
 * The key that decides whether two rows can share one lookup.
 *
 * This is where most of the upstream saving comes from: a Letterboxd diary
 * holds one row per VIEWING, so a film watched four times is four rows and
 * exactly one lookup. Across a real diary that is a large reduction, and it
 * happens before any request is made rather than being absorbed by a cache
 * afterwards.
 *
 * Ordering is by descending trustworthiness — an IMDb id identifies a film
 * exactly, a Letterboxd slug identifies it within Letterboxd's own namespace,
 * and a normalized title+year is a guess. Rows with different keys are never
 * merged even when they turn out to be the same film; that costs an extra
 * lookup and cannot cause a wrong grouping.
 */
export function dedupKey(row: ImportRow): string {
  // Ours first: it identifies the title in the namespace we actually store,
  // with no translation step that could fail.
  if (row.tmdbId) return `tmdb:${row.tmdbId}`;
  if (row.imdbId) return `imdb:${row.imdbId}`;
  if (row.slug) return `slug:${row.slug}`;
  return `title:${normalizeTitle(row.title)}:${row.year ?? "?"}`;
}

/**
 * Rows that need no lookup at all: this step cannot import them, so spending
 * a request to find out what they are would be pure waste.
 *
 * ============================================================================
 * ONE PREDICATE, IMPORTED — NOT A SECOND COPY
 * ============================================================================
 * This used to be its own `row.mediaTypeHint !== "episode"` check, duplicating
 * what `classify.ts` already knew. When episode import shipped and the
 * classifier's copy was updated, this one was not — so every episode row was
 * silently skipped before any lookup and fell out as `unmatched`, with zero
 * candidates, for a show whose IMDb id resolved perfectly well on its own.
 *
 * Nothing failed. The endpoint returned 200 and the UI showed "No matches
 * found", which is indistinguishable from a genuine miss. It was caught by
 * querying `/api/content/find/tt0903747` by hand and seeing it answer
 * correctly while the resolver claimed nothing.
 *
 * Importing the predicate makes the two impossible to disagree.
 */
function needsLookup(row: ImportRow): boolean {
  return !isUnsupportedRow(row);
}

/** Runs `fn` over `items` with at most `limit` in flight. A plain
 *  `Promise.all` over 3,000 rows would open 3,000 sockets at once; a
 *  sequential loop would take minutes. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  });

  await Promise.all(workers);
  return results;
}

/** The media type a TMDB id must be looked up under. An `unknown` hint
 *  cannot choose, and guessing would fetch the wrong catalogue entirely. */
function resolvableMediaType(row: ImportRow): MediaType | null {
  if (row.mediaTypeHint === "movie") return "movie";
  // An episode belongs to a series, so its id is a TV id.
  if (row.mediaTypeHint === "tv" || row.mediaTypeHint === "episode") return "tv";
  return null;
}

export interface ResolveOptions {
  /** Simultaneous upstream requests. Four is comfortably inside TMDB's limits
   *  without needing to track their exact current number, and keeps one
   *  import from monopolizing the connection pool. */
  concurrency?: number;
}

/**
 * Resolves one representative row per dedup group, then applies that outcome
 * to every row in the group.
 *
 * ============================================================================
 * TIER ORDER, AND WHY A FAILED TIER 1 FALLS THROUGH
 * ============================================================================
 * A row with an IMDb id tries `findByExternalId` first. If that returns
 * exactly one title the row is `exact` and done — no search, no scoring.
 *
 * If it returns NOTHING, the row falls through to title matching rather than
 * being marked unmatched. TMDB genuinely lacks external-id mappings for some
 * titles it otherwise carries, and giving up there would send a row to the
 * review queue that a plain title search resolves confidently.
 *
 * If it returns MORE than one, the row is ambiguous and does NOT fall through
 * — a title search cannot resolve a genuine id collision, and running one
 * would replace a known-ambiguous answer with a differently-ambiguous one.
 *
 * Tier 0 sits above both: a source that already knows OUR id needs no
 * translation at all. See the comment at its call site.
 */
async function resolveGroup(row: ImportRow, deps: ResolveDeps): Promise<ResolvedRow> {
  try {
    // ---- Tier 0: the source already knows OUR id -----------------------
    // Confirmed rather than trusted blindly: a stale id rejects with
    // `not_found` and falls through, which is better than writing a tracking
    // entry pointing at a title that no longer exists. Confirmation costs
    // one call — the same as the IMDb translation it replaces — so the win
    // here is COVERAGE, not speed: a community Trakt export with `tmdb` ids
    // and no `year` has no other path to `confident` at all.
    const mediaType = resolvableMediaType(row);
    if (row.tmdbId && mediaType) {
      try {
        return resolveByExternalId(row, await deps.getTitle(row.tmdbId, mediaType));
      } catch {
        // Fall through to the id-translation and title tiers.
      }
    }

    if (row.imdbId) {
      const found = await deps.findByExternalId(row.imdbId);
      if (found.length === 1) return resolveByExternalId(row, found[0]);
      if (found.length > 1) return resolveByTitle(row, found);
      // Zero — fall through to Tier 2.
    }

    const query = row.title.trim() || row.originalTitle?.trim() || "";
    if (!query) return unmatchedRow(row);

    const page = await deps.searchTitles(query);
    if (page.items.length === 0) return unmatchedRow(row);

    return resolveByTitle(row, page.items);
  } catch {
    // One row's upstream failure must not fail the whole import. It becomes
    // an unmatched row the user can resolve by hand — visibly present in the
    // review queue rather than silently missing from the results.
    return unmatchedRow(row);
  }
}

export async function resolveRows(
  rows: readonly ImportRow[],
  deps: ResolveDeps,
  options: ResolveOptions = {},
): Promise<ResolvedRow[]> {
  const groups = new Map<string, ImportRow[]>();
  const skipped: ImportRow[] = [];

  for (const row of rows) {
    if (!needsLookup(row)) {
      skipped.push(row);
      continue;
    }
    const key = dedupKey(row);
    const existing = groups.get(key);
    if (existing) existing.push(row);
    else groups.set(key, [row]);
  }

  const keys = [...groups.keys()];
  const outcomes = await mapWithConcurrency(keys, options.concurrency ?? 4, (key) =>
    resolveGroup(groups.get(key)![0], deps),
  );

  const resolved = new Map<string, ResolvedRow>();
  keys.forEach((key, index) => resolved.set(key, outcomes[index]));

  // Rebuilt in the ORIGINAL row order, not group order — the review queue and
  // the preview both show rows against their source line numbers, and a
  // reordered list would make those impossible to follow.
  return rows.map((row) => {
    if (!needsLookup(row)) return unmatchedRow(row);
    const outcome = resolved.get(dedupKey(row))!;
    // Each row carries its OWN data (its date, its rating, its line number)
    // with the group's shared match result.
    return { ...outcome, row };
  });
}

/** How many upstream lookups a set of rows will actually cost. Shown before
 *  resolution starts, so a large import can state its cost up front instead
 *  of being a progress bar of unknown length. */
export function lookupCount(rows: readonly ImportRow[]): number {
  return new Set(rows.filter(needsLookup).map(dedupKey)).size;
}
