import type { MediaType } from "@/lib/content/types";
import type { WatchedEpisodes } from "@/lib/tracking/types";

import { addedEpisodes } from "./diff";
import { watchLogStore } from "./store";
import {
  localDayKey,
  localMinuteOfDay,
  WATCH_KIND,
  watchTitleKey,
  type DayKey,
  type WatchEvent,
  type WatchLogDay,
} from "./types";

/**
 * Public surface of the watch-date log.
 *
 * ============================================================================
 * WHAT THIS STORE IS AND IS NOT AUTHORITATIVE FOR
 * ============================================================================
 * This log answers **WHEN** — streaks, "what did I watch in June", time-of-day
 * patterns. It is NOT the source of truth for **HOW MUCH**.
 *
 * Lifetime totals come from tracking state (`countRanges` over
 * `watchedEpisodes`), which knows exactly and includes everything watched
 * before this log existed. That split is not a nicety, it resolves two real
 * problems at once:
 *
 *   1. BACKFILL. Existing users have watched data with no dates, and there is
 *      no honest way to invent them — `updatedAt` is a single timestamp for a
 *      whole entry, so backfilling Breaking Bad from it would fabricate a
 *      62-episode day and a streak that never happened. So nothing is
 *      backfilled at all; the log simply starts empty and `trackingSince()`
 *      makes the gap legible instead of invisible.
 *   2. UN-MARKING. Because totals never come from log length, the log can stay
 *      genuinely append-only — un-marking an episode does not rewrite history
 *      and cannot corrupt any count.
 *
 * If XP were computed from log rows, (1) would reset every existing user to
 * zero and (2) would require deleting from an "append-only" log. Neither is
 * necessary.
 */

export { watchLogStore } from "./store";
export { addedEpisodes } from "./diff";
export type { AddedEpisode } from "./diff";
export {
  dayDifference,
  isDayKey,
  isWatchEvent,
  isWatchLogDay,
  localDayKey,
  localMinuteOfDay,
  nextDay,
  previousDay,
  shiftDay,
  WATCH_KIND,
  watchTitleKey,
  yearOf,
} from "./types";
export type { DayKey, WatchEvent, WatchKind, WatchLogDay } from "./types";
export {
  activeDays,
  byHourOfDay,
  byWeekday,
  currentStreak,
  daysInYear,
  earliestDayForTitle,
  eventsForTitle,
  hasRepeatedMark,
  longestStreak,
  maxEpisodesOfSameTitleInADay,
  totals,
  trackingSince,
  yearsCovered,
} from "./queries";
export type { WatchTotals } from "./queries";
export {
  computeStreakStatus,
  FREEZE_EARN_INTERVAL_DAYS,
  MAX_BANKED_FREEZES,
} from "./streaks";
export type { StreakStatus } from "./streaks";

/* ---------------------------------------------------------------------------
 * Appending
 * ------------------------------------------------------------------------ */

/**
 * Appends events to their day's record.
 *
 * One read-modify-write per DAY, not per event — marking a 13-episode season
 * is a single storage round trip, not 13. In practice every event in a call
 * shares one day, since they are all stamped from the same instant.
 *
 * Never throws. Logging is strictly secondary to the tracking write that
 * triggered it: marking something watched must not fail because a history
 * record could not be appended. Failures are warned and swallowed.
 *
 * Known limitation, consistent with the multi-tab gap already documented in
 * CLAUDE.md: this is a read-modify-write with no lock, so two appends racing
 * for the same day could lose one. Each mutating control disables itself
 * while its write is in flight, so the realistic path is sequential.
 */
export async function appendWatchEvents(events: WatchEvent[]): Promise<void> {
  if (events.length === 0) return;

  const day = localDayKey();
  try {
    const existing = (await watchLogStore.get(day)) ?? [];
    await watchLogStore.set(day, [...existing, ...events]);
  } catch (error) {
    console.warn("[watchlog] could not append events; continuing.", error);
  }
}

/* ---------------------------------------------------------------------------
 * Event builders
 *
 * Call sites use these rather than object literals so the short stored field
 * names (`k`/`t`/`s`/`e`/`m`/`b`) stay an implementation detail of this
 * package.
 * ------------------------------------------------------------------------ */

/** One deliberate episode mark, or one of many from a bulk action. */
export function episodeEvent(
  mediaType: MediaType,
  id: string,
  seasonNumber: number,
  episodeNumber: number,
  options: { bulk?: boolean; at?: Date } = {},
): WatchEvent {
  const event: WatchEvent = {
    k: WATCH_KIND.EPISODE,
    t: watchTitleKey(mediaType, id),
    s: seasonNumber,
    e: episodeNumber,
    m: localMinuteOfDay(options.at),
  };
  if (options.bulk) event.b = 1;
  return event;
}

export function movieEvent(id: string, options: { at?: Date } = {}): WatchEvent {
  return {
    k: WATCH_KIND.MOVIE,
    t: watchTitleKey("movie", id),
    m: localMinuteOfDay(options.at),
  };
}

/** A whole show marked watched at the title level. Episodes are genuinely
 *  unknown on that path — see the note on WATCH_KIND.TITLE. */
export function titleEvent(id: string, options: { at?: Date } = {}): WatchEvent {
  return {
    k: WATCH_KIND.TITLE,
    t: watchTitleKey("tv", id),
    m: localMinuteOfDay(options.at),
  };
}

/**
 * The one call `applyEpisodeMutation` makes. Diffs before/after, builds an
 * event per newly-marked episode, and appends them.
 *
 * `bulk` is passed explicitly by the caller rather than inferred from the
 * count: inference would happen to be correct today (single marks add exactly
 * one episode) but would silently misclassify a future operation, and this is
 * a field that can never be recovered once written wrong.
 */
export async function logEpisodeMutation(
  mediaType: MediaType,
  id: string,
  before: WatchedEpisodes,
  after: WatchedEpisodes,
  options: { bulk: boolean },
): Promise<void> {
  if (mediaType !== "tv") return;

  const added = addedEpisodes(before, after);
  if (added.length === 0) return; // un-marks and no-ops log nothing

  const at = new Date();
  await appendWatchEvents(
    added.map(({ seasonNumber, episodeNumber }) =>
      episodeEvent(mediaType, id, seasonNumber, episodeNumber, { bulk: options.bulk, at }),
    ),
  );
}

/* ---------------------------------------------------------------------------
 * Reads
 * ------------------------------------------------------------------------ */

export async function getWatchLogDay(day: DayKey): Promise<WatchLogDay> {
  return (await watchLogStore.get(day)) ?? [];
}

/** Every day with activity. Reads KEYS only — no record values are parsed,
 *  which is the whole reason the log is bucketed by day. */
export async function getActiveDays(): Promise<DayKey[]> {
  return watchLogStore.keys();
}

export async function getAllWatchLogDays(): Promise<Record<DayKey, WatchLogDay>> {
  return watchLogStore.getAll();
}
