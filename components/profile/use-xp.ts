"use client";

import { useEffect, useRef, useState } from "react";

import { httpProvider } from "@/lib/content/http";
import type { Season } from "@/lib/content/types";
import {
  useTracking,
  type MovieTrackingEntry,
  type SeasonEpisodeCounts,
  type TvTrackingEntry,
} from "@/lib/tracking";
import {
  completedSeasonsFor,
  computeXp,
  episodesWatchedFor,
  getHighestLevelSeen,
  levelProgressForXp,
  movieRuntimeMinutesFor,
  setHighestLevelSeen,
  type LevelProgress,
  type XpBreakdown,
} from "@/lib/xp";

/**
 * Orchestration for the Profile XP bar: reads tracking state, fetches season
 * data for exactly the shows that need it, and feeds the pure formula in
 * lib/xp/formula.ts. Same two-layer split as
 * components/tracking/use-up-next-items.ts — this hook owns the I/O, the
 * math underneath stays pure and independently tested.
 *
 * ONLY "watching" shows get a `getSeasons()` fetch, and it is the same
 * ref-guarded, cached-per-showId pattern used there — this is the third
 * appearance of that idiom in the codebase (season-list.tsx has the first,
 * for one show), not a new one. "Watched" shows need no fetch at all: their
 * XP comes from `episodesWatchedFor`'s coarse-mark fallback plus the flat
 * series bonus, both computed from tracking state alone. See the note on
 * `SEASON_COMPLETE_BONUS_XP` in lib/xp/formula.ts for why season bonuses are
 * deliberately not enumerated for already-finished shows.
 *
 * All hooks below run UNCONDITIONALLY, every render — `ready` only gates
 * which VALUES the final object carries, never whether a hook is called.
 * Branching hook invocation itself on `ready` would violate the Rules of
 * Hooks the moment `ready` flips from false to true mid-lifetime.
 */

export interface UseXpResult {
  /** False until tracking's initial read AND every season fetch this hook
   *  triggered have settled. */
  ready: boolean;
  breakdown: XpBreakdown;
  progress: LevelProgress;
  /** True for exactly one render: the first time `ready` becomes true after
   *  the computed level exceeds what was last persisted as "seen". Consumers
   *  should treat this as a one-shot signal, not a value to poll. */
  justLeveledUp: boolean;
}

const ZERO_BREAKDOWN: XpBreakdown = {
  total: 0,
  fromEpisodes: 0,
  fromMovies: 0,
  fromSeasonBonuses: 0,
  fromSeriesBonuses: 0,
};

export function useXp(): UseXpResult {
  const { ready: trackingReady, entries } = useTracking();

  const tvEntries = Object.values(entries).filter(
    (entry): entry is TvTrackingEntry => entry.mediaType === "tv",
  );
  const movieEntries = Object.values(entries).filter(
    (entry): entry is MovieTrackingEntry => entry.mediaType === "movie" && entry.status === "watched",
  );
  const watchingShowIds = tvEntries.filter((entry) => entry.status === "watching").map((e) => e.id);

  const [seasonsCache, setSeasonsCache] = useState<Record<string, Season[]>>({});
  const requestedSeasons = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!trackingReady) return;
    for (const id of watchingShowIds) {
      if (requestedSeasons.current.has(id)) continue;
      requestedSeasons.current.add(id);
      httpProvider.getSeasons(id).then(
        (seasons) => setSeasonsCache((prev) => ({ ...prev, [id]: seasons })),
        // A failed fetch just means this one show contributes no season
        // bonus — not worth surfacing an error for a "small bonus".
        () => setSeasonsCache((prev) => ({ ...prev, [id]: [] })),
      );
    }
    // watchingShowIds is derived fresh every render from `entries`; an array
    // dependency would re-run this effect every render for no reason, so it
    // depends on the same underlying value via `entries` instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackingReady, entries]);

  const seasonsSettling = watchingShowIds.some((id) => seasonsCache[id] === undefined);
  const ready = trackingReady && !seasonsSettling;

  const episodesWatched = ready
    ? tvEntries.reduce((sum, entry) => sum + episodesWatchedFor(entry), 0)
    : 0;

  const movieRuntimeMinutesTotal = ready
    ? movieEntries.reduce((sum, entry) => sum + movieRuntimeMinutesFor(entry), 0)
    : 0;

  const completedSeasons = ready
    ? tvEntries
        .filter((entry) => entry.status === "watching")
        .reduce((sum, entry) => {
          const seasons: SeasonEpisodeCounts = (seasonsCache[entry.id] ?? []).map((season) => ({
            seasonNumber: season.seasonNumber,
            episodeCount: season.episodeCount,
          }));
          return sum + completedSeasonsFor(entry.watchedEpisodes, seasons);
        }, 0)
    : 0;

  const completedSeries = ready
    ? tvEntries.filter((entry) => entry.status === "watched").length
    : 0;

  const breakdown = ready
    ? computeXp({ episodesWatched, movieRuntimeMinutesTotal, completedSeasons, completedSeries })
    : ZERO_BREAKDOWN;
  const progress = levelProgressForXp(breakdown.total);

  const [justLeveledUp, setJustLeveledUp] = useState(false);
  const checkedLevelUp = useRef(false);

  // Runs once per mount, the first time `ready` is true — not on every
  // subsequent recompute. TrackingProvider has no cross-tab sync (a
  // documented gap, see CLAUDE.md), so within one Profile visit `entries`
  // only changes if the user interacts with tracking from this same tab
  // while already on this page, which the Profile page gives no control to
  // do — "once per mount" and "once per genuine level change" coincide here.
  useEffect(() => {
    if (!ready || checkedLevelUp.current) return;
    checkedLevelUp.current = true;
    getHighestLevelSeen().then((seen) => {
      if (progress.level > seen) {
        setJustLeveledUp(true);
        void setHighestLevelSeen(progress.level);
      }
    });
    // progress.level is read once, at the moment `ready` first flips true —
    // intentionally not a dependency, so a later re-render (e.g. seasonsCache
    // settling further) can't re-arm this check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  return { ready, breakdown, progress, justLeveledUp };
}
