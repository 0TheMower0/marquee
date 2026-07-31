"use client";

import { useEffect, useState } from "react";

import { useTracking } from "@/lib/tracking";
import { computeStreakStatus, getActiveDays, type StreakStatus } from "@/lib/watchlog";

/**
 * Orchestration for both streak surfaces (the Home ambient badge and the
 * Profile summary card) — one fetch-and-compute, shared, same idiom as
 * components/tracking/use-up-next-items.ts and components/profile/use-xp.ts.
 *
 * `getActiveDays()` is a `keys()`-only read (see the doc comment on
 * `getActiveDays` in lib/watchlog/index.ts) — cheap enough to re-run on every
 * tracking change rather than needing its own cache invalidation scheme.
 *
 * Re-runs whenever `entries` from useTracking() changes, not because the
 * watch log and tracking state are the same thing, but because a tracking
 * mutation is the only thing in this app that ever appends to the log —
 * `entries` changing is a cheap, close-enough proxy for "the log may have
 * changed" without wiring a dedicated event bus for one hook. Not every
 * tracking change touches the log (e.g. moving something to "watchlist"
 * doesn't), so this can re-fetch when nothing actually changed — an
 * acceptable, inexpensive false positive, not a correctness problem.
 */
export interface UseStreakResult {
  ready: boolean;
  status: StreakStatus;
}

const EMPTY_STATUS: StreakStatus = {
  currentStreak: 0,
  longestStreak: 0,
  freezesAvailable: 0,
  freezeActive: false,
};

export function useStreak(): UseStreakResult {
  const { entries } = useTracking();
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<StreakStatus>(EMPTY_STATUS);

  useEffect(() => {
    let cancelled = false;
    getActiveDays().then((days) => {
      if (cancelled) return;
      setStatus(computeStreakStatus(days));
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [entries]);

  return { ready, status };
}
