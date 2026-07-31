"use client";

import { useEffect, useMemo, useState } from "react";

import { useBadges } from "@/components/badges/use-badges";
import { useXp } from "@/components/profile/use-xp";
import { useStreak } from "@/components/streak/use-streak";
import { useRatings } from "@/lib/ratings";
import {
  computeAllTimeCounts,
  computeDecadeCounts,
  computeGenreCounts,
  computeHeatmap,
  computeRatingComparison,
  computeRatingDistribution,
  computeThisYearCounts,
  computeTopShows,
  computeWatchTime,
  type DecadeCount,
  type GenreCount,
  type HeatmapDay,
  type PeriodCounts,
  type RatingBucket,
  type RatingComparison,
  type TopShow,
  type WatchTimeSummary,
} from "@/lib/stats";
import { useTracking } from "@/lib/tracking";
import {
  daysInYear,
  getAllWatchLogDays,
  localDayKey,
  yearOf,
  yearsCovered,
  type DayKey,
  type WatchLogDay,
} from "@/lib/watchlog";

const TOP_SHOWS_LIMIT = 8;

const EMPTY_PERIOD: PeriodCounts = { episodes: 0, movies: 0 };
const EMPTY_WATCH_TIME: WatchTimeSummary = { totalMinutes: 0, totalHours: 0, totalDays: 0 };
const EMPTY_RATING_COMPARISON: RatingComparison = { userAverage: null, tmdbAverage: null, sampleSize: 0 };

export interface UseStatsResult {
  ready: boolean;
  watchTime: WatchTimeSummary;
  allTime: PeriodCounts;
  thisYear: PeriodCounts;
  genres: GenreCount[];
  decades: DecadeCount[];
  topShows: TopShow[];
  ratingDistribution: RatingBucket[];
  ratingComparison: RatingComparison;
  heatmap: {
    year: string;
    days: HeatmapDay[];
    availableYears: string[];
    setYear: (year: string) => void;
  };
  gamification: {
    ready: boolean;
    level: number;
    rank: string;
    currentStreak: number;
    badgesEarned: number;
    badgesTotal: number;
  };
}

/**
 * Orchestration for the stats dashboard. Composes the SAME hooks Profile
 * already uses (`useXp`, `useStreak`, `useBadges`) for the gamification
 * summary strip rather than recomputing level/streak/badge logic a second
 * time — only one of these hooks is ever mounted at once (Profile and
 * `/profile/stats` are different routes), so there's no duplicate work, just
 * reuse. Everything else comes from `lib/stats`'s pure aggregation over
 * useTracking()/useRatings() state plus one full read of the watch log — no
 * new content-provider fetch anywhere on this page.
 */
export function useStats(): UseStatsResult {
  const { ready: trackingReady, entries } = useTracking();
  const { ready: ratingsReady, entries: ratingEntries } = useRatings();
  const xp = useXp();
  const streak = useStreak();
  const badges = useBadges();

  const [logReady, setLogReady] = useState(false);
  const [allDays, setAllDays] = useState<Record<DayKey, WatchLogDay>>({});

  useEffect(() => {
    let cancelled = false;
    getAllWatchLogDays().then((days) => {
      if (cancelled) return;
      setAllDays(days);
      setLogReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [entries]);

  const currentYear = yearOf(localDayKey());
  const availableYears = useMemo(() => {
    const covered = yearsCovered(Object.keys(allDays));
    return covered.includes(currentYear) ? covered : [...covered, currentYear].sort();
  }, [allDays, currentYear]);

  const [heatmapYear, setHeatmapYear] = useState(currentYear);

  const ready = trackingReady && ratingsReady && logReady;

  const entryList = useMemo(() => Object.values(entries), [entries]);
  const ratingList = useMemo(() => Object.values(ratingEntries), [ratingEntries]);

  const thisYearDays = useMemo(
    () => daysInYear(Object.keys(allDays), currentYear).map((day) => allDays[day]),
    [allDays, currentYear],
  );

  return {
    ready,
    watchTime: ready ? computeWatchTime(entryList) : EMPTY_WATCH_TIME,
    allTime: ready ? computeAllTimeCounts(entryList) : EMPTY_PERIOD,
    thisYear: ready ? computeThisYearCounts(thisYearDays) : EMPTY_PERIOD,
    genres: ready ? computeGenreCounts(entryList) : [],
    decades: ready ? computeDecadeCounts(entryList) : [],
    topShows: ready ? computeTopShows(entryList, TOP_SHOWS_LIMIT) : [],
    ratingDistribution: ready ? computeRatingDistribution(ratingList) : [],
    ratingComparison: ready ? computeRatingComparison(entries, ratingEntries) : EMPTY_RATING_COMPARISON,
    heatmap: {
      year: heatmapYear,
      days: ready ? computeHeatmap(Object.entries(allDays), heatmapYear) : [],
      availableYears,
      setYear: setHeatmapYear,
    },
    gamification: {
      ready: xp.ready && streak.ready && badges.ready,
      level: xp.progress.level,
      rank: xp.progress.rank,
      currentStreak: streak.status.currentStreak,
      badgesEarned: badges.statuses.filter((s) => s.unlocked).length,
      badgesTotal: badges.statuses.length,
    },
  };
}
