import { episodesWatchedFor, movieRuntimeMinutesFor } from "@/lib/xp";
import {
  DEFAULT_EPISODE_RUNTIME_MINUTES,
  type MovieTrackingEntry,
  type TrackingEntry,
  type TvTrackingEntry,
} from "@/lib/tracking";
import type { RatingEntry } from "@/lib/ratings";
import { isDayKey, totals, type DayKey, type WatchLogDay } from "@/lib/watchlog";

import type {
  DecadeCount,
  GenreCount,
  HeatmapDay,
  PeriodCounts,
  RatingBucket,
  RatingComparison,
  TopShow,
  WatchTimeSummary,
} from "./types";

/**
 * Pure aggregation over data already in hand from lib/tracking, lib/ratings,
 * and lib/watchlog — same "no new provider fetch" discipline as lib/badges.
 * No storage, no dates from the clock except where a `today`/`year` is
 * explicitly passed in, so every one of these is testable against fixed
 * inputs.
 */

/** Entries actually engaged with — same "watching or watched" definition
 *  lib/badges uses for exploration badges, kept consistent here rather than
 *  reinvented. A movie is only ever "watchlist" or "watched" (no in-progress
 *  concept per CLAUDE.md), so this is a no-op filter for movies. */
function startedEntries(entries: TrackingEntry[]): TrackingEntry[] {
  return entries.filter((entry) => entry.status !== "watchlist");
}

