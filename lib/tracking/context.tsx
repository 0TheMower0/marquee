"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import type { MediaType, TitleSummary } from "@/lib/content/types";

import {
  deriveStatus,
  markEpisode,
  markSeason,
  markWatchedUpTo,
  reconcileCoarseWatched,
  unmarkEpisode,
  unmarkSeason,
} from "./progress";
import { normalizeWatchedEpisodes, trackingStore } from "./store";
import { entryKey } from "./types";
import type {
  SeasonEpisodeCounts,
  TrackingEntry,
  TrackingStatus,
  TvTrackingEntry,
  WatchedEpisodes,
} from "./types";

interface TrackingContextValue {
  /**
   * False until the initial read from storage resolves. Reading tracking
   * status before this is always "not tracked" rather than a loading state —
   * the read is local (no network) and resolves within a tick, so a loading
   * UI would flash more often than it would ever actually help.
   */
  ready: boolean;
  entries: Record<string, TrackingEntry>;
  getEntry: (id: string, mediaType: MediaType) => TrackingEntry | undefined;
  /**
   * Optimistic: the returned state update happens synchronously before this
   * function's promise even exists — a caller does not need to await it to
   * see the UI flip. It resolves once the write is confirmed, and REJECTS
   * with `StorageError` after rolling the optimistic change back if the
   * write failed. Callers should catch this and show the user something —
   * see `components/tracking/*` for the pattern.
   */
  setStatus: (summary: TitleSummary, status: TrackingStatus) => Promise<void>;
  remove: (id: string, mediaType: MediaType) => Promise<void>;

  /**
   * Episode-level operations. All TV-only, all optimistic with the same
   * rollback-and-rethrow contract as `setStatus`, and all exactly ONE store
   * write regardless of how many episodes they cover.
   *
   * Each takes the season list because progress math needs episode counts,
   * which are provider data and deliberately not stored on the entry (see
   * the note on `SeasonEpisodeCounts` in ./types.ts). Pass the result of
   * `getSeasons()`.
   *
   * The coarse `status` is re-derived automatically after every one of these:
   * marking the last unwatched episode promotes a show to "watched", the
   * first promotes it to "watching". Callers never set status by hand here.
   */
  markEpisodeWatched: (
    summary: TitleSummary,
    seasons: SeasonEpisodeCounts,
    seasonNumber: number,
    episodeNumber: number,
  ) => Promise<void>;
  unmarkEpisodeWatched: (
    summary: TitleSummary,
    seasons: SeasonEpisodeCounts,
    seasonNumber: number,
    episodeNumber: number,
  ) => Promise<void>;
  markSeasonWatched: (
    summary: TitleSummary,
    seasons: SeasonEpisodeCounts,
    seasonNumber: number,
  ) => Promise<void>;
  unmarkSeasonWatched: (
    summary: TitleSummary,
    seasons: SeasonEpisodeCounts,
    seasonNumber: number,
  ) => Promise<void>;
  /** "I binged to here" — everything up to and including this episode. */
  markWatchedUpToEpisode: (
    summary: TitleSummary,
    seasons: SeasonEpisodeCounts,
    seasonNumber: number,
    episodeNumber: number,
  ) => Promise<void>;
}

const TrackingContext = createContext<TrackingContextValue | null>(null);

