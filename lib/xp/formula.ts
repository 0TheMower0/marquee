import { DEFAULT_EPISODE_RUNTIME_MINUTES } from "@/lib/tracking";

/**
 * Pure XP math. No storage, no dates, no React — everything here is a
 * function of already-resolved counts, so it is directly testable and can be
 * retuned without a migration (the whole point: XP is COMPUTED, not stored).
 *
 * `DEFAULT_EPISODE_RUNTIME_MINUTES` is imported from lib/tracking (where the
 * Up Next engine already defined it) rather than redeclared here — one
 * source of truth for "how long is an episode when we don't know," not two
 * guesses that could quietly drift apart.
 */

export const XP_PER_MINUTE = 2;

/** Fallback for a movie with no captured `runtimeMinutes` — a pre-migration
 *  record, or a title whose provider data genuinely lacked one. See the doc
 *  comment on `MovieTrackingEntry.runtimeMinutes` in lib/tracking/types.ts. */
export const DEFAULT_MOVIE_RUNTIME_MINUTES = 100;

/**
 * Flat, not per-title: every episode earns the same XP regardless of whether
 * the show is a 22-minute sitcom or a 60-minute drama. This is a deliberate,
 * accepted asymmetry with movies (which DO use real per-title runtime) — see
 * the note on `TvTrackingEntry.knownEpisodeCount`. Getting real per-episode
 * accuracy would mean threading runtime into the watch log per event, which
 * that log's own design brief reserves for time-windowed figures, not
 * lifetime totals, and precise per-episode data fights the whole reason the
 * range encoding exists. The flat rate still delivers the case that matters:
 * a 2-hour film outscores a single episode by a wide margin.
 */
export const XP_PER_EPISODE = DEFAULT_EPISODE_RUNTIME_MINUTES * XP_PER_MINUTE;

/**
 * `completedSeasons` is scoped by the caller to "watching" shows only — a
 * fully "watched" show earns `SERIES_COMPLETE_BONUS_XP` once, not one
 * `SEASON_COMPLETE_BONUS_XP` per season on top. Enumerating individual
 * season bonuses retroactively for an already-finished show would need a
 * `getSeasons()` fetch for every watched show just to count them, which is
 * real cost for what was asked for as a "small bonus". See ../../CLAUDE.md.
 */
export const SEASON_COMPLETE_BONUS_XP = 50;
export const SERIES_COMPLETE_BONUS_XP = 150;

export interface XpInput {
  /** Total watched episodes across every TV entry. Exact wherever
   *  `watchedEpisodes` has real ranges (`countRanges`); falls back to
   *  `knownEpisodeCount` only for a coarse-marked show with empty ranges. */
  episodesWatched: number;
  /** Sum of `runtimeMinutes ?? DEFAULT_MOVIE_RUNTIME_MINUTES` across every
   *  watched movie — resolved by the caller, not here, so this module never
   *  needs to know the fallback rule lives on the tracking entry. */
  movieRuntimeMinutesTotal: number;
  /** Seasons currently fully complete, "watching" shows only. */
  completedSeasons: number;
  /** TV entries with status "watched". */
  completedSeries: number;
}

export interface XpBreakdown {
  total: number;
  fromEpisodes: number;
  fromMovies: number;
  fromSeasonBonuses: number;
  fromSeriesBonuses: number;
}

function clampNonNegativeInt(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

export function computeXp(input: XpInput): XpBreakdown {
  const fromEpisodes = clampNonNegativeInt(input.episodesWatched) * XP_PER_EPISODE;
  const fromMovies = clampNonNegativeInt(input.movieRuntimeMinutesTotal) * XP_PER_MINUTE;
  const fromSeasonBonuses = clampNonNegativeInt(input.completedSeasons) * SEASON_COMPLETE_BONUS_XP;
  const fromSeriesBonuses = clampNonNegativeInt(input.completedSeries) * SERIES_COMPLETE_BONUS_XP;

  return {
    total: fromEpisodes + fromMovies + fromSeasonBonuses + fromSeriesBonuses,
    fromEpisodes,
    fromMovies,
    fromSeasonBonuses,
    fromSeriesBonuses,
  };
}
