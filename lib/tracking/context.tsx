"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import type { MediaType, TitleSummary } from "@/lib/content/types";
// Deep imports, not the `@/lib/watchlog` barrel's siblings: this module is
// what the log is wired INTO, so nothing here may import back through
// lib/tracking's own barrel. See the note in lib/watchlog/diff.ts.
import {
  appendWatchEvents,
  logEpisodeMutation,
  movieEvent,
  titleEvent,
} from "@/lib/watchlog";

import {
  deriveStatus,
  markEpisode,
  markSeason,
  markSeasonUpTo,
  markWatchedUpTo,
  reconcileCoarseWatched,
  totalEpisodeCount,
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
   *
   * `hint` (Phase 5 Step 2) captures the two XP-only fallback fields —
   * `runtimeMinutes` (movie) / `episodeCount` (tv) — from a full `Title`
   * the caller happens to have in hand. Only `TrackingActions` ever passes
   * one, because it is the only caller with a full `Title` rather than a
   * `TitleSummary`; `TrackingBadge`'s watchlist-only toggle omits it and the
   * existing value (or `null` for a new entry) is carried over unchanged,
   * same as `watchedEpisodes` below. See the doc comments on
   * `MovieTrackingEntry.runtimeMinutes` / `TvTrackingEntry.knownEpisodeCount`
   * in ./types.ts for why this exists at all.
   */
  setStatus: (
    summary: TitleSummary,
    status: TrackingStatus,
    hint?: { runtimeMinutes: number | null; episodeCount: number | null },
  ) => Promise<void>;
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
  /** "I binged to here" — everything up to and including this episode,
   *  INCLUDING every prior season in full. See markSeasonUpTo below for the
   *  single-season variant. */
  markWatchedUpToEpisode: (
    summary: TitleSummary,
    seasons: SeasonEpisodeCounts,
    seasonNumber: number,
    episodeNumber: number,
  ) => Promise<void>;
  /**
   * Mark 1..episodeNumber within ONE season only — no other season is
   * touched. Exists for "mark season watched" degrading to "everything
   * aired so far" on a currently-airing season; using the cross-season
   * `markWatchedUpToEpisode` for that would incorrectly sweep every prior
   * season too.
   */
  markSeasonWatchedUpTo: (
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
  async function setStatus(
    summary: TitleSummary,
    status: TrackingStatus,
    hint?: { runtimeMinutes: number | null; episodeCount: number | null },
  ) {
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
            // Phase 5 Step 2, XP-only — see the note on `hint` above.
            knownEpisodeCount:
              hint !== undefined
                ? hint.episodeCount
                : existing?.mediaType === "tv"
                  ? existing.knownEpisodeCount
                  : null,
          }
        : {
            ...base,
            mediaType: "movie",
            runtimeMinutes:
              hint !== undefined
                ? hint.runtimeMinutes
                : existing?.mediaType === "movie"
                  ? existing.runtimeMinutes
                  : null,
          };

    setEntries({ ...previous, [key]: next });

    try {
      await trackingStore.set(key, next);
    } catch (error) {
      setEntries(previous);
      throw error;
    }

    // Phase 5 Step 1. AFTER the tracking write succeeds — never log something
    // that didn't persist. Only on the transition INTO "watched": re-clicking
    // an already-watched title must not append a duplicate event.
    //
    // A TV title marked watched here gets ONE title-level event, not per
    // episode: this path sets `status` with empty ranges and genuinely does
    // not know which episodes exist (that is what `reconcileCoarseWatched`
    // resolves later, at the point of use, where season data is in hand).
    if (status === "watched" && existing?.status !== "watched") {
      void appendWatchEvents([
        summary.mediaType === "movie" ? movieEvent(summary.id) : titleEvent(summary.id),
      ]);
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
    /**
     * Whether this came from a bulk action ("mark season watched", "binge to
     * here") rather than one deliberate episode mark. Passed explicitly, not
     * inferred from how many episodes the diff produced — inference would be
     * correct today but would silently misclassify a future operation, and
     * this flag can never be recovered once written wrong. See the note on
     * `WatchEvent.b`.
     */
    options: { bulk: boolean },
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
      // Phase 5 Step 2, XP-only. Unlike setStatus's `hint` (which only fires
      // when a caller happens to pass one), this path always HAS real season
      // data — `seasons` is a required parameter here — so it opportunistically
      // keeps the fallback fresh rather than merely carrying over a stale
      // value. Net effect: an entry only stays missing this once it's been
      // through nothing but a coarse "Watched" click with no episode-level
      // interaction at all.
      knownEpisodeCount: totalEpisodeCount(seasons),
    };

    setEntries({ ...previous, [key]: next });

    try {
      await trackingStore.set(key, next);
    } catch (error) {
      setEntries(previous);
      throw error;
    }

    // Phase 5 Step 1. One call covers every episode operation, because this
    // function is the funnel they all pass through and it holds both sides of
    // the change — `logEpisodeMutation` diffs them. Un-marks yield an empty
    // diff and log nothing. Fire-and-forget: it never throws, and history is
    // strictly secondary to the progress write above.
    void logEpisodeMutation(summary.mediaType, summary.id, currentWatched, nextWatched, {
      bulk: options.bulk,
    });
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

    // `bulk` below is about how the user EXPRESSED the action, not how many
    // episodes it happened to touch. Ticking one episode is a single mark
    // even if it completes a season; "mark season watched" is bulk even on a
    // season with one episode left. Un-marks pass `false` and are irrelevant
    // anyway — they produce an empty diff and log nothing.
    markEpisodeWatched: (summary, seasons, seasonNumber, episodeNumber) =>
      applyEpisodeMutation(
        summary,
        seasons,
        (watched) => markEpisode(watched, seasonNumber, episodeNumber),
        { bulk: false },
      ),
    unmarkEpisodeWatched: (summary, seasons, seasonNumber, episodeNumber) =>
      applyEpisodeMutation(
        summary,
        seasons,
        (watched) => unmarkEpisode(watched, seasonNumber, episodeNumber),
        { bulk: false },
      ),
    markSeasonWatched: (summary, seasons, seasonNumber) =>
      applyEpisodeMutation(
        summary,
        seasons,
        (watched) => markSeason(watched, seasons, seasonNumber),
        { bulk: true },
      ),
    unmarkSeasonWatched: (summary, seasons, seasonNumber) =>
      applyEpisodeMutation(
        summary,
        seasons,
        (watched) => unmarkSeason(watched, seasonNumber),
        { bulk: false },
      ),
    markWatchedUpToEpisode: (summary, seasons, seasonNumber, episodeNumber) =>
      applyEpisodeMutation(
        summary,
        seasons,
        (watched) => markWatchedUpTo(watched, seasons, seasonNumber, episodeNumber),
        { bulk: true },
      ),
    markSeasonWatchedUpTo: (summary, seasons, seasonNumber, episodeNumber) =>
      applyEpisodeMutation(
        summary,
        seasons,
        (watched) => markSeasonUpTo(watched, seasonNumber, episodeNumber),
        { bulk: true },
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
