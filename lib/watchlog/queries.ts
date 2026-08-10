import {
  isDayKey,
  localDayKey,
  nextDay,
  previousDay,
  WATCH_KIND,
  yearOf,
  type DayKey,
  type WatchEvent,
  type WatchLogDay,
} from "./types";

/**
 * Pure queries over the log. No storage, no dates-from-the-clock except where
 * a `today` is explicitly passed in — so every one of these is testable
 * against fixed inputs, the same discipline as lib/tracking/progress.ts and
 * lib/tracking/upnext.ts.
 *
 * Note what these functions take: mostly just **day keys**, not events. That
 * is the day-bucketed layout paying off — `Store.keys()` returns exactly this,
 * so streak math never reads or parses a single record value.
 */

/** Valid day keys only, de-duplicated, sorted ascending. Everything below
 *  assumes this has been applied; hand-edited or future-version storage could
 *  otherwise put junk keys into a streak walk. */
export function activeDays(keys: Iterable<string>): DayKey[] {
  return [...new Set(keys)].filter(isDayKey).sort();
}

/**
 * Length of the streak ending today, in days.
 *
 * A streak is **alive but not yet extended** when the user hasn't watched
 * anything today but did yesterday — so this counts back from yesterday in
 * that case rather than returning 0. Resetting a 40-day streak to zero at
 * 00:01 because the day is young would be both wrong and infuriating.
 * Anything older than yesterday is a broken streak.
 */
export function currentStreak(
  keys: Iterable<string>,
  today: DayKey = localDayKey(),
): number {
  const days = new Set(activeDays(keys));

  let cursor = days.has(today) ? today : previousDay(today);
  if (!days.has(cursor)) return 0;

  let length = 0;
  while (days.has(cursor)) {
    length += 1;
    cursor = previousDay(cursor);
  }
  return length;
}

/** Longest run of consecutive days ever recorded. */
export function longestStreak(keys: Iterable<string>): number {
  const days = activeDays(keys);

  let best = 0;
  let run = 0;
  let previous: DayKey | null = null;

  for (const day of days) {
    run = previous !== null && day === nextDay(previous) ? run + 1 : 1;
    previous = day;
    if (run > best) best = run;
  }
  return best;
}

/**
 * The first day anything was logged, or null on an empty log.
 *
 * This is how "tracking since <date>" is answered, and it is why the log
 * needs no separate metadata record: the earliest key IS the start of
 * history. Keeping `keys()` purely day keys is what preserves that — do not
 * add non-date keys to this namespace.
 */
export function trackingSince(keys: Iterable<string>): DayKey | null {
  return activeDays(keys)[0] ?? null;
}

/** Day keys falling in a calendar year. Filters on the KEY — no record values
 *  are read, which is what makes a Year in Review scan cheap. */
export function daysInYear(keys: Iterable<string>, year: number | string): DayKey[] {
  const wanted = String(year);
  return activeDays(keys).filter((day) => yearOf(day) === wanted);
}

/** Distinct years present in the log, ascending. */
export function yearsCovered(keys: Iterable<string>): string[] {
  return [...new Set(activeDays(keys).map(yearOf))].sort();
}

export interface WatchTotals {
  /** Every logged event, of any kind. */
  events: number;
  episodes: number;
  movies: number;
  /** Coarse "whole show marked watched" events — deliberately counted
   *  separately, because one of these is not one episode and pretending
   *  otherwise would silently inflate an episode count. */
  titles: number;
  /** Events that came from a bulk action rather than a single deliberate
   *  mark. A subset of the above, not an additional bucket. */
  fromBulk: number;
}

/**
 * Totals over already-loaded days.
 *
 * IMPORTANT — this counts what the LOG knows, which is history since logging
 * began, NOT the user's lifetime totals. Lifetime "how much have I watched"
 * must come from tracking state (`countRanges`), which knows exactly and
 * includes everything watched before this log existed. See the note in
 * ./index.ts on why that split matters.
 */
export function totals(days: Iterable<WatchLogDay>): WatchTotals {
  const result: WatchTotals = { events: 0, episodes: 0, movies: 0, titles: 0, fromBulk: 0 };

  for (const day of days) {
    for (const event of day) {
      result.events += 1;
      if (event.b === 1) result.fromBulk += 1;
      if (event.k === WATCH_KIND.EPISODE) result.episodes += 1;
      else if (event.k === WATCH_KIND.MOVIE) result.movies += 1;
      else if (event.k === WATCH_KIND.TITLE) result.titles += 1;
    }
  }
  return result;
}

/**
 * Whether an event says anything trustworthy about WHEN the user watched.
 *
 * ============================================================================
 * BULK EVENTS RECORD WHEN YOU CLICKED, NOT WHEN YOU WATCHED
 * ============================================================================
 * `b: 1` marks an event that came from a bulk action — "mark season watched",
 * "binge to here". Every event in such a batch carries the SAME `m`: the
 * minute of the click. Thirteen episodes at 04:43 is one tap at 04:43, not
 * thirteen viewings at 04:43.
 *
 * This was measured on real data before being fixed, and the skew is not
 * subtle. In a 39-event log, 33 events were a single "mark season watched":
 *
 *   including bulk   "you watch most at 4am" — 35 events in that hour
 *   excluding bulk   that hour has 2
 *
 * `types.ts` already anticipated half of this — it says Year in Review "can
 * decline to call it the user's biggest session". The half it did not
 * anticipate is that the same corruption applies to TIME-OF-DAY and WEEKDAY
 * aggregation, which both silently counted bulk events from Phase 5 until
 * Phase 8 Step 1. The stats dashboard's hour histogram and the time-of-day
 * BADGES were both affected: a user who bulk-marked a season at 4am could
 * earn "Night Owl" for one click. (Badges are ledgered and sticky, so nothing
 * already earned is revoked by this fix — only future evaluations change.)
 *
 * Filtering happens HERE rather than in each caller on purpose: there is no
 * legitimate consumer of "what hour did you press the button", so an opt-in
 * flag would only be a way to reintroduce the bug.
 */
