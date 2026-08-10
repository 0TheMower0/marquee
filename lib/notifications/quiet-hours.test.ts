import { describe, expect, it } from "vitest";

import {
  formatMinuteOfDay,
  isWithinQuietHours,
  localMinuteOfDayIn,
  parseMinuteOfDay,
  type QuietHours,
} from "./quiet-hours";

/**
 * The whole point of these tests is that they must hold regardless of the
 * machine's own timezone — every instant is constructed in UTC and every
 * expectation is about a named IANA zone. A test that only passes on a
 * developer's laptop would be worse than none, since the real evaluation runs
 * on a server whose zone is almost certainly UTC.
 */

const ISTANBUL = "Europe/Istanbul"; // UTC+3 year-round, no DST since 2016
const LOS_ANGELES = "America/Los_Angeles"; // UTC-8 / UTC-7, observes DST
const TOKYO = "Asia/Tokyo"; // UTC+9, no DST
const KOLKATA = "Asia/Kolkata"; // UTC+5:30 — a half-hour offset

function quiet(overrides: Partial<QuietHours> = {}): QuietHours {
  return { start: 22 * 60, end: 8 * 60, timeZone: ISTANBUL, ...overrides };
}

describe("localMinuteOfDayIn", () => {
  it("converts an instant into the right wall clock for a zone", () => {
    const instant = new Date("2026-08-10T00:00:00Z");
    expect(localMinuteOfDayIn(instant, "UTC")).toBe(0);
    expect(localMinuteOfDayIn(instant, ISTANBUL)).toBe(3 * 60);
    expect(localMinuteOfDayIn(instant, TOKYO)).toBe(9 * 60);
  });

  it("handles midnight as 0, not 1440", () => {
    // `hour12: false` reports midnight as hour "24" in some engines, which
    // would compute 1440 and fall outside every possible window. h23 is why
    // this passes — see the note in quiet-hours.ts.
    expect(localMinuteOfDayIn(new Date("2026-08-10T21:00:00Z"), ISTANBUL)).toBe(0);
  });

  it("handles half-hour offsets", () => {
    expect(localMinuteOfDayIn(new Date("2026-08-10T00:00:00Z"), KOLKATA)).toBe(5 * 60 + 30);
  });

  it("tracks DST rather than a fixed offset", () => {
    // A fixed "-08:00" would be an hour wrong for one of these two. This is
    // the concrete reason the stored value is an IANA name.
    const winter = new Date("2026-01-15T20:00:00Z"); // PST, UTC-8 -> 12:00
    const summer = new Date("2026-07-15T20:00:00Z"); // PDT, UTC-7 -> 13:00
    expect(localMinuteOfDayIn(winter, LOS_ANGELES)).toBe(12 * 60);
    expect(localMinuteOfDayIn(summer, LOS_ANGELES)).toBe(13 * 60);
  });

  it("falls back to UTC for an unknown zone instead of throwing", () => {
    // A retired tz name must not fail one user's delivery forever.
    expect(localMinuteOfDayIn(new Date("2026-08-10T05:00:00Z"), "Mars/Olympus_Mons")).toBe(5 * 60);
  });
});

describe("isWithinQuietHours — the wrapping window is the normal case", () => {
  it("is quiet late at night", () => {
    // 23:30 Istanbul = 20:30 UTC
    expect(isWithinQuietHours(new Date("2026-08-10T20:30:00Z"), quiet())).toBe(true);
  });

  it("is quiet in the early morning", () => {
    // 03:00 Istanbul = 00:00 UTC
    expect(isWithinQuietHours(new Date("2026-08-10T00:00:00Z"), quiet())).toBe(true);
  });

  it("is NOT quiet during the day", () => {
    // 15:00 Istanbul = 12:00 UTC
    expect(isWithinQuietHours(new Date("2026-08-10T12:00:00Z"), quiet())).toBe(false);
  });

  it("treats start as inclusive and end as exclusive", () => {
    // exactly 22:00 Istanbul = 19:00 UTC -> quiet
    expect(isWithinQuietHours(new Date("2026-08-10T19:00:00Z"), quiet())).toBe(true);
    // exactly 08:00 Istanbul = 05:00 UTC -> awake
    expect(isWithinQuietHours(new Date("2026-08-10T05:00:00Z"), quiet())).toBe(false);
  });
});

describe("isWithinQuietHours — non-wrapping and degenerate windows", () => {
  it("handles an ordinary daytime interval", () => {
    const q = quiet({ start: 13 * 60, end: 14 * 60 });
    expect(isWithinQuietHours(new Date("2026-08-10T10:30:00Z"), q)).toBe(true); // 13:30
    expect(isWithinQuietHours(new Date("2026-08-10T11:30:00Z"), q)).toBe(false); // 14:30
  });

  it("treats an EMPTY window as no quiet hours, never as always-quiet", () => {
    // The dangerous misreading: equal endpoints meaning "permanently silent"
    // would stop this user's notifications forever, with no error anywhere.
    const q = quiet({ start: 9 * 60, end: 9 * 60 });
    for (const hour of [0, 6, 9, 12, 18, 23]) {
      const instant = new Date(Date.UTC(2026, 7, 10, hour));
      expect(isWithinQuietHours(instant, q), `hour ${hour}`).toBe(false);
    }
  });
});

describe("isWithinQuietHours — the same instant differs by zone", () => {
  it("is quiet for one user and not another at the identical moment", () => {
    // This is the whole reason a single daily cron run cannot serve everyone,
    // and why the schedule had to become hourly (design doc §3.1).
    const instant = new Date("2026-08-10T03:00:00Z");
    expect(isWithinQuietHours(instant, quiet({ timeZone: ISTANBUL }))).toBe(true); // 06:00
    expect(isWithinQuietHours(instant, quiet({ timeZone: TOKYO }))).toBe(false); // 12:00
  });

  it("follows the user when their zone changes, rather than their old offset", () => {
    // The mirror of lib/watchlog's frozen day key: moving country must change
    // when you are woken. Same instant, same window, different stored zone.
    const instant = new Date("2026-08-10T22:00:00Z");
    expect(isWithinQuietHours(instant, quiet({ timeZone: ISTANBUL }))).toBe(true); // 01:00
    expect(isWithinQuietHours(instant, quiet({ timeZone: LOS_ANGELES }))).toBe(false); // 15:00
  });
});

describe("formatMinuteOfDay / parseMinuteOfDay", () => {
  it("round-trips", () => {
    for (const minute of [0, 1, 480, 1320, 1439]) {
      expect(parseMinuteOfDay(formatMinuteOfDay(minute))).toBe(minute);
    }
  });

  it("formats with leading zeros", () => {
    expect(formatMinuteOfDay(0)).toBe("00:00");
    expect(formatMinuteOfDay(8 * 60)).toBe("08:00");
    expect(formatMinuteOfDay(22 * 60 + 5)).toBe("22:05");
  });

  it("rejects malformed input rather than coercing it", () => {
    // A silently-wrong quiet window is worse than a rejected edit.
    for (const bad of ["", "8:00", "24:00", "22:60", "abc", "22-00", "2200"]) {
      expect(parseMinuteOfDay(bad), bad).toBeNull();
    }
  });
});
