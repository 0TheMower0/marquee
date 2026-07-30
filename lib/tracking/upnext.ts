import type { Episode } from "@/lib/content/types";
import { formatAirDate, isFutureAirDate } from "@/lib/utils/dates";

import {
  getSeasonProgress,
  isEpisodeWatched,
  nextUnwatchedEpisode,
  reconcileCoarseWatched,
  totalEpisodeCount,
  watchedEpisodeCount,
} from "./progress";
import type { SeasonEpisodeCounts, TrackingEntry, TvTrackingEntry } from "./types";

/**
 * The Up Next ranking engine — built on top of `nextUnwatchedEpisode`
 * (progress.ts), not a reimplementation of it.
 *
 * Everything here is pure: no storage, no fetching, no React. The caller
 * (up-next-rail.tsx) owns fetching `SeasonEpisodeCounts` and the one
 * season's `Episode[]` that hold the answer, and passes them in already
 * resolved — same "pure transform, orchestration lives elsewhere" split as
 * progress.ts/context.tsx.
 */

export interface UpNextCandidate {
  entry: TvTrackingEntry;
  seasonNumber: number;
  episodeNumber: number;
}

/**
 * Shows "in progress" with a concrete next-unwatched episode to chase down.
 *
 * Restricted to `status === "watching"` — not `"watchlist"` (nothing
 * started, this is "continue" not "discover") and not `"watched"` (nothing
 * left). A show with no entry in `seasonsByShowId` (fetch still pending, or
 * failed) is skipped rather than blocking the rest of the list, same
 * graceful-degradation pattern season-list.tsx uses for episode fetches.
 */
export function selectUpNextCandidates(
  entries: Record<string, TrackingEntry>,
  seasonsByShowId: Record<string, SeasonEpisodeCounts>,
): UpNextCandidate[] {
  const candidates: UpNextCandidate[] = [];

  for (const entry of Object.values(entries)) {
    if (entry.mediaType !== "tv" || entry.status !== "watching") continue;

    const seasons = seasonsByShowId[entry.id];
    if (!seasons) continue;

    const watched = reconcileCoarseWatched(entry, seasons);
    const next = nextUnwatchedEpisode(watched, seasons);
    // null means fully caught up on everything currently announced — which
    // also means `deriveStatus` would already have promoted this entry to
    // "watched" the moment that happened, so this is a rare staleness
    // window rather than a common case. Either way, nothing to show.
    if (!next) continue;

    candidates.push({
      entry,
      seasonNumber: next.seasonNumber,
      episodeNumber: next.episodeNumber,
    });
  }

  return candidates;
}

export interface UpNextSignals {
  /** Aired & unwatched episodes within the season holding the target episode. */
  waitingInSeason: number;
  /** Unwatched episodes across the whole series (may include unaired ones
   *  in a currently-airing season — see CLAUDE.md on `remaining`). */
  remainingInSeries: number;
  seasonPercentComplete: number;
  daysSinceLastWatched: number;
  estimatedMinutesToFinishSeason: number;
  estimatedMinutesToFinishSeries: number;
  airingState: "airing" | "between-seasons" | "ended";
}

export interface UpNextItem extends UpNextCandidate {
  /** null while the season's episodes haven't loaded yet, or on fetch failure. */
  episode: Episode | null;
  signals: UpNextSignals;
  label: string;
  /** Meaningful for `ready` items only; `upcoming` is sorted by air date. */
  score: number;
  isRediscovery: boolean;
}

export interface RankedUpNext {
  ready: UpNextItem[];
  upcoming: UpNextItem[];
}

/** Tunable — see the ranking design writeup for the reasoning behind each. */
export const RANKING_WEIGHTS = {
  waiting: 6,
  wrapUpThresholdPct: 70,
  wrapUp: 8,
  recencyHalfLifeDays: 10,
  // Never reaches 0: an infinitely dormant show still orders sensibly
  // against OTHER dormant shows by waiting/wrap-up, and the rediscovery
  // slot below doesn't depend on score anyway.
  recencyFloor: 0.1,
};

export const REDISCOVERY_DORMANT_DAYS = 21;

/** Used when no fetched episode in a season carries a real runtime — true
 *  for the mock catalog's generic-fallback tier (e.g. Grey's Anatomy). */
