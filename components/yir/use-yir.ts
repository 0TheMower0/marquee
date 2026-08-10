"use client";

import { useEffect, useState } from "react";

import { ratingsStore, type RatingEntry } from "@/lib/ratings";
import { useTracking } from "@/lib/tracking";
import { localDayKey, watchLogStore, type DayKey, type WatchLogDay } from "@/lib/watchlog";
import { computeYir, selectCards, type YirCardId, type YirData } from "@/lib/yir";

/**
 * Loads everything Year in Review needs from LOCAL storage and computes the
 * deck. No network, no account — this works offline and signed out.
 *
 * Reads the whole log rather than a windowed slice, because the store is a
 * flat key-value namespace with no range query. That is fine at this scale:
 * a day record is a small array, and `lib/watchlog/types.ts` measured two
 * years of daily viewing at ~128 KB total. Windowing happens in `computeYir`.
 *
 * ⚠️ `ratingsStore.getAll()` returns whole `RatingEntry` objects, which
 * INCLUDE the private `note`. Those objects are handed to `computeYir`, which
 * reads `score` and nothing else — a fact pinned by a test asserting no note
 * text survives into the computed output. Do not start passing these entries
 * anywhere else.
 */
export interface UseYirResult {
  /** False until local storage has been read. Render a skeleton, not an
   *  empty state — the difference matters when the answer is "you have
   *  nothing", which is a real result rather than a loading state. */
  ready: boolean;
  data: YirData | null;
  cards: YirCardId[];
}

export function useYir(): UseYirResult {
  const { ready: trackingReady, entries } = useTracking();
  const [log, setLog] = useState<Map<DayKey, WatchLogDay> | null>(null);
  const [ratings, setRatings] = useState<RatingEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Both reads degrade to empty rather than rejecting — the storage layer
    // returns null on a failed read by design, and a Year in Review that
    // refuses to render because ratings could not be read would be worse
    // than one missing a single card.
    void Promise.all([watchLogStore.getAll(), ratingsStore.getAll()])
      .then(([days, ratingEntries]) => {
        if (cancelled) return;
        setLog(new Map(Object.entries(days) as [DayKey, WatchLogDay][]));
        setRatings(Object.values(ratingEntries));
      })
      .catch((error) => {
        console.warn("[marquee] year in review: could not read local data", error);
        if (cancelled) return;
        setLog(new Map());
        setRatings([]);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const ready = trackingReady && log !== null && ratings !== null;
  if (!ready) return { ready: false, data: null, cards: [] };

  const data = computeYir({
    days: log,
    entries: Object.values(entries),
    ratings,
    // Local, not UTC: the window's edges are calendar days in the user's own
    // timezone, the same discipline the watch log itself uses for day keys.
    today: localDayKey(),
  });

  return { ready: true, data, cards: selectCards(data) };
}
