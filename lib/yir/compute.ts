import type { RatingEntry } from "@/lib/ratings/types";
import type { TrackingEntry } from "@/lib/tracking";
import { DEFAULT_EPISODE_RUNTIME_MINUTES } from "@/lib/tracking";
import {
  dayDifference,
  isDayKey,
  shiftDay,
  WATCH_KIND,
  type DayKey,
  type WatchEvent,
  type WatchLogDay,
} from "@/lib/watchlog";

import type {
  CriticDelta,
  CriticVerdict,
  DateRange,
  DecadeReach,
  FirstWatch,
  GenreShape,
  Provenance,
  Rhythm,
  TopShow,
  YirData,
  YirTally,
} from "./types";

/**
 * Year in Review aggregation — pure. No storage, no React, no fetching.
 *
 * ============================================================================
 * WHAT THE LOG DOES AND DOESN'T KNOW
 * ============================================================================
 * A `WatchEvent` is `{k, t, s?, e?, m?, b?}`. It carries NO genre, NO runtime
 * and NO title name — only `t`, a `${mediaType}:${id}` key. Every genre,
 * runtime, decade and name below therefore comes from JOINING the log to
 * tracking entries, whose `summary` is a snapshot taken when the title was
 * tracked.
 *
 * The join can miss: a title the user later untracked has no entry, and its
 * events then contribute to counts but not to genre/decade/name. That
 * degrades a card rather than breaking one, and is why nothing here throws on
 * an unresolved key.
 */

/** Below this share of hours resting on a real runtime, the hours figure is
 *  suppressed rather than shown. Movie runtimes are null on pre-Phase-5
 *  records and episodes always use a flat estimate. */
export const RUNTIME_CONFIDENCE_FLOOR = 0.2;

/** Minimum timed, non-bulk events before a "you're a Sunday night watcher"
 *  claim is worth making. Below this it is noise dressed as insight. */
export const RHYTHM_MIN_SAMPLE = 8;

/** Minimum rated titles (with a crowd score to compare against) before the
 *  critic card appears. Five is enough for a persona; two is not. */
export const CRITIC_MIN_SAMPLE = 3;

/** A genre is a "specialty" at or above this share of all genre tags. */
const SPECIALIST_SHARE = 0.35;
/** At or above this many distinct genres with no specialty, you're an omnivore. */
const OMNIVORE_GENRES = 8;

export interface YirInput {
  /** Every log day, keyed. The caller passes the whole log; this windows it. */
  days: ReadonlyMap<DayKey, WatchLogDay>;
  entries: readonly TrackingEntry[];
  ratings: readonly RatingEntry[];
  /** Today, as a local day key. Injected so tests are deterministic. */
  today: DayKey;
}

/** The rolling window: today back 364 days, inclusive both ends = 365 days. */
export function rollingRange(today: DayKey): DateRange {
  return { from: shiftDay(today, -364), to: today };
}

function withinRange(day: DayKey, range: DateRange): boolean {
  return day >= range.from && day <= range.to;
}

/** `${mediaType}:${id}` — the shared key format across tracking, ratings and
 *  the watch log. Rebuilt here rather than imported so this module depends on
 *  none of those packages' internals. */
function keyOf(entry: { mediaType: string; id: string }): string {
  return `${entry.mediaType}:${entry.id}`;
}

export function computeYir(input: YirInput): YirData {
  const range = rollingRange(input.today);

  const inRange: [DayKey, WatchLogDay][] = [];
  for (const [day, events] of input.days) {
    if (isDayKey(day) && withinRange(day, range)) inRange.push([day, events]);
  }
  inRange.sort((a, b) => a[0].localeCompare(b[0]));

  const byKey = new Map<string, TrackingEntry>();
  for (const entry of input.entries) byKey.set(keyOf(entry), entry);

  const allEvents = inRange.flatMap(([, events]) => events);

  return {
    range,
    tally: computeTally(allEvents, byKey),
    decades: computeDecades(allEvents, byKey),
    genres: computeGenres(allEvents, byKey),
    topShow: computeTopShow(allEvents, byKey),
    critics: computeCritics(allEvents, byKey, input.ratings),
    rhythm: computeRhythm(inRange),
    firstWatch: computeFirstWatch(inRange, byKey),
    provenance: computeProvenance(allEvents),
    activeDays: inRange.length,
    longestStreak: computeLongestStreak(inRange.map(([day]) => day)),
    busiestMonth: computeBusiestMonth(inRange),
  };
}

/* ---------------------------------------------------------------------------
 * Tally
 * ------------------------------------------------------------------------ */

