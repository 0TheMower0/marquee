"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { httpProvider } from "@/lib/content/http";
import type { Episode, Season } from "@/lib/content/types";
import {
  buildUpNextItem,
  rankUpNext,
  selectUpNextCandidates,
  useTracking,
  type SeasonEpisodeCounts,
  type UpNextItem,
} from "@/lib/tracking";

import { episodeCacheKey, type MarkEpisodeWatched } from "./up-next-card";

/**
 * Shared fetch orchestration + ranking for every Up Next surface — the Home
 * rail and Library's "Continue Watching" section (Phase 3 Step 4) both call
 * this rather than duplicating it, since a second consumer is exactly the
 * situation `SeasonEpisodeCounts`'s doc comment (lib/tracking/types.ts)
 * flagged as the point to stop inlining this per-component.
 *
 * A Client Component hook (needs `useTracking`), fetching through
 * `httpProvider` (never `getContentProvider`, which is server-only). Two
 * fetch stages, each guarded by a ref-based "already requested" set rather
 * than checking `useState` inside the effect body — a fetch triggered as a
 * side effect of a `setState` updater would double-fire under Strict Mode's
 * purity check:
 *
 *   1. `getSeasons(showId)` for every TV show tracked as "watching" —
 *      enough to compute each show's next-unwatched episode via the pure
 *      `selectUpNextCandidates`.
 *   2. `getSeasonEpisodes(showId, seasonNumber)` for just the ONE season
 *      each candidate's next-unwatched episode falls in — enough for
 *      `buildUpNextItem` to know whether that episode has aired.
 *
 * Ranking (`buildUpNextItem` + `rankUpNext`) only runs once every candidate's
 * stage-2 fetch has settled (ready or error) — building it earlier would let
 * a card visibly jump between the "ready" and "coming soon" buckets (and its
 * score with it) the moment the real air date arrives.
 */

type SeasonsCacheEntry =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; seasons: Season[] };

type EpisodesCacheEntry =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; episodes: Episode[] };

export interface UseUpNextItemsResult {
  /** False until the initial tracking read AND every fetch this hook
   *  triggered have settled. Callers should render a skeleton while false —
   *  NOT an empty state, which would flash before the real answer arrives. */
  settled: boolean;
  /** Reliable even while `settled` is false, once storage has loaded —
   *  distinguishes "still fetching" from "genuinely nothing tracked". */
  hasWatchingShows: boolean;
  /**
   * At least one show's data could not be fetched.
   *
   * Same gap as the schedule feed's own `loadFailed`, and it produced the
   * same falsehood: with the content source unreachable, a user with five
   * shows in progress saw "Nothing in progress" — while Trending, directly
   * below on the same page, correctly reported the outage. Two adjacent
   * sections disagreeing about whether the app can reach TMDB.
   */
  loadFailed: boolean;
  ready: UpNextItem[];
  upcoming: UpNextItem[];
  seasonCountsByShowId: Record<string, SeasonEpisodeCounts>;
  markEpisodeWatched: MarkEpisodeWatched;
}

export function useUpNextItems(): UseUpNextItemsResult {
  const { ready: trackingReady, entries, markEpisodeWatched } = useTracking();

  const watchingIds = useMemo(
    () =>
      Object.values(entries)
        .filter((entry) => entry.mediaType === "tv" && entry.status === "watching")
        .map((entry) => entry.id),
    [entries],
  );

  const [seasonsCache, setSeasonsCache] = useState<Record<string, SeasonsCacheEntry>>({});
  const requestedSeasons = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!trackingReady) return;
    for (const id of watchingIds) {
      if (requestedSeasons.current.has(id)) continue;
      requestedSeasons.current.add(id);
      setSeasonsCache((prev) => ({ ...prev, [id]: { status: "loading" } }));
      httpProvider.getSeasons(id).then(
        (seasons) =>
          setSeasonsCache((prev) => ({ ...prev, [id]: { status: "ready", seasons } })),
        () => setSeasonsCache((prev) => ({ ...prev, [id]: { status: "error" } })),
      );
    }
  }, [trackingReady, watchingIds]);

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
    () => selectUpNextCandidates(entries, seasonCountsByShowId),
    [entries, seasonCountsByShowId],
  );

  const [episodesCache, setEpisodesCache] = useState<Record<string, EpisodesCacheEntry>>({});
  const requestedEpisodes = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const candidate of candidates) {
      const key = episodeCacheKey(candidate.entry.id, candidate.seasonNumber);
      if (requestedEpisodes.current.has(key)) continue;
      requestedEpisodes.current.add(key);
      setEpisodesCache((prev) => ({ ...prev, [key]: { status: "loading" } }));
      httpProvider.getSeasonEpisodes(candidate.entry.id, candidate.seasonNumber).then(
        (episodes) =>
          setEpisodesCache((prev) => ({ ...prev, [key]: { status: "ready", episodes } })),
        () => setEpisodesCache((prev) => ({ ...prev, [key]: { status: "error" } })),
      );
    }
  }, [candidates]);

  const hasWatchingShows = watchingIds.length > 0;

  const seasonsSettling = watchingIds.some((id) => {
    const cacheEntry = seasonsCache[id];
    return !cacheEntry || cacheEntry.status === "loading";
  });
  const episodesSettling = candidates.some((candidate) => {
    const cacheEntry = episodesCache[episodeCacheKey(candidate.entry.id, candidate.seasonNumber)];
    return !cacheEntry || cacheEntry.status === "loading";
  });
  const settled = trackingReady && !seasonsSettling && !episodesSettling;

  // Scoped to currently-watching shows, not every cache entry ever held, so
  // removing a show clears its failure rather than leaving the rail flagged.
  const loadFailed =
    watchingIds.some((id) => seasonsCache[id]?.status === "error") ||
    candidates.some(
      (c) => episodesCache[episodeCacheKey(c.entry.id, c.seasonNumber)]?.status === "error",
    );

  if (!settled) {
    return {
      settled: false,
      hasWatchingShows,
      loadFailed,
      ready: [],
      upcoming: [],
      seasonCountsByShowId,
      markEpisodeWatched,
    };
  }

  const items: UpNextItem[] = candidates.map((candidate) => {
    const key = episodeCacheKey(candidate.entry.id, candidate.seasonNumber);
    const cacheEntry = episodesCache[key];
    const episodes = cacheEntry?.status === "ready" ? cacheEntry.episodes : null;
    return buildUpNextItem(candidate, seasonCountsByShowId[candidate.entry.id], episodes);
  });

  const ranked = rankUpNext(items);

  return {
    settled: true,
    hasWatchingShows,
    loadFailed,
    ready: ranked.ready,
    upcoming: ranked.upcoming,
    seasonCountsByShowId,
    markEpisodeWatched,
  };
}
