"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import type { MediaType, TitleSummary } from "@/lib/content/types";

import { trackingStore } from "./store";
import { entryKey } from "./types";
import type { TrackingEntry, TrackingStatus } from "./types";

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
