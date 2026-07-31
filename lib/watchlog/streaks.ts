import { activeDays } from "./queries";
import { dayDifference, localDayKey, type DayKey } from "./types";

/**
 * Freeze-aware streak status — Phase 5 Step 3.
 *
 * ============================================================================
 * WHY THIS IS A SEPARATE MODULE FROM queries.ts's currentStreak/longestStreak
 * ============================================================================
 * Those two functions are untouched and still correct: a streak with no
 * concept of forgiveness. This module answers a genuinely different question
 * ("what does the streak look like once a small number of missed-day
 * forgivenesses are allowed to bridge a gap") and both are worth keeping —
 * the raw functions remain the honest lower-level primitive.
 *
 * ============================================================================
 * WHY FREEZES ARE COMPUTED, NOT STORED
 * ============================================================================
 * Same discipline as lib/xp: `freezesAvailable` is not a balance sitting in
 * storage that gets decremented on write. It is re-derived, every time, from
 * nothing but the log's day keys — the same `keys()`-only read the raw streak
 * functions already use. Nothing new is persisted. This is also what makes
 * the backdating edge case free: see the note on `computeStreakStatus` below.
 *
 * ============================================================================
 * THE MECHANIC
 * ============================================================================
 * - Every FREEZE_EARN_INTERVAL_DAYS of *lifetime* active days (not "days
 *   within an unbroken streak" — engagement should keep earning freezes even
 *   right after a streak resets, or earning them would require the very
 *   thing they exist to protect against), bank one freeze, up to
 *   MAX_BANKED_FREEZES.
 * - A freeze bridges exactly ONE missed calendar day. A gap of two or more
 *   consecutive missed days breaks the streak regardless of freezes banked —
 *   this is a forgiveness for an off day, not a vacation pass.
 * - Freezes are spent greedily, in chronological order, the moment a
 *   bridgeable gap is encountered while walking the log.
 */

export const FREEZE_EARN_INTERVAL_DAYS = 7;
export const MAX_BANKED_FREEZES = 3;

export interface StreakStatus {
  /** Length of the streak as of right now, freeze-bridged gaps included. */
  currentStreak: number;
  /** Longest freeze-bridged run ever recorded. */
  longestStreak: number;
  /** Freezes banked and not yet spent, as of the last logged day — does NOT
   *  subtract one for `freezeActive` below; see its doc comment. */
  freezesAvailable: number;
  /** True when a freeze is presently covering an unlogged gap — i.e. the log's
   *  last active day was two days ago and a freeze was available to bridge
   *  it. Kept separate from `freezesAvailable` rather than pre-subtracted,
   *  because this usage is provisional: if the user logs something today,
   *  today's entry simply becomes the next day walked and the historical
   *  loop spends the freeze for real; if the user logs nothing today either,
   *  the gap grows to two full missed days and no freeze can cover that —
   *  there is nothing to "give back" in either case. */
  freezeActive: boolean;
}

const EMPTY_STATUS: StreakStatus = {
  currentStreak: 0,
  longestStreak: 0,
  freezesAvailable: 0,
  freezeActive: false,
};

/**
 * Freeze-aware current + longest streak, in one pass over the log's day keys.
 *
 * ============================================================================
 * BACKDATING CAN ONLY HELP, NEVER RETROACTIVELY BREAK A STREAK
 * ============================================================================
 * This is a fresh, stateless walk over the FULL sorted set of active days
 * every time it runs — never incremental, never keyed off insertion order.
 * That is what makes backdating safe by construction rather than by a special
 * case: inserting an additional active day into the set can only ever narrow
 * an existing gap (2 days apart -> 1) or leave gaps elsewhere unchanged. A
 * narrower gap can only keep a run the same length or extend it, and can only
 * keep freeze spend the same or free one up (a gap that used to need a freeze
 * to bridge may no longer need one at all). There is no path through this
 * loop where adding a day lowers `currentStreak`, `longestStreak`, or
 * `freezesAvailable`.
 */
export function computeStreakStatus(
  keys: Iterable<string>,
  today: DayKey = localDayKey(),
): StreakStatus {
  const days = activeDays(keys);
  if (days.length === 0) return EMPTY_STATUS;

  let freezes = 0;
  let streak = 0;
  let longest = 0;
  let activeCount = 0;
  let previous: DayKey | null = null;

  for (const day of days) {
    activeCount += 1;

    if (previous === null) {
      streak = 1;
    } else {
      const gap = dayDifference(previous, day);
      if (gap === 1) {
        streak += 1;
      } else if (gap === 2 && freezes > 0) {
        freezes -= 1;
        streak += 1;
      } else {
        streak = 1;
      }
    }

    if (activeCount % FREEZE_EARN_INTERVAL_DAYS === 0 && freezes < MAX_BANKED_FREEZES) {
      freezes += 1;
    }

    if (streak > longest) longest = streak;
    previous = day;
  }

  // `previous` is the last logged day. Whether that run is still "current"
  // depends on how far today has drifted from it — mirrors currentStreak's
  // "alive but not yet extended" rule, extended by one more day when a freeze
  // is available to cover it.
  const lastActive = previous as DayKey;
  const gapToToday = dayDifference(lastActive, today);

  if (gapToToday <= 1) {
    return { currentStreak: streak, longestStreak: longest, freezesAvailable: freezes, freezeActive: false };
  }
  if (gapToToday === 2 && freezes > 0) {
    return { currentStreak: streak, longestStreak: longest, freezesAvailable: freezes, freezeActive: true };
  }
  return { currentStreak: 0, longestStreak: longest, freezesAvailable: freezes, freezeActive: false };
}
