import { isDayKey, localDayKey, localMinuteOfDay, type DayKey } from "@/lib/watchlog";

/**
 * Turning a CSV date cell into a watch-log day key.
 *
 * ============================================================================
 * THE ONE RULE: VALIDATE, NEVER CONVERT
 * ============================================================================
 * Both IMDb and Letterboxd write plain `YYYY-MM-DD` calendar dates with no
 * timezone attached, which is *exactly* what the watch log stores. So this
 * function never constructs a `Date` from the incoming value and re-derives a
 * day from it. Doing so would reintroduce the precise bug
 * `lib/watchlog/types.ts` exists to prevent: `new Date("2019-03-14")` parses
 * as UTC midnight, which reads back as 13 March anywhere west of Greenwich,
 * silently shifting an imported history by one day for most of the Americas.
 *
 * `isDayKey` does construct a local Date, but only to reject impossible
 * calendar dates like `2019-02-30`. That is validation of a string, not
 * conversion of a value — the string that comes out is the string that went
 * in, byte for byte.
 */

/** Leading `YYYY-MM-DD`, optionally followed by a time we discard. Letterboxd
 *  writes bare dates; some third-party re-exports append a time. */
const LEADING_ISO_DATE = /^(\d{4}-\d{2}-\d{2})(?:[T ]|$)/;

/**
 * A validated day key, or null.
 *
 * **Non-ISO formats are deliberately rejected rather than guessed at.**
 * `03/04/2019` is 3 April to most of the world and 4 March in the United
 * States, and nothing in a CSV says which. Guessing would produce a plausible
 * wrong date that lands in the user's streak history and Year in Review
 * looking entirely legitimate — the invisible-wrong-answer failure this whole
 * feature is built to avoid. A null surfaces honestly as "no date" instead.
 */
export function toDayKey(raw: string | null): DayKey | null {
  if (!raw) return null;
  const match = LEADING_ISO_DATE.exec(raw.trim());
  if (!match) return null;
  return isDayKey(match[1]) ? match[1] : null;
}

/** A timestamp, not a date: `2019-03-14T20:15:00Z` or `2019-03-14 20:15:00`.
 *  The time component is REQUIRED — see `instantToLocalMoment`. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

export interface LocalMoment {
  day: DayKey;
  /** Local minutes since midnight, 0–1439 — the `m` field on a watch event. */
  minute: number;
}

/**
 * An INSTANT rendered in this device's local timezone.
 *
 * ============================================================================
 * WHY THIS EXISTS SEPARATELY FROM toDayKey, AND WHY IT REJECTS BARE DATES
 * ============================================================================
 * `toDayKey` above validates and never converts, because IMDb and Letterboxd
 * write bare calendar dates. Trakt writes an instant. Handing an instant to
 * `toDayKey` would take its leading date portion — which is the **UTC** day —
 * and for anyone in the Americas watching in the evening that is
 * systematically tomorrow. It is exactly the failure
 * `lib/watchlog/types.ts` exists to prevent, arriving through a different
 * door.
 *
 * So this converts, deliberately, using the LOCAL accessors inside
 * `localDayKey`. For a user who has not moved since watching, that is exactly
 * right. For one who has, it is off by at most a day for late-evening
 * viewings — which beats being wrong for most evenings everywhere west of
 * Greenwich.
 *
 * **The time component is required, and that is the safety property rather
 * than input validation.** Each of these two functions is WRONG where the
 * other belongs: `new Date("2019-03-14")` parses as UTC midnight and reads
 * back as 13 March anywhere west of Greenwich. Rejecting a bare date here
 * makes that misuse impossible instead of merely documented — a caller with a
 * calendar date gets `null` and has to reach for `toDayKey`, which is the
 * correct tool.
 */
export function instantToLocalMoment(raw: string | null): LocalMoment | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!TIMESTAMP.test(trimmed)) return null;

  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return null;

  // Both values come from ONE parse, so the day and the minute can never
  // describe different instants — which they could if a caller derived them
  // separately and the string were parsed twice.
  return { day: localDayKey(date), minute: localMinuteOfDay(date) };
}