function computeTally(
  events: readonly WatchEvent[],
  byKey: ReadonlyMap<string, TrackingEntry>,
): YirTally {
  let movies = 0;
  let episodes = 0;
  let shows = 0;
  let knownMinutes = 0;
  let estimatedMinutes = 0;

  for (const event of events) {
    if (event.k === WATCH_KIND.MOVIE) {
      movies += 1;
      const entry = byKey.get(event.t);
      // `runtimeMinutes` is null on records written before Phase 5 Step 2 —
      // an honest gap, not a zero. Falls back to a rough feature length.
      const runtime = entry?.mediaType === "movie" ? entry.runtimeMinutes : null;
      if (runtime !== null && runtime !== undefined) knownMinutes += runtime;
      else estimatedMinutes += 110;
    } else if (event.k === WATCH_KIND.EPISODE) {
      episodes += 1;
      // Per-episode runtime is not stored anywhere in this app — see the note
      // on XP_PER_EPISODE in lib/xp/formula.ts. Always an estimate.
      estimatedMinutes += DEFAULT_EPISODE_RUNTIME_MINUTES;
    } else if (event.k === WATCH_KIND.TITLE) {
      // A coarse whole-show mark. Contributes no runtime: we genuinely do not
      // know how many episodes it stood for, and guessing would be the kind
      // of invented number this codebase keeps refusing to produce.
      shows += 1;
    }
  }

  const totalMinutes = knownMinutes + estimatedMinutes;
  return {
    movies,
    episodes,
    shows,
    approxHours: Math.round(totalMinutes / 60),
    runtimeConfidence: totalMinutes === 0 ? 0 : knownMinutes / totalMinutes,
  };
}

/* ---------------------------------------------------------------------------
 * Decade reach — the stat that survives a thin year
 * ------------------------------------------------------------------------ */

function computeDecades(
  events: readonly WatchEvent[],
  byKey: ReadonlyMap<string, TrackingEntry>,
): DecadeReach | null {
  const years = new Set<number>();
  for (const key of watchedKeys(events)) {
    const year = byKey.get(key)?.summary.year;
    if (typeof year === "number") years.add(year);
  }
  if (years.size === 0) return null;

  const sorted = [...years].sort((a, b) => a - b);
  const decades = [...new Set(sorted.map((year) => Math.floor(year / 10) * 10))];

  return {
    decades,
    oldestYear: sorted[0],
    newestYear: sorted[sorted.length - 1],
    count: decades.length,
  };
}

/** Distinct titles touched by these events. Deduped, because 33 episodes of
 *  one show is one title for genre and decade purposes — otherwise a single
 *  binge would drown out everything else watched all year. */
function watchedKeys(events: readonly WatchEvent[]): Set<string> {
  return new Set(events.map((event) => event.t));
}

/* ---------------------------------------------------------------------------
 * Genre shape
 * ------------------------------------------------------------------------ */

function computeGenres(
  events: readonly WatchEvent[],
  byKey: ReadonlyMap<string, TrackingEntry>,
): GenreShape | null {
  const counts = new Map<string, number>();
  let tags = 0;

  for (const key of watchedKeys(events)) {
    for (const genre of byKey.get(key)?.summary.genres ?? []) {
      counts.set(genre.name, (counts.get(genre.name) ?? 0) + 1);
      tags += 1;
    }
  }
  if (tags === 0) return null;

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [topGenre, topCount] = ranked[0];
  const share = topCount / tags;

  return {
    topGenre,
    topGenreShare: share,
    distinctGenres: ranked.length,
    persona:
      share >= SPECIALIST_SHARE
        ? "specialist"
        : ranked.length >= OMNIVORE_GENRES
          ? "omnivore"
          : "balanced",
  };
}

/* ---------------------------------------------------------------------------
 * Top show
 * ------------------------------------------------------------------------ */

function computeTopShow(
  events: readonly WatchEvent[],
  byKey: ReadonlyMap<string, TrackingEntry>,
): TopShow | null {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.k !== WATCH_KIND.EPISODE) continue;
    counts.set(event.t, (counts.get(event.t) ?? 0) + 1);
  }
  if (counts.size === 0) return null;

  const [key, episodes] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const entry = byKey.get(key);
  // An untracked title still counts, but has no name to show. Falling back to
  // the raw id would look like a bug; better to show no card.
  if (!entry) return null;

  return { id: entry.id, name: entry.summary.name, episodes };
}

/* ---------------------------------------------------------------------------
 * You vs the crowd — taste, not volume
 * ------------------------------------------------------------------------ */

/**
 * ⚠️ Reads `score` ONLY. `RatingEntry.note` is private, local, and must never
 * be read here — this data ends up on a shareable image.
 */
