import type { MediaType } from "@/lib/content/types";

/**
 * The append-only watch-date log.
 *
 * CLAUDE.md has said since Phase 3 that watch DATES belong in a separate store
 * from progress, because they are a different question with a different shape
 * and access pattern:
 *
 *   | | progress (lib/tracking) | history (here) |
 *   |---|---|---|
 *   | question | "have I seen S3E7?" | "what did I watch in June?" |
 *   | shape | ranges, keyed by season | events, keyed by DAY |
 *   | mutability | edited freely | append-only |
 *
 * ============================================================================
 * WHY ONE RECORD PER LOCAL CALENDAR DAY
 * ============================================================================
 * `Store.keys()` strips the namespace prefix and returns the bare key. With a
 * day-keyed layout that means **the set of days you watched something is
 * `keys()` alone — no JSON parsing at all.** Streak math, the headline Phase 5
 * feature, reduces to listing keys and sorting strings. Nothing else in this
 * design bought as much.
 *
 * It is also a large storage win. Measured at 3 episodes/day for two years
 * (~2,000 events):
 *
 *   one key per event, ISO timestamp     ~310 KB
 *   day-bucketed (this)                  ~128 KB
 *   day-bucketed with tuple events        ~64 KB
 *
 * The tuple form was deliberately NOT taken: it halves a number that is
 * already ~2.5% of the localStorage budget, and it costs real legibility in
 * validation and any future migration. The episode-range encoding in
 * lib/tracking earned its opacity with a measured 65x win; this would not.
 */

/* ---------------------------------------------------------------------------
 * Calendar days
 * ------------------------------------------------------------------------ */

/**
 * A day key: "YYYY-MM-DD" in the **device's local timezone at the moment the
 * event was recorded**, frozen forever.
 *
 * ============================================================================
 * WHY LOCAL-AT-WRITE-TIME AND NOT A UTC INSTANT
 * ============================================================================
 * The alternative — store an instant, derive the day at read time — is
 * actively wrong for this data. Watch something at 8am Tuesday in Tokyo, fly
 * to Los Angeles, and that same instant now derives as Monday afternoon: the
 * user's streak history silently rewrites itself because they travelled. The
 * day something was watched is a fact about where the user *was*, not where
 * they are now.
 *
 * This matches the precedent in lib/utils/dates.ts, which does plain string
 * comparison on air dates because they are "a calendar date, not an instant".
 *
 * Accepted consequence: crossing timezones can produce two day keys that felt
 * like one day, or skip a date entirely. That is the honest result of local
 * dates and is rare enough to leave alone.
 */
export type DayKey = string;

const DAY_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Today (or any Date) as a LOCAL day key.
 *
 * Deliberately NOT `toISOString().slice(0, 10)`, which is the pattern used in
 * lib/utils/dates.ts. That returns the **UTC** date: a user at UTC-8 watching
 * at 6pm local would have the event filed under *tomorrow*, quietly shifting
 * most evening viewing into the wrong day and breaking streaks across every
 * western timezone. `getFullYear`/`getMonth`/`getDate` are local-time
 * accessors and are the whole point here.
 */