export const DEFAULT_EPISODE_RUNTIME_MINUTES = 45;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function averageRuntimeMinutes(episodes: Episode[] | null): number {
  const known = (episodes ?? [])
    .map((episode) => episode.runtimeMinutes)
    .filter((minutes): minutes is number => minutes !== null);
  if (known.length === 0) return DEFAULT_EPISODE_RUNTIME_MINUTES;
  return known.reduce((sum, minutes) => sum + minutes, 0) / known.length;
}

/**
 * Multiplicative recency decay, not additive — see the ranking design
 * writeup. An unbounded `sqrt(waiting)` term can't be reliably outweighed by
 * a fixed additive recency constant at any realistic weight; multiplying
 * makes dormancy damp the whole content score proportionally instead.
 */
function computeScore(
  waitingInSeason: number,
  seasonPercentComplete: number,
  daysSinceLastWatched: number,
): number {
  const wrapUpBoost =
    seasonPercentComplete > RANKING_WEIGHTS.wrapUpThresholdPct
      ? (RANKING_WEIGHTS.wrapUp *
          (seasonPercentComplete - RANKING_WEIGHTS.wrapUpThresholdPct)) /
        (100 - RANKING_WEIGHTS.wrapUpThresholdPct)
      : 0;
  const contentScore = RANKING_WEIGHTS.waiting * Math.sqrt(waitingInSeason) + wrapUpBoost;

  const recencyMultiplier =
    RANKING_WEIGHTS.recencyFloor +
    (1 - RANKING_WEIGHTS.recencyFloor) *
      2 ** (-daysSinceLastWatched / RANKING_WEIGHTS.recencyHalfLifeDays);

  return contentScore * recencyMultiplier;
}

/**
 * Precedence: upcoming (bucket) > waiting-count > about-to-finish > generic
 * fallback, with a dormancy clause appended rather than replacing the base
 * phrase — a dormant show with a real backlog loses information if "6 weeks
 * behind" replaces "3 waiting" outright.
 */
function describeUpNextItem(
  candidate: UpNextCandidate,
  episode: Episode | null,
  waitingInSeason: number,
  episodesLeftInSeason: number,
  daysSinceLastWatched: number,
): string {
  const airDate = episode?.airDate ?? null;

  if (isFutureAirDate(airDate)) {
    const formatted = formatAirDate(airDate) ?? "soon";
    return candidate.episodeNumber === 1
      ? `Season ${candidate.seasonNumber} starts ${formatted}`
      : `New episode airs ${formatted}`;
  }

  const base =
    waitingInSeason >= 2
      ? `${waitingInSeason} episodes waiting`
      : episodesLeftInSeason <= 2
        ? `${episodesLeftInSeason} left to finish the season`
        : `Next: S${candidate.seasonNumber} · E${candidate.episodeNumber}${
            episode ? ` — ${episode.name}` : ""
          }`;

  if (daysSinceLastWatched >= REDISCOVERY_DORMANT_DAYS) {
    const weeks = Math.round(daysSinceLastWatched / 7);
    return `${base} · You're ${weeks} week${weeks === 1 ? "" : "s"} behind`;
  }

  return base;
}

/**
 * Builds one fully-resolved item from a candidate plus whatever season/
 * episode data is in hand. `seasonEpisodes` should be the result of fetching
 * exactly `candidate.seasonNumber`'s episodes — pass `null` while that fetch
 * is loading or failed; signals degrade to conservative defaults (see
 * `waitingInSeason` below) rather than throwing.
 *
 * `now` defaults to `new Date()` purely so callers don't have to pass it for
 * real use; tests pin it to get deterministic `daysSinceLastWatched`.
 */