export function computeGenreCounts(entries: TrackingEntry[]): GenreCount[] {
  const counts = new Map<string, GenreCount>();
  for (const entry of startedEntries(entries)) {
    for (const genre of entry.summary.genres) {
      const existing = counts.get(genre.id);
      if (existing) existing.count += 1;
      else counts.set(genre.id, { id: genre.id, name: genre.name, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

export function computeDecadeCounts(entries: TrackingEntry[]): DecadeCount[] {
  const counts = new Map<number, number>();
  for (const entry of startedEntries(entries)) {
    if (entry.summary.year === null) continue;
    const decade = Math.floor(entry.summary.year / 10) * 10;
    counts.set(decade, (counts.get(decade) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([decade, count]) => ({ decade, count }))
    .sort((a, b) => a.decade - b.decade);
}

/** Ranked by actual episodes watched, regardless of the show's current
 *  coarse status — a "watching" show with 80 episodes seen outranks a
 *  "watched" show with 12, and `episodesWatchedFor` already resolves the
 *  coarse-mark fallback, so no reconciliation is needed here. */
export function computeTopShows(entries: TrackingEntry[], limit: number): TopShow[] {
  const tvEntries = entries.filter((e): e is TvTrackingEntry => e.mediaType === "tv");
  return tvEntries
    .map((entry) => ({
      id: entry.id,
      name: entry.summary.name,
      episodesWatched: episodesWatchedFor(entry),
    }))
    .filter((show) => show.episodesWatched > 0)
    .sort((a, b) => b.episodesWatched - a.episodesWatched)
    .slice(0, limit);
}

/**
 * Mirrors exactly what `components/profile/use-xp.ts` already sums for XP
 * purposes (same entry filters: all TV entries via `episodesWatchedFor`,
 * only WATCHED movies via `movieRuntimeMinutesFor`) — reused here to answer
 * a genuinely different question, TIME rather than XP. Episodes use the flat
 * `DEFAULT_EPISODE_RUNTIME_MINUTES` estimate for the same reason XP does:
 * true per-episode runtime isn't stored anywhere (see the note on
 * `XP_PER_EPISODE` in lib/xp/formula.ts) — an estimate, not a measurement.
 */
export function computeWatchTime(entries: TrackingEntry[]): WatchTimeSummary {
  const episodeMinutes = entries
    .filter((e): e is TvTrackingEntry => e.mediaType === "tv")
    .reduce((sum, entry) => sum + episodesWatchedFor(entry) * DEFAULT_EPISODE_RUNTIME_MINUTES, 0);

  const movieMinutes = entries
    .filter((e): e is MovieTrackingEntry => e.mediaType === "movie" && e.status === "watched")
    .reduce((sum, entry) => sum + movieRuntimeMinutesFor(entry), 0);

  const totalMinutes = episodeMinutes + movieMinutes;
  return {
    totalMinutes,
    totalHours: Math.round(totalMinutes / 60),
    totalDays: Math.round((totalMinutes / 60 / 24) * 10) / 10,
  };
}

/** All-time episode/movie counts from TRACKING state, not the watch log —
 *  exact and complete, including everything watched before Phase 5 Step 1's
 *  log existed. Same reasoning CLAUDE.md gives for why lifetime XP never
 *  comes from log length. */
export function computeAllTimeCounts(entries: TrackingEntry[]): PeriodCounts {
  const episodes = entries
    .filter((e): e is TvTrackingEntry => e.mediaType === "tv")
    .reduce((sum, entry) => sum + episodesWatchedFor(entry), 0);
  const movies = entries.filter((e) => e.mediaType === "movie" && e.status === "watched").length;
  return { episodes, movies };
}

/** "This year" can ONLY come from the watch log — tracking state has no
 *  per-event dates. Honest consequence: a title watched before Phase 5 Step
 *  1 shipped, even earlier this same year, is invisible here. Same
 *  no-backfill gap already accepted everywhere else the log is read. */
export function computeThisYearCounts(daysThisYear: Iterable<WatchLogDay>): PeriodCounts {
  const t = totals(daysThisYear);
  return { episodes: t.episodes, movies: t.movies };
}

function ratingBucketLabel(index: number): string {
  return index === 9 ? "90-100" : `${index * 10}-${index * 10 + 9}`;
}

/** 10 fixed buckets, "0-9" through "90-100" — a score of exactly 100 falls
 *  into the last bucket alongside 90-99 rather than getting an 11th bucket
 *  of its own. */
export function computeRatingDistribution(ratingEntries: RatingEntry[]): RatingBucket[] {
  const buckets = Array.from({ length: 10 }, (_, i) => ({ label: ratingBucketLabel(i), count: 0 }));
  for (const entry of ratingEntries) {
    if (entry.score === null) continue;
    const index = Math.min(9, Math.floor(entry.score / 10));
    buckets[index].count += 1;
  }
  return buckets;
}

/** `entries`/`ratingEntries` keep the shared `${mediaType}:${id}` keying, so
 *  matching a rating to its tracked title's TMDB score is one lookup per
 *  rating — same pattern the "Contrarian" badge uses. */
export function computeRatingComparison(
  entries: Record<string, TrackingEntry>,
  ratingEntries: Record<string, RatingEntry>,
): RatingComparison {
  let userTotal = 0;
  let tmdbTotal = 0;
  let sampleSize = 0;

  for (const [key, rating] of Object.entries(ratingEntries)) {
    if (rating.score === null) continue;
    const tmdbRating = entries[key]?.summary.rating;
    if (tmdbRating === undefined || tmdbRating === null) continue;
    userTotal += rating.score;
    tmdbTotal += tmdbRating * 10;
    sampleSize += 1;
  }

  return {
    userAverage: sampleSize === 0 ? null : Math.round((userTotal / sampleSize) * 10) / 10,
    tmdbAverage: sampleSize === 0 ? null : Math.round((tmdbTotal / sampleSize) * 10) / 10,
    sampleSize,
  };
}

/**
 * Every day of `year` (local calendar), Jan 1 through Dec 31, with its log
 * event count — 0 for days with no activity, not omitted, so a calendar
 * heatmap component can render a complete, evenly-spaced grid without
 * needing to know the calendar itself. `entries` is the log's full
 * `[DayKey, WatchLogDay][]`, same shape `earliestDayForTitle` takes.
 *
 * Walks by CALENDAR day (`date.setDate(date.getDate() + 1)`), never by
 * adding fixed milliseconds to a local `Date` — the same DST hazard
 * `lib/watchlog/types.ts`'s `shiftDay` already exists to avoid. A 23- or
 * 25-hour local day means a fixed 86,400,000ms step can land off local
 * midnight right at a DST boundary; `setDate` operates on calendar fields
 * and normalizes correctly regardless.
 */
export function computeHeatmap(entries: Iterable<[DayKey, WatchLogDay]>, year: string): HeatmapDay[] {
  const counts = new Map<string, number>();
  for (const [day, events] of entries) {
    if (!isDayKey(day) || !day.startsWith(year)) continue;
    counts.set(day, (counts.get(day) ?? 0) + events.length);
  }

  const cursor = new Date(Number(year), 0, 1);
  const days: HeatmapDay[] = [];
  while (cursor.getFullYear() === Number(year)) {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(
      cursor.getDate(),
    ).padStart(2, "0")}`;
    days.push({ day: key, count: counts.get(key) ?? 0 });
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}
