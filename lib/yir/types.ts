import type { DayKey } from "@/lib/watchlog";

/**
 * Year in Review — Phase 8 Step 1.
 *
 * ============================================================================
 * A ROLLING 12 MONTHS, NOT A CALENDAR YEAR
 * ============================================================================
 * Decided deliberately, and the label must say so everywhere it appears —
 * "your last 12 months", with the real date range visible — so nobody reads
 * it as a calendar-year summary.
 *
 * Three reasons, in the order they mattered:
 *
 *   1. A feature that is empty for four months of the year is one nobody
 *      builds a habit around. Rolling always has content.
 *   2. December-Wrapped works because Spotify already has your whole year. A
 *      new tracker does not: most year-one users would open a calendar card,
 *      find it near-empty, and conclude the feature is broken.
 *   3. It is honest about what the data actually covers, rather than claiming
 *      a year boundary the log does not respect. The log has no backfill —
 *      it starts the day logging started — so a January-to-December frame
 *      would routinely describe a period that mostly predates the data.
 */

export interface DateRange {
  /** Inclusive. */
  from: DayKey;
  /** Inclusive — normally today. */
  to: DayKey;
}

export interface YirTally {
  movies: number;
  episodes: number;
  /** Coarse "whole show marked watched" events. Counted apart from episodes
   *  because one of these is not one episode. */
  shows: number;
  /**
   * Approximate, and labelled that way in the UI. Movie runtimes are only
   * known for entries tracked after Phase 5 Step 2 (older ones are null), and
   * per-episode runtime is not stored anywhere, so episodes use a flat rate.
   * Measured on real data: 7 of 12 movies had no runtime at all.
   */
  approxHours: number;
  /** How much of `approxHours` rests on a real runtime rather than the flat
   *  estimate, 0–1. Below `RUNTIME_CONFIDENCE_FLOOR` the hours line is
   *  suppressed rather than shown with a misleading precision. */
  runtimeConfidence: number;
}

export interface DecadeReach {
  /** Decade start years, ascending, e.g. [1970, 1980, 2000]. */
  decades: number[];
  oldestYear: number;
  newestYear: number;
  /** Distinct decades touched — the headline number. */
  count: number;
}

export interface GenreShape {
  topGenre: string;
  topGenreShare: number;
  distinctGenres: number;
  /**
   * The card's actual content is this LABEL, not a bar chart. "Omnivore" and
   * "a Drama person" are both shareable; a ranked list of twelve genres with
   * counts of 1 and 2 is not.
   */
  persona: "omnivore" | "specialist" | "balanced";
}

export interface TopShow {
  id: string;
  name: string;
  episodes: number;
}

export interface CriticDelta {
  id: string;
  name: string;
  /** The user's own score, 0–100. */
  you: number;
  /** TMDB's community score, rescaled to 0–100 so the two are comparable. */
  crowd: number;
  /** `you - crowd`. Negative means harsher than the crowd. */
  delta: number;
}

export interface CriticVerdict {
  /** Sorted most-negative first, so `[0]` is the biggest disagreement. */
  deltas: CriticDelta[];
  yourAverage: number;
  crowdAverage: number;
  /** `yourAverage - crowdAverage`. */
  gap: number;
  /**
   * The one title bucking the trend — your highest delta when you are
   * generally harsher, or lowest when generally kinder. Null when there is no
   * meaningful outlier. This is the line people actually share.
   */
  outlier: CriticDelta | null;
  persona: "tough" | "generous" | "aligned";
}

export interface Rhythm {
  /** 0–23. */
  peakHour: number;
  /** 0 = Sunday. */
  peakWeekday: number;
  /** Events this is computed over — timed AND non-bulk only. */
  sampleSize: number;
  /** Events in range that could NOT contribute, because they were bulk marks
   *  or carried no time. Shown to the user when it dominates. */
  excluded: number;
}

export interface FirstWatch {
  name: string;
  day: DayKey;
  mediaType: "movie" | "tv";
}

/**
 * Where the range's events came from.
 *
 * `m` is set on every event written live (`lib/watchlog/index.ts` always
 * passes `localMinuteOfDay`) and omitted by IMDb and Letterboxd imports,
 * which record a calendar date and no clock time. So a missing `m` reliably
 * means "time unknown", which is exactly what the rhythm card needs to know.
 *
 * It is NOT a complete import detector — a Trakt import supplies a real
 * timestamp and therefore a real `m` — so this is named for what it actually
 * measures rather than for what it approximates.
 */
export interface Provenance {
  totalEvents: number;
  /** Events carrying a real clock time. */
  timedEvents: number;
  /** Events from bulk actions. */
  bulkEvents: number;
  /** True when untimed events dominate — the signature of a large CSV import,
   *  and the case where "you watched this much this year" needs rephrasing to
   *  "this much was added to your library". */
  importDominated: boolean;
}

export interface YirData {
  range: DateRange;
  tally: YirTally;
  decades: DecadeReach | null;
  genres: GenreShape | null;
  topShow: TopShow | null;
  critics: CriticVerdict | null;
  rhythm: Rhythm | null;
  firstWatch: FirstWatch | null;
  provenance: Provenance;
  /** Days with at least one event, within range. */
  activeDays: number;
  /** Longest run of consecutive active days, within range. */
  longestStreak: number;
  /** The busiest month, as "YYYY-MM". Null below a usable sample. */
  busiestMonth: string | null;
}

/**
 * A card the deck can show. Selected by DATA SUFFICIENCY rather than a fixed
 * template — see `selectCards`.
 */
export type YirCardId =
  | "opener"
  | "tally"
  | "decades"
  | "genres"
  | "topShow"
  | "rhythm"
  | "critics"
  | "closer";
