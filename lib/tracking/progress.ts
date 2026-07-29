import {
  addRange,
  countRanges,
  normalizeRanges,
  rangesContain,
  removeRange,
} from "./ranges";
import type {
  EpisodeRange,
  SeasonEpisodeCounts,
  TrackingEntry,
  TrackingStatus,
  TvTrackingEntry,
  WatchedEpisodes,
} from "./types";

/**
 * Episode-progress operations and queries.
 *
 * Every function here is pure: no storage, no React, no dates. Mutating
 * operations take a `WatchedEpisodes` and return a new one; queries derive
 * values and store nothing. That split is what keeps the persistence layer
 * (context.tsx) down to a single generic "apply this transform, write once,
 * roll back on failure" path.
 *
 * **Nothing derived is ever persisted.** Episodes remaining, percent
 * complete, and next-unwatched are all computed on read from the ranges plus
 * the season list. Season structure is passed in rather than stored, because
 * it is provider data that goes stale — a returning show airing episode 9
 * would silently make a cached total wrong.
 *
 * SPECIALS (season 0) are trackable but excluded from completion math:
 * `totalCount`, `percentComplete` and `nextUnwatched` all ignore season 0.
 * Most trackers behave this way, and the alternative is worse — a show would
 * never reach 100% until you'd watched every retrospective and blooper reel.
 */

export interface EpisodeRef {
  seasonNumber: number;
  episodeNumber: number;
}