function describesRealViewingTime(event: WatchEvent): boolean {
  // `m` absent means the time is genuinely unknown — an IMDb or Letterboxd
  // import, which records a calendar date and no clock time. Skipped rather
  // than defaulted to midnight, which would invent a spike at 00:00.
  if (event.m === undefined) return false;
  return event.b !== 1;
}

/**
 * Events bucketed by local hour (0–23), for "you watch most at 10pm".
 *
 * Counts only events that describe a real viewing time — see
 * `describesRealViewingTime` for why bulk marks and untimed imports are both
 * excluded, and for the measurement that prompted it.
 */
export function byHourOfDay(days: Iterable<WatchLogDay>): number[] {
  const hours = new Array<number>(24).fill(0);
  for (const day of days) {
    for (const event of day) {
      if (!describesRealViewingTime(event)) continue;
      hours[Math.floor(event.m! / 60)] += 1;
    }
  }
  return hours;
}

/**
 * Events bucketed by weekday, Sunday = 0, for "you watch most on Sundays".
 * Takes day keys paired with their events, since the weekday comes from the
 * date, not the event.
 *
 * Bulk events are excluded here too, and this one skewed HARDER than the hour
 * histogram did: it counted `events.length` outright, so a single 33-episode
 * season mark added 33 to one weekday. That is one Friday afternoon reading
 * as the heaviest viewing day of someone's year.
 *
 * Untimed imports ARE counted here, unlike in `byHourOfDay` — and the
 * asymmetry is deliberate. A Letterboxd row has no clock time but does have a
 * real calendar date, so it knows exactly which weekday it was. Excluding it
 * would discard information we actually have.
 */
export function byWeekday(entries: Iterable<[DayKey, WatchLogDay]>): number[] {
  const weekdays = new Array<number>(7).fill(0);
  for (const [day, events] of entries) {
    if (!isDayKey(day)) continue;
    const [year, month, date] = day.split("-").map(Number);
    // Local construction, same reason as everywhere else in this package.
    const weekday = new Date(year, month - 1, date).getDay();
    weekdays[weekday] += events.filter((event) => event.b !== 1).length;
  }
  return weekdays;
}

/** Every event for one title across the given days. */
export function eventsForTitle(
  days: Iterable<WatchLogDay>,
  titleKey: string,
): WatchEvent[] {
  const found: WatchEvent[] = [];
  for (const day of days) {
    for (const event of day) {
      if (event.t === titleKey) found.push(event);
    }
  }
  return found;
}

/**
 * The largest number of EPISODE-kind events for one title logged on a single
 * day, across the whole log. Each `WatchLogDay` is already exactly one
 * calendar day's events (that is the log's own bucketing), so this needs no
 * day keys — just count within each day and keep the max. Powers the
 * "Marathoner" badge.
 */
export function maxEpisodesOfSameTitleInADay(days: Iterable<WatchLogDay>): number {
  let max = 0;
  for (const day of days) {
    const perTitle = new Map<string, number>();
    for (const event of day) {
      if (event.k !== WATCH_KIND.EPISODE) continue;
      const count = (perTitle.get(event.t) ?? 0) + 1;
      perTitle.set(event.t, count);
      if (count > max) max = count;
    }
  }
  return max;
}

/**
 * True if the exact same thing (same kind, same title, same episode when
 * applicable) was ever logged more than once. The ONLY way that happens is a
 * genuine unmark-then-remark: `logEpisodeMutation`/`setStatus` both log
 * strictly on a transition INTO watched (see the comments at their call
 * sites), so a duplicate here is never bulk-action fan-out or a logging bug —
 * it is the user marking something watched, then marking it watched again
 * later. Powers "Second Helping".
 */
export function hasRepeatedMark(days: Iterable<WatchLogDay>): boolean {
  const seen = new Set<string>();
  for (const day of days) {
    for (const event of day) {
      const identity = `${event.k}:${event.t}:${event.s ?? ""}:${event.e ?? ""}`;
      if (seen.has(identity)) return true;
      seen.add(identity);
    }
  }
  return false;
}

/**
 * The earliest day key on which each title was logged, keyed by the event's
 * `t` field. For a multi-episode show this is the day the FIRST logged event
 * happened, a reasonable proxy for "when you started watching it" — good
 * enough for a badge, not a precise per-episode timeline.
 *
 * A title marked watched before Phase 5 Step 1 shipped (no backfill, by
 * design — see the note in ./index.ts) has no entry here at all. That is an
 * honest gap, not a bug: nothing in the log knows when it happened.
 */
export function earliestDayForTitle(
  entries: Iterable<[DayKey, WatchLogDay]>,
): Record<string, DayKey> {
  const earliest: Record<string, DayKey> = {};
  for (const [day, events] of entries) {
    if (!isDayKey(day)) continue;
    for (const event of events) {
      const existing = earliest[event.t];
      if (existing === undefined || day < existing) {
        earliest[event.t] = day;
      }
    }
  }
  return earliest;
}
