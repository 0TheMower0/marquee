import { isDayKey, type DayKey } from "@/lib/watchlog";

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