export function localDayKey(date: Date = new Date()): DayKey {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Local minutes since midnight, 0–1439. Pairs with `localDayKey` to
 *  reconstruct local wall-clock time without ever storing an instant. */
export function localMinuteOfDay(date: Date = new Date()): number {
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * Well-formed AND a real calendar date. The round-trip check is what rejects
 * "2026-02-30", which the regex alone would happily accept.
 */
export function isDayKey(value: unknown): value is DayKey {
  if (typeof value !== "string") return false;
  const match = DAY_KEY_PATTERN.exec(value);
  if (!match) return false;
  const [, year, month, day] = match;
  // Constructed in LOCAL time on purpose — `new Date("2026-07-30")` parses as
  // UTC midnight, which can read back as the previous day west of Greenwich.
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  return localDayKey(date) === value;
}

/** Shifts a day key by whole calendar days. `setDate` normalizes month and
 *  year rollover, and reading Y/M/D straight back out keeps this correct
 *  across DST transitions. */
export function shiftDay(key: DayKey, deltaDays: number): DayKey {
  const match = DAY_KEY_PATTERN.exec(key);
  if (!match) return key;
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  date.setDate(date.getDate() + deltaDays);
  return localDayKey(date);
}

export const previousDay = (key: DayKey): DayKey => shiftDay(key, -1);
export const nextDay = (key: DayKey): DayKey => shiftDay(key, 1);

/**
 * Whole calendar days from `from` to `to` (positive if `to` is later).
 *
 * Anchored through `Date.UTC` on purpose, even though day keys are local
 * dates — that is what makes this DST-safe. Constructing two LOCAL dates and
 * subtracting milliseconds would be off by one across a spring-forward or
 * fall-back boundary (a 23- or 25-hour day is not 86,400,000ms). `Date.UTC`
 * has no DST at all, and both sides go through the identical Y/M/D -> UTC
 * conversion, so the local offset cancels out of the subtraction rather than
 * corrupting it.
 */
export function dayDifference(from: DayKey, to: DayKey): number {
  const a = DAY_KEY_PATTERN.exec(from);
  const b = DAY_KEY_PATTERN.exec(to);
  if (!a || !b) return NaN;
  const fromUtc = Date.UTC(Number(a[1]), Number(a[2]) - 1, Number(a[3]));
  const toUtc = Date.UTC(Number(b[1]), Number(b[2]) - 1, Number(b[3]));
  return Math.round((toUtc - fromUtc) / 86_400_000);
}

/** The 4-digit year portion. Year-in-Review filters on this via the key
 *  alone, without reading a single record's value. */
export function yearOf(key: DayKey): string {
  return key.slice(0, 4);
}

/* ---------------------------------------------------------------------------
 * Events
 * ------------------------------------------------------------------------ */

/**
 * What kind of thing was watched. Stored as one character to keep the record
 * small; never write these literals at a call site — use the named constants.
 *
 * - `EPISODE` — one TV episode. Carries `s` and `e`.
 * - `MOVIE`   — a film.
 * - `TITLE`   — a whole show marked watched at the title level, from the
 *               coarse "Watched" button. Episodes genuinely unknown: that path
 *               sets `status` with empty ranges (see `reconcileCoarseWatched`).
 *               A third kind rather than a silent gap for a common action.
 */
export const WATCH_KIND = {
  EPISODE: "e",
  MOVIE: "m",
  TITLE: "t",
} as const;

export type WatchKind = (typeof WATCH_KIND)[keyof typeof WATCH_KIND];

const KINDS: readonly WatchKind[] = [
  WATCH_KIND.EPISODE,
  WATCH_KIND.MOVIE,
  WATCH_KIND.TITLE,
];

export interface WatchEvent {
  /**
   * Sync id (Phase 6 Step 5). **Optional, and its absence is meaningful.**
   *
   * Present on events recorded while signed in: a v4 UUID minted at write
   * time and persisted here, so the id exists before the row ever reaches the
   * outbox and a retried push re-sends the same id.
   *
   * Absent on every event recorded before the account existed. Those get a
   * DETERMINISTIC v5 derived from `(userId, dayKey, array index)` at merge
   * time — see `lib/sync/uuid.ts` — which is what makes a retried merge an
   * `ON CONFLICT DO NOTHING` no-op instead of a second copy of the user's
   * entire history.
   *
   * The merge then **writes that id back here**. Skipping the write-back
   * duplicated the whole log on the merge's second run: the union step matches
   * local events against server rows by id, and a local event with no id looks
   * like a different event from the row it created. Once written, nothing
   * depends on array indices staying stable any more.
   *
   * Added without a store migration on purpose: `isWatchEvent` does not reject
   * unknown keys, so old records remain valid unchanged and there is no
   * rewrite pass over the log. That matters more here than elsewhere — this
   * store is append-only, and a migration that rewrote day records would be
   * the one thing capable of shifting the array indices the v5 ids depend on.
   */
  id?: string;
  /** See WATCH_KIND. */
  k: WatchKind;
  /** `${mediaType}:${id}` — e.g. "tv:1396". */
  t: string;
  /** Season number. Episode events only. */
  s?: number;
  /** Episode number. Episode events only. */
  e?: number;
  /**
   * Local minutes since midnight, 0–1439. Always written for events recorded
   * live; **omitted when genuinely unknown**, which is what a Phase 7 CSV
   * import would produce. Kept because it is unrecoverable later and it is
   * what lets Year in Review say "you watch most on Sunday nights".
   */
  m?: number;
  /**
   * Present (as 1) when this event came from a BULK action — "mark season
   * watched", "binge to here" — rather than one deliberate mark.
   *
   * Worth being precise about why this exists, because the obvious worry is
   * the wrong one: N events on one day does NOT break streak math, since
   * streaks count distinct days and 13 events today is still one day. The
   * real problem is honesty. Marking a season watched today does not mean the
   * user *watched* 13 episodes today — they almost certainly watched them
   * over weeks and are only now recording it. Logging that flat would invent
   * a binge day. Streaks can still credit the day (real engagement did
   * happen); Year in Review can decline to call it the user's biggest session.
   */
  b?: 1;
}

/** A day's events, in the order they were appended. */
export type WatchLogDay = WatchEvent[];

/** Same `${mediaType}:${id}` shape as `entryKey`/`ratingKey`, kept as an
 *  independent copy rather than imported — lib/tracking imports THIS module,
 *  so importing back would be a cycle. Same precedent as `ratingKey`. */
export function watchTitleKey(mediaType: MediaType, id: string): string {
  return `${mediaType}:${id}`;
}

function isOptionalNonNegativeInt(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isInteger(value) && value >= 0);
}

export function isWatchEvent(value: unknown): value is WatchEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;

  if (!KINDS.includes(event.k as WatchKind)) return false;
  if (typeof event.t !== "string" || event.t.length === 0) return false;
  if (event.id !== undefined && (typeof event.id !== "string" || event.id.length === 0)) {
    return false;
  }
  if (!isOptionalNonNegativeInt(event.s)) return false;
  if (!isOptionalNonNegativeInt(event.e)) return false;
  if (event.b !== undefined && event.b !== 1) return false;
  if (
    event.m !== undefined &&
    (typeof event.m !== "number" || !Number.isInteger(event.m) || event.m < 0 || event.m > 1439)
  ) {
    return false;
  }

  // An episode event without its coordinates can't be attributed to anything.
  if (event.k === WATCH_KIND.EPISODE && (event.s === undefined || event.e === undefined)) {
    return false;
  }
  return true;
}

export function isWatchLogDay(value: unknown): value is WatchLogDay {
  return Array.isArray(value) && value.every(isWatchEvent);
}
