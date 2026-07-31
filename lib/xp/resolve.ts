import {
  countRanges,
  getSeasonProgress,
  type MovieTrackingEntry,
  type SeasonEpisodeCounts,
  type TvTrackingEntry,
  type WatchedEpisodes,
} from "@/lib/tracking";

import { DEFAULT_MOVIE_RUNTIME_MINUTES } from "./formula";

/**
 * Bridges tracking-shaped data into the plain numbers `computeXp` wants.
 * Pure and tested on its own, kept separate from the orchestration hook
 * (components/profile/use-xp.ts) so the business rules here — which count
 * wins when both exist, what "complete" means, what to do with unaired
 * episodes — are verifiable without mounting a component or faking a fetch.
 *
 * Safe to import `@/lib/tracking`'s public barrel here: lib/tracking does
 * not import lib/xp anywhere, so this is a one-way dependency, not a cycle.
 * (Contrast lib/watchlog, which IS imported by lib/tracking/context.tsx and
 * therefore has to avoid the barrel — see the note there.)
 */

/**
 * How many episodes of one show count toward XP.
 *
 * Real per-episode ranges are authoritative whenever they exist — `countRanges`
 * is exact. The fallback to `knownEpisodeCount` fires ONLY when ranges are
 * empty AND the show is "watched": that is specifically the coarse-mark case
 * (see the doc comment on `TvTrackingEntry.knownEpisodeCount`), not a "watching"
 * show that simply has no progress yet, which should legitimately score 0.
 */
export function episodesWatchedFor(entry: TvTrackingEntry): number {
  const fromRanges = Object.values(entry.watchedEpisodes).reduce(
    (sum, ranges) => sum + countRanges(ranges),
    0,
  );
  if (fromRanges > 0) return fromRanges;
  return entry.status === "watched" ? (entry.knownEpisodeCount ?? 0) : 0;
}

/** Real runtime when captured, the flat fallback otherwise. */
export function movieRuntimeMinutesFor(entry: MovieTrackingEntry): number {
  return entry.runtimeMinutes ?? DEFAULT_MOVIE_RUNTIME_MINUTES;
}

/**
 * How many of a show's seasons are currently fully complete.
 *
 * Takes `watchedEpisodes` directly rather than the whole entry, and does NOT
 * run `reconcileCoarseWatched` — this is only ever called for "watching"
 * shows (see the scoping note on `SEASON_COMPLETE_BONUS_XP`), where empty
 * ranges genuinely mean "nothing watched yet," not the "watched, but coarse"
 * ambiguity that reconciliation exists to resolve.
 *
 * Season 0 (Specials) is excluded, matching the existing completion-math rule
 * documented in CLAUDE.md for `getTitleProgress` — a show should not need to
 * clear its blooper reel to earn a season bonus.
 */
export function completedSeasonsFor(
  watchedEpisodes: WatchedEpisodes,
  seasons: SeasonEpisodeCounts,
): number {
  let count = 0;
  for (const season of seasons) {
    if (season.seasonNumber === 0) continue;
    const progress = getSeasonProgress(watchedEpisodes, season.seasonNumber, season.episodeCount);
    if (progress.isComplete) count += 1;
  }
  return count;
}