export function buildUpNextItem(
  candidate: UpNextCandidate,
  seasons: SeasonEpisodeCounts,
  seasonEpisodes: Episode[] | null,
  now: Date = new Date(),
): UpNextItem {
  const { entry, seasonNumber, episodeNumber } = candidate;
  const watched = reconcileCoarseWatched(entry, seasons);
  const episode = seasonEpisodes?.find((e) => e.episodeNumber === episodeNumber) ?? null;

  const episodeCount =
    seasons.find((season) => season.seasonNumber === seasonNumber)?.episodeCount ?? 0;
  const seasonProgress = getSeasonProgress(watched, seasonNumber, episodeCount);
  const episodesLeftInSeason = Math.max(0, episodeCount - seasonProgress.watchedCount);

  // Without the real episode list yet, we still know the target episode
  // itself is unwatched (that's how it became a candidate) — 1 is the
  // conservative floor rather than 0, which would misrepresent "nothing
  // waiting" while a fetch is still in flight or has failed.
  const waitingInSeason = seasonEpisodes
    ? seasonEpisodes.filter(
        (e) => !isFutureAirDate(e.airDate) && !isEpisodeWatched(watched, seasonNumber, e.episodeNumber),
      ).length
    : 1;

  const remainingInSeries = Math.max(
    0,
    totalEpisodeCount(seasons) - watchedEpisodeCount(watched, seasons),
  );

  const daysSinceLastWatched = Math.max(
    0,
    Math.floor((now.getTime() - entry.updatedAt.getTime()) / MS_PER_DAY),
  );

  const avgRuntime = averageRuntimeMinutes(seasonEpisodes);
  const hasLaterSeason = seasons.some((season) => season.seasonNumber > seasonNumber);
  const airingState: UpNextSignals["airingState"] = isFutureAirDate(episode?.airDate ?? null)
    ? "airing"
    : hasLaterSeason
      ? "between-seasons"
      : "ended";

  const signals: UpNextSignals = {
    waitingInSeason,
    remainingInSeries,
    seasonPercentComplete: seasonProgress.percentComplete,
    daysSinceLastWatched,
    estimatedMinutesToFinishSeason: Math.round(waitingInSeason * avgRuntime),
    estimatedMinutesToFinishSeries: Math.round(remainingInSeries * avgRuntime),
    airingState,
  };

  return {
    ...candidate,
    episode,
    signals,
    label: describeUpNextItem(
      candidate,
      episode,
      waitingInSeason,
      episodesLeftInSeason,
      daysSinceLastWatched,
    ),
    score: computeScore(waitingInSeason, signals.seasonPercentComplete, daysSinceLastWatched),
    isRediscovery: false,
  };
}

/**
 * After sorting by score, if a candidate past the dormancy threshold exists
 * outside the top 2, reposition the MOST dormant such candidate to index 2
 * with `isRediscovery: true`. Deterministic on purpose, not random — see the
 * ranking design writeup — so it stays unit-testable and so an active
 * library with nothing genuinely dormant never shows one.
 *
 * Returns a new array; does not mutate `ready` or any of its items (matches
 * the immutable-transform convention the rest of lib/tracking follows).
 */
function applyRediscoverySlot(ready: UpNextItem[]): UpNextItem[] {
  if (ready.length < 3) return ready;

  let mostDormantIndex = -1;
  let mostDormantDays = -1;
  for (let i = 2; i < ready.length; i++) {
    const days = ready[i].signals.daysSinceLastWatched;
    if (days >= REDISCOVERY_DORMANT_DAYS && days > mostDormantDays) {
      mostDormantDays = days;
      mostDormantIndex = i;
    }
  }
  if (mostDormantIndex === -1) return ready;

  const next = [...ready];
  const [picked] = next.splice(mostDormantIndex, 1);
  next.splice(2, 0, { ...picked, isRediscovery: true });
  return next;
}

/**
 * Buckets on whether the target episode has aired, then ranks each bucket.
 *
 * An item with no episode data yet (`episode: null`, still loading) is
 * treated as `ready` — matches `isFutureAirDate`'s existing "unknown is not
 * future" rule — so callers must not call this until every candidate's
 * episode fetch has settled, or a card will visibly jump buckets (and its
 * score with it) once the real air date arrives.
 */
export function rankUpNext(items: UpNextItem[]): RankedUpNext {
  const readyItems: UpNextItem[] = [];
  const upcomingItems: UpNextItem[] = [];

  for (const item of items) {
    (isFutureAirDate(item.episode?.airDate ?? null) ? upcomingItems : readyItems).push(item);
  }

  readyItems.sort((a, b) => b.score - a.score);
  upcomingItems.sort((a, b) =>
    (a.episode?.airDate ?? "").localeCompare(b.episode?.airDate ?? ""),
  );

  return { ready: applyRediscoverySlot(readyItems), upcoming: upcomingItems };
}
