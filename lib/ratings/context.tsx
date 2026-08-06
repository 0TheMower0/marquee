"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import type { MediaType } from "@/lib/content/types";
import { recordRatingDelete, recordRatingWrite } from "@/lib/sync/record";

import { ratingsStore } from "./store";
import { mergeRatingPatch, ratingKey } from "./types";
import type { RatingEntry } from "./types";

interface RatingsContextValue {
  /** False until the initial read from storage resolves — same contract as
   *  `TrackingContextValue.ready`: the read is local, resolves within a
   *  tick, and callers should treat "not ready" as "no rating yet" rather
   *  than show a loading state that would flash more often than help. */
  ready: boolean;
  entries: Record<string, RatingEntry>;
  getEntry: (id: string, mediaType: MediaType) => RatingEntry | undefined;
  /**
   * Optimistic, same contract as `useTracking()`'s mutators: the state
   * update is synchronous, the returned promise resolves once the write is
   * confirmed, and it REJECTS with `StorageError` after rolling back if the
   * write failed. Passing `null` clears the rating; if that also leaves the
   * note empty, the record is deleted entirely (see `mergeRatingPatch`).
   */
  setScore: (id: string, mediaType: MediaType, score: number | null) => Promise<void>;
  setNote: (id: string, mediaType: MediaType, note: string) => Promise<void>;
}

const RatingsContext = createContext<RatingsContextValue | null>(null);

export function RatingsProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<Record<string, RatingEntry>>({});
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    ratingsStore.getAll().then((all) => {
      if (!cancelled) {
        setEntries(all);
        setReady(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Same concurrency caveat as TrackingProvider: `previous` is the snapshot
  // at the moment THIS call started, not whatever `entries` is when the
  // write settles. Acceptable here for the same reason — each control
  // (slider, notes field) disables itself while its own write is pending, so
  // the actual common case is one edit, one in-flight write.
  async function applyPatch(
    id: string,
    mediaType: MediaType,
    patch: { score?: number | null; note?: string },
  ) {
    const key = ratingKey(mediaType, id);
    const previous = entries;
    const next = mergeRatingPatch(previous[key], id, mediaType, patch, new Date());

    const optimistic = { ...previous };
    if (next === null) delete optimistic[key];
    else optimistic[key] = next;
    setEntries(optimistic);

    try {
      if (next === null) await ratingsStore.remove(key);
      else await ratingsStore.set(key, next);
    } catch (error) {
      setEntries(previous);
      throw error;
    }

    // Phase 6 Step 5, after the local write and never before — the same
    // ordering rule the watch log follows. One local record becomes two queued
    // rows (`ratings` and `rating_notes`), because design doc §7 keeps notes in
    // their own table so a future sharing feature cannot reach them. No-ops
    // when signed out.
    if (next === null) void recordRatingDelete(mediaType, id);
    else void recordRatingWrite(next);
  }

  const value: RatingsContextValue = {
    ready,
    entries,
    getEntry: (id, mediaType) => entries[ratingKey(mediaType, id)],
    setScore: (id, mediaType, score) => applyPatch(id, mediaType, { score }),
    setNote: (id, mediaType, note) => applyPatch(id, mediaType, { note }),
  };

  return <RatingsContext.Provider value={value}>{children}</RatingsContext.Provider>;
}

export function useRatings(): RatingsContextValue {
  const ctx = useContext(RatingsContext);
  if (!ctx) {
    throw new Error("useRatings() must be called within a <RatingsProvider>.");
  }
  return ctx;
}
