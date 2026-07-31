import { describe, expect, it } from "vitest";

import { dayDifference } from "./types";
import {
  computeStreakStatus,
  FREEZE_EARN_INTERVAL_DAYS,
  MAX_BANKED_FREEZES,
} from "./streaks";

describe("dayDifference", () => {
  it("is 0 for the same day", () => {
    expect(dayDifference("2026-07-30", "2026-07-30")).toBe(0);
  });

  it("is 1 for consecutive days", () => {
    expect(dayDifference("2026-07-30", "2026-07-31")).toBe(1);
  });

  it("crosses a month boundary", () => {
    expect(dayDifference("2026-07-31", "2026-08-01")).toBe(1);
  });

  it("crosses a year boundary", () => {
    expect(dayDifference("2026-12-31", "2027-01-01")).toBe(1);
  });

  it("is negative when `to` is earlier than `from`", () => {
    expect(dayDifference("2026-07-31", "2026-07-30")).toBe(-1);
  });

  it("is exactly 1 across a US spring-forward transition (2026-03-08)", () => {
    // The local clock skips an hour that day (23-hour day). A naive
    // local-Date-subtraction would risk landing on 0.958 days, not 1.
    expect(dayDifference("2026-03-07", "2026-03-08")).toBe(1);
  });

  it("is exactly 1 across a US fall-back transition (2026-11-01)", () => {
    // 25-hour local day, opposite direction of the same risk.
    expect(dayDifference("2026-10-31", "2026-11-01")).toBe(1);
  });

  it("handles leap day correctly", () => {
    expect(dayDifference("2028-02-28", "2028-02-29")).toBe(1);
    expect(dayDifference("2028-02-29", "2028-03-01")).toBe(1);
  });
});

describe("computeStreakStatus — no history", () => {
  it("is all zeros for an empty log", () => {
    expect(computeStreakStatus([], "2026-07-30")).toEqual({
      currentStreak: 0,
      longestStreak: 0,
      freezesAvailable: 0,
      freezeActive: false,
    });
  });
});

describe("computeStreakStatus — plain consecutive runs (no freezes involved)", () => {
  it("counts a simple unbroken run", () => {
    const days = ["2026-07-28", "2026-07-29", "2026-07-30"];
    const status = computeStreakStatus(days, "2026-07-30");
    expect(status.currentStreak).toBe(3);
    expect(status.longestStreak).toBe(3);
  });

  it("multiple events collapse into the same day (Set-dedup inherited from activeDays)", () => {
    const keys = ["2026-07-30", "2026-07-30", "2026-07-29"];
    expect(computeStreakStatus(keys, "2026-07-30").currentStreak).toBe(2);
  });

  it("is alive but not yet extended when today has no entry but yesterday does", () => {
    const days = ["2026-07-28", "2026-07-29"];
    const status = computeStreakStatus(days, "2026-07-30");
    expect(status.currentStreak).toBe(2);
    expect(status.freezeActive).toBe(false);
  });

  it("breaks when the gap is 3+ days, even before any freeze logic applies", () => {
    const days = ["2026-07-20"];
    expect(computeStreakStatus(days, "2026-07-30").currentStreak).toBe(0);
  });
});

describe("computeStreakStatus — earning freezes", () => {
  it("earns nothing before the interval is reached", () => {
    const days = Array.from({ length: FREEZE_EARN_INTERVAL_DAYS - 1 }, (_, i) =>
      shift("2026-01-01", i),
    );
    const status = computeStreakStatus(days, days[days.length - 1]);
    expect(status.freezesAvailable).toBe(0);
  });

  it("earns exactly one freeze at the interval", () => {
    const days = Array.from({ length: FREEZE_EARN_INTERVAL_DAYS }, (_, i) =>
      shift("2026-01-01", i),
    );
    const status = computeStreakStatus(days, days[days.length - 1]);
    expect(status.freezesAvailable).toBe(1);
  });

  it("caps banked freezes at MAX_BANKED_FREEZES even over a very long unbroken run", () => {
    const length = FREEZE_EARN_INTERVAL_DAYS * (MAX_BANKED_FREEZES + 5);
    const days = Array.from({ length }, (_, i) => shift("2026-01-01", i));
    const status = computeStreakStatus(days, days[days.length - 1]);
    expect(status.freezesAvailable).toBe(MAX_BANKED_FREEZES);
  });

  it("keeps earning after a hard break — earning is lifetime activity, not streak length", () => {
    // Two separate 7-day runs with a hard (unbridgeable) gap between them.
    const first = Array.from({ length: FREEZE_EARN_INTERVAL_DAYS }, (_, i) => shift("2026-01-01", i));
    const secondStart = shift(first[first.length - 1], 10); // well past any freeze's reach
    const second = Array.from({ length: FREEZE_EARN_INTERVAL_DAYS }, (_, i) => shift(secondStart, i));
    const days = [...first, ...second];
    const status = computeStreakStatus(days, days[days.length - 1]);
    // 14 total active days at interval 7 -> 2 freezes earned, well under the cap.
    expect(status.freezesAvailable).toBe(2);
  });
});