function computeCritics(
  events: readonly WatchEvent[],
  byKey: ReadonlyMap<string, TrackingEntry>,
  ratings: readonly RatingEntry[],
): CriticVerdict | null {
  const watched = watchedKeys(events);
  const deltas: CriticDelta[] = [];

  for (const rating of ratings) {
    const key = keyOf(rating);
    // Only titles watched IN RANGE — otherwise this is a lifetime stat
    // wearing a 12-month label.
    if (!watched.has(key)) continue;
    if (rating.score === null) continue;

    // An untracked title has no crowd score AND no name to show, so it is
    // dropped for both reasons at once.
    const entry = byKey.get(key);
    if (!entry) continue;

    // Same fairness discipline as the "Contrarian" badge and the stats page:
    // a title counts only if BOTH scores exist, so the averages are always
    // over the identical set rather than two mismatched populations.
    const crowdRaw = entry.summary.rating;
    if (typeof crowdRaw !== "number") continue;

    const crowd = Math.round(crowdRaw * 10); // TMDB is 0–10; ours is 0–100.
    deltas.push({
      id: rating.id,
      name: entry.summary.name,
      you: rating.score,
      crowd,
      delta: rating.score - crowd,
    });
  }

  if (deltas.length < CRITIC_MIN_SAMPLE) return null;

  deltas.sort((a, b) => a.delta - b.delta);
  const yourAverage = mean(deltas.map((d) => d.you));
  const crowdAverage = mean(deltas.map((d) => d.crowd));
  const gap = yourAverage - crowdAverage;

  const persona = gap <= -5 ? "tough" : gap >= 5 ? "generous" : "aligned";
  // The title bucking the trend, which is the line worth sharing. For a tough
  // critic that is where they were kindest; for a generous one, harshest.
  const outlier =
    persona === "tough"
      ? deltas[deltas.length - 1]
      : persona === "generous"
        ? deltas[0]
        : null;

  return {
    deltas,
    yourAverage: Math.round(yourAverage * 10) / 10,
    crowdAverage: Math.round(crowdAverage * 10) / 10,
    gap: Math.round(gap * 10) / 10,
    // Only meaningful if it actually bucks the trend, rather than merely
    // being the least extreme member of a uniform set.
    outlier: outlier && Math.sign(outlier.delta) !== Math.sign(gap) ? outlier : null,
    persona,
  };
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/* ---------------------------------------------------------------------------
 * Rhythm
 * ------------------------------------------------------------------------ */

/**
 * Peak hour and weekday, over TIMED, NON-BULK events only.
 *
 * A bulk mark stamps every episode in the batch with the minute of the click,
 * so including them reports when the user did admin. Measured on real data: a
 * 39-event log where 33 were one "mark season watched" claimed a 4am peak
 * built from 35 events; excluding bulk, that hour held 2.
 *
 * Returns null below `RHYTHM_MIN_SAMPLE` rather than reporting a peak drawn
 * from three events — the card is simply not shown.
 */
function computeRhythm(entries: readonly [DayKey, WatchLogDay][]): Rhythm | null {
  const hours = new Array<number>(24).fill(0);
  const weekdays = new Array<number>(7).fill(0);
  let sampleSize = 0;
  let excluded = 0;

  for (const [day, events] of entries) {
    const [year, month, date] = day.split("-").map(Number);
    const weekday = new Date(year, month - 1, date).getDay();

    for (const event of events) {
      if (event.m === undefined || event.b === 1) {
        excluded += 1;
        continue;
      }
      hours[Math.floor(event.m / 60)] += 1;
      weekdays[weekday] += 1;
      sampleSize += 1;
    }
  }

  if (sampleSize < RHYTHM_MIN_SAMPLE) return null;

  return {
    peakHour: hours.indexOf(Math.max(...hours)),
    peakWeekday: weekdays.indexOf(Math.max(...weekdays)),
    sampleSize,
    excluded,
  };
}

/* ---------------------------------------------------------------------------
 * Odds and ends
 * ------------------------------------------------------------------------ */

function computeFirstWatch(
  entries: readonly [DayKey, WatchLogDay][],
  byKey: ReadonlyMap<string, TrackingEntry>,
): FirstWatch | null {
  for (const [day, events] of entries) {
    for (const event of events) {
      const entry = byKey.get(event.t);
      if (!entry) continue;
      return { name: entry.summary.name, day, mediaType: entry.mediaType };
    }
  }
  return null;
}

function computeProvenance(events: readonly WatchEvent[]): Provenance {
  let timed = 0;
  let bulk = 0;
  for (const event of events) {
    if (event.m !== undefined) timed += 1;
    if (event.b === 1) bulk += 1;
  }
  return {
    totalEvents: events.length,
    timedEvents: timed,
    bulkEvents: bulk,
    // Untimed events dominating is the signature of a large CSV import, and
    // the case where "you watched this much" needs rephrasing to "this much
    // was added to your library".
    importDominated: events.length > 0 && timed / events.length < 0.5,
  };
}

function computeLongestStreak(days: readonly DayKey[]): number {
  let longest = 0;
  let run = 0;
  let previous: DayKey | null = null;

  for (const day of days) {
    run = previous !== null && dayDifference(previous, day) === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
    previous = day;
  }
  return longest;
}

function computeBusiestMonth(entries: readonly [DayKey, WatchLogDay][]): string | null {
  const counts = new Map<string, number>();
  for (const [day, events] of entries) {
    const month = day.slice(0, 7);
    counts.set(month, (counts.get(month) ?? 0) + events.length);
  }
  if (counts.size === 0) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}
