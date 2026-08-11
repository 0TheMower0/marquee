"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { httpProvider } from "@/lib/content/http";
import type { Episode, Season } from "@/lib/content/types";
import {
  buildScheduleItems,
  groupSchedule,
  selectScheduleCandidates,
  type ScheduleFeed,
} from "@/lib/schedule";
import { useTracking, type SeasonEpisodeCounts } from "@/lib/tracking";
import { mapWithConcurrency } from "@/lib/utils/concurrency";

import type { MarkEpisodeWatched } from "@/components/tracking/up-next-card";

/**
 * Fetch orchestration for the new-episode feed (Phase 7) — the same two-stage
 * shape as use-up-next-items.ts:
 *
 *   1. `getSeasons(showId)` for every TV show tracked as "watching" OR
 *      "watched" — enough to compute each show's next-unwatched episode via
 *      the pure `selectScheduleCandidates`.
 *   2. `getSeasonEpisodes(showId, seasonNumber)` for just the ONE season each
 *      candidate's next-unwatched episode falls in — enough to bucket it by
 *      air date.
 *
 * Two differences from Up Next's hook, both deliberate:
 *
 * - Widened to "watched" as well as "watching" — see the doc comment on
 *   `selectScheduleCandidates`.
 * - **Concurrency-capped**, where Up Next fires every fetch at once. Up
 *   Next's unbounded fan-out is an accepted precedent for a rail that's
 *   realistically a handful of in-progress shows; a feed spanning EVERY
 *   watching-or-watched show is exactly the "someone tracking 40 shows
 *   shouldn't trigger 40 calls on page load" case the feed was built
 *   against, so both fetch stages go through `mapWithConcurrency` instead.
 *   Each response still lands in Next's 24h TMDB data cache regardless, so
 *   this only bounds concurrent IN-FLIGHT requests on a cold load, not total
 *   requests over time.
 */

const FETCH_CONCURRENCY = 4;

type SeasonsCacheEntry =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; seasons: Season[] };

type EpisodesCacheEntry =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; episodes: Episode[] };

/** Keyed by show AND season, not just show — a candidate's target season can
 *  move (the user watches something, the next-unwatched episode shifts), and
 *  keying on the pair is what makes a season change trigger a fresh fetch
 *  instead of silently reusing a stale one. Same reasoning as
 *  `episodeCacheKey` in up-next-card.tsx, kept as an independent one-line
 *  helper rather than imported — importing a tracking-UI component's key
 *  builder into a schedule-data hook would be a strange direction for that
 *  dependency to run. */
function episodeCacheKey(showId: string, seasonNumber: number): string {
  return `${showId}:${seasonNumber}`;
}

export interface UseScheduleResult {
  /** False until the initial tracking read AND every fetch this hook
   *  triggered have settled. Callers should render a skeleton while false —
   *  not an empty state, which would flash before the real answer arrives. */
  settled: boolean;
  /** Reliable even while `settled` is false, once tracking has loaded —
   *  distinguishes "still fetching" from "genuinely nothing eligible". */
  hasEligibleShows: boolean;
  /**
   * At least one show's data could not be fetched.
   *
   * Without this the feed cannot tell "nothing new has aired" from "we could
   * not reach the content source", and it rendered the former for both. With
   * TMDB down and a show tracked, `/schedule` confidently said **"You're all
   * caught up"** — a statement that is not merely unhelpful but false, and
   * produced precisely when the app knows least. Errors were caught per-show
   * and stored, then never surfaced past this hook.
   *
   * Partial is the common case, so this is a flag rather than a fatal state:
   * one show failing should not hide the other thirty-nine. The view decides
   * how loud to be based on whether anything survived.
   */
  loadFailed: boolean;
  feed: ScheduleFeed;
  seasonCountsByShowId: Record<string, SeasonEpisodeCounts>;
  markEpisodeWatched: MarkEpisodeWatched;
}