export interface TitleProgress {
  /** Episodes watched in numbered seasons, clamped to what actually exists. */
  watchedCount: number;
  /** Episodes that exist in numbered seasons. 0 if season data is unavailable. */
  totalCount: number;
  remaining: number;
  /** 0–100. Only ever exactly 100 when genuinely complete — see below. */
  percentComplete: number;
  nextUnwatched: EpisodeRef | null;
  isComplete: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Numbered seasons only, ascending. Excludes specials. */
function numberedSeasons(seasons: SeasonEpisodeCounts) {
  return seasons
    .filter((season) => season.seasonNumber >= 1 && season.episodeCount >= 1)
    .slice()
    .sort((a, b) => a.seasonNumber - b.seasonNumber);
}

function episodeCountFor(
  seasons: SeasonEpisodeCounts,
  seasonNumber: number,
): number {
  return (
    seasons.find((season) => season.seasonNumber === seasonNumber)
      ?.episodeCount ?? 0
  );
}

/**
 * Writes a season's ranges while preserving sparseness — a season that ends
 * up with nothing watched loses its key rather than persisting `[]` forever.
 */
function withSeason(
  watched: WatchedEpisodes,
  seasonNumber: number,
  ranges: EpisodeRange[],
): WatchedEpisodes {
  const next = { ...watched };
  if (ranges.length === 0) delete next[seasonNumber];
  else next[seasonNumber] = ranges;
  return next;
}

/**
 * Discards anything beyond a season's real length.
 *
 * Stored ranges can outlive the data that justified them: a season trimmed
 * from 13 episodes to 10 by the provider would otherwise let a `[1,13]` range
 * count 13 watched out of 10 and report 130% complete.
 */
function clampRanges(
  ranges: readonly EpisodeRange[],
  episodeCount: number,
): EpisodeRange[] {
  if (episodeCount < 1) return [];
  return normalizeRanges(
    ranges
      .filter(([start]) => start <= episodeCount)
      .map(([start, end]): EpisodeRange => [start, Math.min(end, episodeCount)]),
  );
}

/**
 * First unwatched episode in a season, or null if the season is complete.
 *
 * O(1) rather than a scan, and that falls directly out of the canonical
 * invariant from ./ranges.ts: because stored ranges are sorted AND
 * non-adjacent, if the first range starts at 1 then a gap is guaranteed
 * immediately after it ends. No loop over episode numbers is needed.
 */
function firstUnwatchedIn(
  ranges: readonly EpisodeRange[],
  episodeCount: number,
): number | null {
  if (episodeCount < 1) return null;
  if (ranges.length === 0) return 1;
  if (ranges[0][0] > 1) return 1;
  const candidate = ranges[0][1] + 1;
  return candidate <= episodeCount ? candidate : null;
}

// ---------------------------------------------------------------------------
// Coarse <-> fine reconciliation
// ---------------------------------------------------------------------------

/**
 * Expands a coarse `status: "watched"` into concrete ranges.
 *
 * This closes the gap left open by the v1 -> v2 migration (see ./store.ts).
 * A migrated record — or one marked watched via the title-level button, which
 * has no season list to work from — carries `status: "watched"` with empty
 * `watchedEpisodes`. Without this, the first per-episode edit would start
 * from "nothing watched" and silently throw away the user's earlier statement
 * that they'd seen the whole show.
 *
 * Deliberately NOT a migration: it needs season data, which a pure
 * synchronous migration cannot fetch. It runs at the point of use, where the
 * season list is already in hand.
 *
 * Applied on read too (see `getTitleProgress`), so queries agree with what a
 * subsequent edit would do.
 */
export function reconcileCoarseWatched(
  entry: TvTrackingEntry,
  seasons: SeasonEpisodeCounts,
): WatchedEpisodes {
  if (entry.status !== "watched") return entry.watchedEpisodes;
  if (Object.keys(entry.watchedEpisodes).length > 0) return entry.watchedEpisodes;

  const backfilled: WatchedEpisodes = {};
  for (const season of numberedSeasons(seasons)) {
    backfilled[season.seasonNumber] = [[1, season.episodeCount]];
  }
  return backfilled;
}

/**
 * The status a title should have given its episode progress.
 *
 * Returns `current` unchanged when season data is unavailable — guessing
 * would be worse than leaving a correct coarse status alone.
 */
export function deriveStatus(
  current: TrackingStatus,
  watched: WatchedEpisodes,
  seasons: SeasonEpisodeCounts,
): TrackingStatus {
  const total = totalEpisodeCount(seasons);
  if (total === 0) return current;

  const count = watchedEpisodeCount(watched, seasons);
  if (count >= total) return "watched";
  if (count > 0) return "watching";

  // Nothing watched. A show whose episodes were all unmarked should not stay
  // labelled "watched", but it also shouldn't lose an explicit watchlist
  // choice, so only the now-contradictory "watched" is downgraded.
  return current === "watched" ? "watchlist" : current;
}

// ---------------------------------------------------------------------------
// Operations — each returns a new WatchedEpisodes, each is ONE store write
// ---------------------------------------------------------------------------

export function markEpisode(
  watched: WatchedEpisodes,
  seasonNumber: number,
  episodeNumber: number,
): WatchedEpisodes {
  if (!Number.isInteger(episodeNumber) || episodeNumber < 1) return watched;
  return withSeason(
    watched,
    seasonNumber,
    addRange(watched[seasonNumber] ?? [], [episodeNumber, episodeNumber]),
  );
}

export function unmarkEpisode(
  watched: WatchedEpisodes,
  seasonNumber: number,
  episodeNumber: number,
): WatchedEpisodes {
  if (!Number.isInteger(episodeNumber) || episodeNumber < 1) return watched;
  return withSeason(
    watched,
    seasonNumber,
    removeRange(watched[seasonNumber] ?? [], [episodeNumber, episodeNumber]),
  );
}

/**
 * Mark an entire season.
 *
 * ONE range covering the whole season, regardless of whether it has 6
 * episodes or 28 — which is what makes this a single store write rather than
 * N. This is the requirement that most directly justified the range encoding.
 */
export function markSeason(
  watched: WatchedEpisodes,
  seasons: SeasonEpisodeCounts,
  seasonNumber: number,
): WatchedEpisodes {
  const episodeCount = episodeCountFor(seasons, seasonNumber);
  if (episodeCount < 1) return watched;
  return withSeason(watched, seasonNumber, [[1, episodeCount]]);
}

export function unmarkSeason(
  watched: WatchedEpisodes,
  seasonNumber: number,
): WatchedEpisodes {
  return withSeason(watched, seasonNumber, []);
}

/**
 * "I binged to here" — mark everything up to and including S{season}E{episode}.
 *
 * Two decisions worth knowing about:
 *
 * 1. **Union, not replace.** Anything already watched *beyond* the target
 *    stays watched. Marking up to S3E7 must not unmark an S5E1 the user had
 *    already ticked off out of order.
 * 2. **Specials are opt-in.** Sweeping prior seasons skips season 0 entirely,
 *    so binging the main run never implicitly marks retrospectives and
 *    bloopers watched. Targeting season 0 directly still works and affects
 *    only season 0.
 *
 * Still one store write no matter how many seasons it spans.
 */
export function markWatchedUpTo(
  watched: WatchedEpisodes,
  seasons: SeasonEpisodeCounts,
  seasonNumber: number,
  episodeNumber: number,
): WatchedEpisodes {
  if (!Number.isInteger(episodeNumber) || episodeNumber < 1) return watched;

  let next: WatchedEpisodes = { ...watched };

  if (seasonNumber >= 1) {
    for (const season of numberedSeasons(seasons)) {
      if (season.seasonNumber >= seasonNumber) break; // ascending, so done
      // A full-season range is a superset of whatever was there, so this is
      // already a union.
      next[season.seasonNumber] = [[1, season.episodeCount]];
    }
  }

  const cap = episodeCountFor(seasons, seasonNumber);
  const target = cap >= 1 ? Math.min(episodeNumber, cap) : episodeNumber;
  next = withSeason(
    next,
    seasonNumber,
    addRange(next[seasonNumber] ?? [], [1, target]),
  );

  return next;
}

// ---------------------------------------------------------------------------
// Queries — all derived, nothing stored
// ---------------------------------------------------------------------------

export function isEpisodeWatched(
  watched: WatchedEpisodes,
  seasonNumber: number,
  episodeNumber: number,
): boolean {
  return rangesContain(watched[seasonNumber] ?? [], episodeNumber);
}

export function totalEpisodeCount(seasons: SeasonEpisodeCounts): number {
  return numberedSeasons(seasons).reduce(
    (total, season) => total + season.episodeCount,
    0,
  );
}

export function watchedEpisodeCount(
  watched: WatchedEpisodes,
  seasons: SeasonEpisodeCounts,
): number {
  return numberedSeasons(seasons).reduce((total, season) => {
    const ranges = watched[season.seasonNumber];
    if (!ranges) return total;
    return total + countRanges(clampRanges(ranges, season.episodeCount));
  }, 0);
}

export function nextUnwatchedEpisode(
  watched: WatchedEpisodes,
  seasons: SeasonEpisodeCounts,
): EpisodeRef | null {
  for (const season of numberedSeasons(seasons)) {
    const ranges = clampRanges(
      watched[season.seasonNumber] ?? [],
      season.episodeCount,
    );
    const episodeNumber = firstUnwatchedIn(ranges, season.episodeCount);
    if (episodeNumber !== null) {
      return { seasonNumber: season.seasonNumber, episodeNumber };
    }
  }
  return null;
}

/**
 * Everything the UI needs about a title's progress, in one pass.
 *
 * Accepts an absent entry (an untracked show reports 0 watched, with S1E1 as
 * the next episode) and a movie entry (no episode concept — all zeros).
 */
export function getTitleProgress(
  entry: TrackingEntry | undefined,
  seasons: SeasonEpisodeCounts,
): TitleProgress {
  const totalCount = totalEpisodeCount(seasons);

  const watched: WatchedEpisodes =
    entry?.mediaType === "tv" ? reconcileCoarseWatched(entry, seasons) : {};

  const watchedCount = watchedEpisodeCount(watched, seasons);
  const isComplete = totalCount > 0 && watchedCount >= totalCount;

  return {
    watchedCount,
    totalCount,
    remaining: Math.max(0, totalCount - watchedCount),
    // Floor, capped at 99 until genuinely complete: 61 of 62 episodes rounds
    // to 98.4% -> 98, and a user who is one episode short must never see
    // "100%". Only real completion returns 100.
    percentComplete:
      totalCount === 0
        ? 0
        : isComplete
          ? 100
          : Math.min(99, Math.floor((watchedCount / totalCount) * 100)),
    nextUnwatched: isComplete ? null : nextUnwatchedEpisode(watched, seasons),
    isComplete,
  };
}