describe("computeStreakStatus — spending freezes to bridge a single missed day", () => {
  it("bridges a lone missed day when a freeze is banked, treating the run as continuous", () => {
    // 7 consecutive days earns 1 freeze on day 7, then day 9 is logged
    // (day 8 missed) — the freeze should bridge it.
    const run = Array.from({ length: FREEZE_EARN_INTERVAL_DAYS }, (_, i) => shift("2026-01-01", i));
    const afterGap = shift(run[run.length - 1], 2); // one day skipped
    const days = [...run, afterGap];

    const status = computeStreakStatus(days, afterGap);
    expect(status.currentStreak).toBe(run.length + 1); // bridged, not reset to 1
    expect(status.freezesAvailable).toBe(0); // the one earned freeze was spent
  });

  it("does NOT bridge a lone missed day when no freeze is banked", () => {
    const days = ["2026-07-25", "2026-07-26", "2026-07-28"]; // day 27 missed, no freeze earned yet
    const status = computeStreakStatus(days, "2026-07-28");
    expect(status.currentStreak).toBe(1); // reset
  });

  it("never bridges a gap of two or more full missed days, even with freezes banked", () => {
    const run = Array.from({ length: FREEZE_EARN_INTERVAL_DAYS }, (_, i) => shift("2026-01-01", i));
    const afterBigGap = shift(run[run.length - 1], 4); // 3 days skipped
    const days = [...run, afterBigGap];

    const status = computeStreakStatus(days, afterBigGap);
    expect(status.currentStreak).toBe(1); // reset, not bridged
    expect(status.freezesAvailable).toBe(1); // untouched — nothing eligible to spend it on
  });

  it("spends freezes greedily and in order across multiple gaps", () => {
    // Earn 1 freeze at day 7, hit a bridgeable gap at day 9 (spends it),
    // keep going to day 14 more active days to earn a second, hit another gap.
    const firstRun = Array.from({ length: FREEZE_EARN_INTERVAL_DAYS }, (_, i) => shift("2026-01-01", i));
    const bridge1 = shift(firstRun[firstRun.length - 1], 2);
    const secondRun = Array.from({ length: FREEZE_EARN_INTERVAL_DAYS - 1 }, (_, i) => shift(bridge1, i + 1));
    const bridge2 = shift(secondRun[secondRun.length - 1], 2);

    const days = [...firstRun, bridge1, ...secondRun, bridge2];
    const status = computeStreakStatus(days, bridge2);

    expect(status.currentStreak).toBe(days.length); // every gap bridged
    expect(status.freezesAvailable).toBe(0); // both spent, none left over
  });
});

describe("computeStreakStatus — the live gap-to-today case (freezeActive)", () => {
  it("reports the streak alive with freezeActive when yesterday was missed but a freeze covers it", () => {
    const run = Array.from({ length: FREEZE_EARN_INTERVAL_DAYS }, (_, i) => shift("2026-07-01", i));
    const lastActive = run[run.length - 1];
    const today = shift(lastActive, 2); // yesterday (relative to today) was missed, nothing logged today either

    const status = computeStreakStatus(run, today);
    expect(status.currentStreak).toBe(run.length);
    expect(status.freezeActive).toBe(true);
    // Not yet actually spent — this is provisional until confirmed by a
    // future log entry, so the bank still shows it.
    expect(status.freezesAvailable).toBe(1);
  });

  it("reports the streak broken when yesterday was missed and no freeze is available", () => {
    const days = ["2026-07-01", "2026-07-02"]; // no freeze earned yet
    const today = shift(days[days.length - 1], 2);

    const status = computeStreakStatus(days, today);
    expect(status.currentStreak).toBe(0);
    expect(status.freezeActive).toBe(false);
  });

  it("reports the streak broken once two full days have passed with nothing logged, even with a freeze banked", () => {
    const run = Array.from({ length: FREEZE_EARN_INTERVAL_DAYS }, (_, i) => shift("2026-07-01", i));
    const today = shift(run[run.length - 1], 3); // two full missed days, not one

    const status = computeStreakStatus(run, today);
    expect(status.currentStreak).toBe(0);
    expect(status.freezeActive).toBe(false);
    expect(status.freezesAvailable).toBe(1); // preserved, nothing to spend it on
  });
});

describe("computeStreakStatus — a backdated entry can only help, never retroactively break a streak", () => {
  it("inserting a day that fills a gap can only raise or preserve currentStreak/longestStreak/freezesAvailable", () => {
    const scenarios: string[][] = [
      ["2026-07-01", "2026-07-02", "2026-07-04", "2026-07-05"], // gap at 07-03
      ["2026-01-01", "2026-01-08", "2026-01-15"], // sparse, no adjacency at all
      Array.from({ length: FREEZE_EARN_INTERVAL_DAYS }, (_, i) => shift("2026-02-01", i)).concat(
        shift(shift("2026-02-01", FREEZE_EARN_INTERVAL_DAYS - 1), 2),
      ), // a freeze-bridged run
    ];

    for (const before of scenarios) {
      const today = before[before.length - 1];
      const baseline = computeStreakStatus(before, today);

      // Backfill every day strictly between the earliest and latest key that
      // isn't already present, one at a time, and confirm nothing regresses.
      const sorted = [...before].sort();
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      let cursor = first;
      const allPossibleDays: string[] = [];
      while (cursor !== shift(last, 1)) {
        allPossibleDays.push(cursor);
        cursor = shift(cursor, 1);
      }
      const missing = allPossibleDays.filter((d) => !before.includes(d));

      for (const backdated of missing) {
        const after = [...before, backdated];
        const result = computeStreakStatus(after, today);
        expect(result.currentStreak).toBeGreaterThanOrEqual(baseline.currentStreak);
        expect(result.longestStreak).toBeGreaterThanOrEqual(baseline.longestStreak);
        expect(result.freezesAvailable).toBeGreaterThanOrEqual(baseline.freezesAvailable);
      }
    }
  });
});

/** Local helper mirroring shiftDay's semantics, kept independent so this test
 *  file exercises dayDifference/computeStreakStatus without importing the
 *  module under test's own dependencies for its fixtures. */
function shift(day: string, deltaDays: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + deltaDays);
  const yy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}