export function useSchedule(): UseScheduleResult {
  const { ready: trackingReady, entries, markEpisodeWatched } = useTracking();

  const showIds = useMemo(
    () =>
      Object.values(entries)
        .filter(
          (entry) =>
            entry.mediaType === "tv" &&
            (entry.status === "watching" || entry.status === "watched"),
        )
        .map((entry) => entry.id),
    [entries],
  );

  const [seasonsCache, setSeasonsCache] = useState<Record<string, SeasonsCacheEntry>>({});
  const requestedSeasons = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!trackingReady) return;
    const pending = showIds.filter((id) => !requestedSeasons.current.has(id));
    if (pending.length === 0) return;

    for (const id of pending) requestedSeasons.current.add(id);
    setSeasonsCache((prev) => {
      const next = { ...prev };
      for (const id of pending) next[id] = { status: "loading" };
      return next;
    });

    void mapWithConcurrency(pending, FETCH_CONCURRENCY, async (id) => {
      try {
        const seasons = await httpProvider.getSeasons(id);
        setSeasonsCache((prev) => ({ ...prev, [id]: { status: "ready", seasons } }));
      } catch {
        setSeasonsCache((prev) => ({ ...prev, [id]: { status: "error" } }));
      }
    });
  }, [trackingReady, showIds]);

  const seasonCountsByShowId = useMemo(() => {
    const out: Record<string, SeasonEpisodeCounts> = {};
    for (const [id, cacheEntry] of Object.entries(seasonsCache)) {
      if (cacheEntry.status === "ready") {
        out[id] = cacheEntry.seasons.map((season) => ({
          seasonNumber: season.seasonNumber,
          episodeCount: season.episodeCount,
        }));
      }
    }
    return out;
  }, [seasonsCache]);

  const candidates = useMemo(
    () => selectScheduleCandidates(entries, seasonCountsByShowId),
    [entries, seasonCountsByShowId],
  );

  const [episodesCache, setEpisodesCache] = useState<Record<string, EpisodesCacheEntry>>({});
  const requestedEpisodes = useRef<Set<string>>(new Set());

  useEffect(() => {
    const pending = candidates.filter(
      (c) => !requestedEpisodes.current.has(episodeCacheKey(c.entry.id, c.seasonNumber)),
    );
    if (pending.length === 0) return;

    for (const c of pending) requestedEpisodes.current.add(episodeCacheKey(c.entry.id, c.seasonNumber));
    setEpisodesCache((prev) => {
      const next = { ...prev };
      for (const c of pending) next[episodeCacheKey(c.entry.id, c.seasonNumber)] = { status: "loading" };
      return next;
    });

    void mapWithConcurrency(pending, FETCH_CONCURRENCY, async (candidate) => {
      const key = episodeCacheKey(candidate.entry.id, candidate.seasonNumber);
      try {
        const episodes = await httpProvider.getSeasonEpisodes(
          candidate.entry.id,
          candidate.seasonNumber,
        );
        setEpisodesCache((prev) => ({ ...prev, [key]: { status: "ready", episodes } }));
      } catch {
        setEpisodesCache((prev) => ({ ...prev, [key]: { status: "error" } }));
      }
    });
  }, [candidates]);

  const hasEligibleShows = showIds.length > 0;

  const seasonsSettling = showIds.some((id) => {
    const cacheEntry = seasonsCache[id];
    return !cacheEntry || cacheEntry.status === "loading";
  });
  const episodesSettling = candidates.some((c) => {
    const cacheEntry = episodesCache[episodeCacheKey(c.entry.id, c.seasonNumber)];
    return !cacheEntry || cacheEntry.status === "loading";
  });
  const settled = trackingReady && !seasonsSettling && !episodesSettling;

  // Scoped to the shows/candidates CURRENTLY tracked, not to every entry the
  // caches ever held: a show removed from the library must not keep the feed
  // reporting a failure forever.
  const loadFailed =
    showIds.some((id) => seasonsCache[id]?.status === "error") ||
    candidates.some(
      (c) => episodesCache[episodeCacheKey(c.entry.id, c.seasonNumber)]?.status === "error",
    );

  if (!settled) {
    return {
      settled: false,
      hasEligibleShows,
      loadFailed,
      feed: { ready: [], thisWeek: [], later: [] },
      seasonCountsByShowId,
      markEpisodeWatched,
    };
  }

  const episodesByShowId: Record<string, Episode[] | null> = {};
  for (const candidate of candidates) {
    const cacheEntry = episodesCache[episodeCacheKey(candidate.entry.id, candidate.seasonNumber)];
    episodesByShowId[candidate.entry.id] =
      cacheEntry?.status === "ready" ? cacheEntry.episodes : null;
  }

  const feed = groupSchedule(buildScheduleItems(candidates, episodesByShowId));

  return {
    settled: true,
    hasEligibleShows,
    loadFailed,
    feed,
    seasonCountsByShowId,
    markEpisodeWatched,
  };
}