export function TrackingProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<Record<string, TrackingEntry>>({});
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    trackingStore.getAll().then((all) => {
      if (!cancelled) {
        setEntries(all);
        setReady(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // NOTE on concurrency: `previous` is the `entries` value closed over at the
  // moment this specific call was made, not whatever `entries` happens to be
  // when the write settles. That is the correct snapshot to roll back to for
  // THIS operation. It does mean two concurrent writes to different keys can
  // each roll back over the other's optimistic update if both fail around
  // the same time — a real limitation, and out of scope for Phase 2, which
  // has no mutation queue. Each caller also disables its own control while
  // pending, so the common case (one click, one in-flight write) is exact.
  async function setStatus(summary: TitleSummary, status: TrackingStatus) {
    const key = entryKey(summary.mediaType, summary.id);
    const previous = entries;
    const existing = previous[key];
    const now = new Date();

    const base = {
      id: summary.id,
      status,
      addedAt: existing?.addedAt ?? now,
      updatedAt: now,
      summary,
    };

    const next: TrackingEntry =
      summary.mediaType === "tv"
        ? {
            ...base,
            mediaType: "tv",
            // Carried over, NOT reset. Changing a show's coarse status must
            // never discard episode progress — moving something from
            // "watching" back to "watchlist" and losing 40 watched episodes
            // would be silent data loss.
            watchedEpisodes:
              existing?.mediaType === "tv" ? existing.watchedEpisodes : {},
          }
        : { ...base, mediaType: "movie" };

    setEntries({ ...previous, [key]: next });

    try {
      await trackingStore.set(key, next);
    } catch (error) {
      setEntries(previous);
      throw error;
    }
  }

  /**
   * The single path every episode-level operation goes through.
   *
   * Concentrating them here means the optimistic-update, rollback, status
   * re-derivation and normalization rules exist once. An operation is just a
   * pure transform of `WatchedEpisodes` — it cannot get the persistence
   * details wrong because it never sees them.
   */
  async function applyEpisodeMutation(
    summary: TitleSummary,
    seasons: SeasonEpisodeCounts,
    mutate: (watched: WatchedEpisodes) => WatchedEpisodes,
  ) {
    if (summary.mediaType !== "tv") {
      // A programming error, not a user-facing condition: movies have no
      // episodes and the types already prevent this at every real call site.
      throw new Error(
        `Episode progress is TV-only; got a movie ("${summary.id}").`,
      );
    }

    const key = entryKey("tv", summary.id);
    const previous = entries;
    const existing = previous[key];
    const now = new Date();

    // Expand a coarse "watched" into real ranges BEFORE editing, so a
    // per-episode change to a v1-migrated show starts from "all watched"
    // rather than silently discarding it. See reconcileCoarseWatched.
    const currentWatched: WatchedEpisodes =
      existing?.mediaType === "tv"
        ? reconcileCoarseWatched(existing, seasons)
        : {};

    const nextWatched = normalizeWatchedEpisodes(mutate(currentWatched));

    const next: TvTrackingEntry = {
      id: summary.id,
      mediaType: "tv",
      // Default "watching" for a brand-new entry: marking an episode on an
      // untracked show means you've started it. deriveStatus promotes to
      // "watched" if that episode completed the show.
      status: deriveStatus(existing?.status ?? "watching", nextWatched, seasons),
      addedAt: existing?.addedAt ?? now,
      updatedAt: now,
      summary,
      watchedEpisodes: nextWatched,
    };

    setEntries({ ...previous, [key]: next });

    try {
      await trackingStore.set(key, next);
    } catch (error) {
      setEntries(previous);
      throw error;
    }
  }

  async function remove(id: string, mediaType: MediaType) {
    const key = entryKey(mediaType, id);
    const previous = entries;
    if (!previous[key]) return;

    const optimistic = { ...previous };
    delete optimistic[key];
    setEntries(optimistic);

    try {
      await trackingStore.remove(key);
    } catch (error) {
      setEntries(previous);
      throw error;
    }
  }

  const value: TrackingContextValue = {
    ready,
    entries,
    getEntry: (id, mediaType) => entries[entryKey(mediaType, id)],
    setStatus,
    remove,

    markEpisodeWatched: (summary, seasons, seasonNumber, episodeNumber) =>
      applyEpisodeMutation(summary, seasons, (watched) =>
        markEpisode(watched, seasonNumber, episodeNumber),
      ),
    unmarkEpisodeWatched: (summary, seasons, seasonNumber, episodeNumber) =>
      applyEpisodeMutation(summary, seasons, (watched) =>
        unmarkEpisode(watched, seasonNumber, episodeNumber),
      ),
    markSeasonWatched: (summary, seasons, seasonNumber) =>
      applyEpisodeMutation(summary, seasons, (watched) =>
        markSeason(watched, seasons, seasonNumber),
      ),
    unmarkSeasonWatched: (summary, seasons, seasonNumber) =>
      applyEpisodeMutation(summary, seasons, (watched) =>
        unmarkSeason(watched, seasonNumber),
      ),
    markWatchedUpToEpisode: (summary, seasons, seasonNumber, episodeNumber) =>
      applyEpisodeMutation(summary, seasons, (watched) =>
        markWatchedUpTo(watched, seasons, seasonNumber, episodeNumber),
      ),
  };

  return <TrackingContext.Provider value={value}>{children}</TrackingContext.Provider>;
}

export function useTracking(): TrackingContextValue {
  const ctx = useContext(TrackingContext);
  if (!ctx) {
    throw new Error("useTracking() must be called within a <TrackingProvider>.");
  }
  return ctx;
}
