"use client";

import { useEffect, useRef, useState } from "react";

import { useStreak } from "@/components/streak/use-streak";
import {
  BADGES,
  badgesEarnedStore,
  evaluateBadges,
  type BadgeContext,
  type BadgeDefinition,
  type BadgeStatus,
  type EarnedBadgeRecord,
} from "@/lib/badges";
import { useRatings } from "@/lib/ratings";
import { recordBadgeEarned } from "@/lib/sync/record";
import { useTracking } from "@/lib/tracking";
import {
  byHourOfDay,
  earliestDayForTitle,
  getAllWatchLogDays,
  hasRepeatedMark,
  maxEpisodesOfSameTitleInADay,
  type DayKey,
} from "@/lib/watchlog";

/**
 * Orchestration for the badge case + unlock toast — gathers everything
 * `evaluateBadges` needs from useTracking()/useRatings()/useStreak() (no new
 * fetches; all three are already in-memory context providers) plus one pass
 * over the full watch log for the aggregates only lib/watchlog can produce
 * (hour-of-day buckets, same-day episode bursts, repeated marks, earliest
 * day per title). Re-runs that log pass whenever `entries` changes, same
 * "cheap, close-enough proxy" reasoning `useStreak` already documents.
 *
 * All hooks below run UNCONDITIONALLY every render, same discipline as
 * use-xp.ts after its Rules-of-Hooks fix — `ready` only gates which effect
 * BODIES do work, never which hooks are called.
 */
export interface UseBadgesResult {
  ready: boolean;
  statuses: BadgeStatus[];
  /** Queued unlocks awaiting a toast, oldest first. */
  newlyUnlocked: BadgeDefinition[];
  dismissOldestUnlock: () => void;
}

export function useBadges(): UseBadgesResult {
  const { ready: trackingReady, entries } = useTracking();
  const { ready: ratingsReady, entries: ratingEntries } = useRatings();
  const { ready: streakReady, status: streak } = useStreak();

  const [logReady, setLogReady] = useState(false);
  const [hourCounts, setHourCounts] = useState<number[]>(() => new Array(24).fill(0));
  const [maxEpisodesInADay, setMaxEpisodesInADay] = useState(0);
  const [repeatedMark, setRepeatedMark] = useState(false);
  const [earliestDays, setEarliestDays] = useState<Record<string, DayKey>>({});

  useEffect(() => {
    let cancelled = false;
    getAllWatchLogDays().then((allDays) => {
      if (cancelled) return;
      const dayValues = Object.values(allDays);
      setHourCounts(byHourOfDay(dayValues));
      setMaxEpisodesInADay(maxEpisodesOfSameTitleInADay(dayValues));
      setRepeatedMark(hasRepeatedMark(dayValues));
      setEarliestDays(earliestDayForTitle(Object.entries(allDays)));
      setLogReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [entries]);

  const [ledger, setLedger] = useState<Record<string, EarnedBadgeRecord>>({});
  const [ledgerReady, setLedgerReady] = useState(false);
  // True only until the FIRST evaluation this hook ever runs has completed —
  // see the doc comment in the evaluation effect below for why that one pass
  // is treated differently from every subsequent one.
  const isFirstEverPass = useRef(true);

  useEffect(() => {
    badgesEarnedStore.getAll().then((all) => {
      isFirstEverPass.current = Object.keys(all).length === 0;
      setLedger(all);
      setLedgerReady(true);
    });
  }, []);

  const [newlyUnlocked, setNewlyUnlocked] = useState<BadgeDefinition[]>([]);

  const ready = trackingReady && ratingsReady && streakReady && logReady && ledgerReady;

  // Derived, not stored — same discipline the search page's own comment
  // documents ("loading is derived, not a state variable"): every input is
  // already in hand, so `statuses` needs no useState/useEffect pair of its
  // own, just a plain computation each render. evaluateBadges is a cheap
  // pass over 20 predicates against small in-memory data.
  const context: BadgeContext = {
    entries,
    ratingEntries,
    streak,
    hourCounts,
    maxEpisodesInADay,
    hasRepeatedMark: repeatedMark,
    earliestDayForTitle: earliestDays,
  };
  const statuses = ready ? evaluateBadges(BADGES, context, ledger).statuses : [];

  // The ONE genuine side effect: persisting newly-true conditions and
  // queueing a toast. Recomputes evaluateBadges rather than reusing the
  // render-body call above — that result is a fresh object every render and
  // can't be a dependency, so this effect depends on the same primitive
  // inputs instead and re-derives what it needs from them.
  useEffect(() => {
    if (!ready) return;

    // Captured before this pass does anything, then unconditionally
    // consumed: only the very first evaluation this browser has ever run can
    // be a "silent backfill". A user adopting this feature after already
    // having months of history would otherwise open Profile to a stack of
    // toasts firing at once for things they did long ago — the badges are
    // still earned and persisted, they just don't get a celebration for
    // history the badge system wasn't around to see happen live.
    const isFirstPass = isFirstEverPass.current;
    isFirstEverPass.current = false;

    const evaluation = evaluateBadges(
      BADGES,
      { entries, ratingEntries, streak, hourCounts, maxEpisodesInADay, hasRepeatedMark: repeatedMark, earliestDayForTitle: earliestDays },
      ledger,
    );
    if (evaluation.newlyEarnedIds.length === 0) return;

    const now = new Date();
    const updates: Record<string, EarnedBadgeRecord> = {};
    for (const id of evaluation.newlyEarnedIds) updates[id] = { earnedAt: now };

    // Both setState calls below run inside this .then(), not synchronously
    // in the effect body — same idiom use-xp.ts's justLeveledUp effect
    // already uses, required by eslint's react-hooks/set-state-in-effect.
    // Persistence failures are swallowed per-badge (best-effort, same as the
    // watch log's own appends: a failed write just means the badge
    // re-evaluates and re-persists next time), so this always resolves.
    Promise.all(
      evaluation.newlyEarnedIds.map((id) =>
        badgesEarnedStore
          .set(id, { earnedAt: now })
          // Phase 6 Step 5: queue for sync only after the local write lands,
          // inside the `then` rather than alongside it, so a badge that failed
          // to persist locally is never uploaded. The server takes
          // LEAST(earned_at), so a badge already earned earlier on another
          // device keeps its true date.
          .then(() => recordBadgeEarned(id, now))
          .catch((error) => {
            console.warn(`[badges] could not persist "${id}" as earned.`, error);
          }),
      ),
    ).then(() => {
      setLedger((prev) => ({ ...prev, ...updates }));

      if (!isFirstPass) {
        const newlyEarnedDefinitions = evaluation.newlyEarnedIds
          .map((id) => BADGES.find((b) => b.id === id))
          .filter((d): d is BadgeDefinition => d !== undefined);
        setNewlyUnlocked((prev) => [...prev, ...newlyEarnedDefinitions]);
      }
    });
  }, [ready, entries, ratingEntries, streak, hourCounts, maxEpisodesInADay, repeatedMark, earliestDays, ledger]);

  function dismissOldestUnlock() {
    setNewlyUnlocked((prev) => prev.slice(1));
  }

  return { ready, statuses, newlyUnlocked, dismissOldestUnlock };
}
