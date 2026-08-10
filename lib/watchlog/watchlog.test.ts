import { afterEach, describe, expect, it, vi } from "vitest";

import { addedEpisodes } from "./diff";
import {
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
import {
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
  type WatchLogDay,
} from "./types";

afterEach(() => {
  vi.useRealTimers();
});

/* ---------------------------------------------------------------------------
 * Day keys — the timezone-sensitive part
 * ------------------------------------------------------------------------ */

describe("localDayKey", () => {
  it("reports the LOCAL calendar day, whatever the host timezone", () => {
    // A Date built from local components at 23:30 must file under that same
    // local day in every timezone this suite might run in.
    const evening = new Date(2026, 6, 30, 23, 30);
    expect(localDayKey(evening)).toBe("2026-07-30");

    const morning = new Date(2026, 6, 30, 0, 15);
    expect(localDayKey(morning)).toBe("2026-07-30");
  });

  it("diverges from toISOString().slice(0,10) whenever the host has an offset", () => {
    // The actual bug being guarded against: `toISOString().slice(0, 10)` — the
    // pattern lib/utils/dates.ts uses — yields the UTC date, so a user at
    // UTC-8 watching at 18:00 local gets filed under TOMORROW. This asserts
    // the two genuinely disagree at a time of day chosen to straddle the
    // boundary. In a UTC host they cannot disagree, so the comparison is only
    // meaningful (and only made) off UTC.
    const late = new Date(2026, 6, 30, 23, 30);
    const offsetMinutes = late.getTimezoneOffset();

    expect(localDayKey(late)).toBe("2026-07-30");
    if (offsetMinutes !== 0) {
      const utcDay = late.toISOString().slice(0, 10);
      const early = new Date(2026, 6, 30, 0, 30);
      const utcEarly = early.toISOString().slice(0, 10);
      // At least one end of the day must land on a different UTC date.
      expect(utcDay !== "2026-07-30" || utcEarly !== "2026-07-30").toBe(true);
    }
  });

  it("zero-pads month and day", () => {
    expect(localDayKey(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("defaults to now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 14, 12, 0));
    expect(localDayKey()).toBe("2026-03-14");
  });
});

describe("localMinuteOfDay", () => {
  it("counts local minutes since midnight", () => {
    expect(localMinuteOfDay(new Date(2026, 6, 30, 0, 0))).toBe(0);
    expect(localMinuteOfDay(new Date(2026, 6, 30, 21, 30))).toBe(1290);
    expect(localMinuteOfDay(new Date(2026, 6, 30, 23, 59))).toBe(1439);
  });
});

describe("isDayKey", () => {
  it("accepts well-formed real dates", () => {
    expect(isDayKey("2026-07-30")).toBe(true);
    expect(isDayKey("2024-02-29")).toBe(true); // leap year
  });

  it("rejects malformed strings", () => {
    for (const bad of ["", "2026-7-30", "26-07-30", "2026/07/30", "not-a-date", "2026-07-30T00:00"]) {
      expect(isDayKey(bad), bad).toBe(false);
    }
  });

  it("rejects dates that don't exist on the calendar", () => {
    // The regex alone would accept these; the round-trip check is what catches
    // them, and it is why a stray key can never poison a streak walk.
    expect(isDayKey("2026-02-30")).toBe(false);
    expect(isDayKey("2026-13-01")).toBe(false);
    expect(isDayKey("2025-02-29")).toBe(false); // not a leap year
  });

  it("rejects non-strings", () => {
    for (const bad of [null, undefined, 20260730, {}, []]) {
      expect(isDayKey(bad)).toBe(false);
    }
  });
});

describe("shiftDay / previousDay / nextDay", () => {
  it("moves within a month", () => {
    expect(previousDay("2026-07-30")).toBe("2026-07-29");
    expect(nextDay("2026-07-30")).toBe("2026-07-31");
  });

  it("rolls across month boundaries", () => {
    expect(previousDay("2026-08-01")).toBe("2026-07-31");
    expect(nextDay("2026-07-31")).toBe("2026-08-01");
  });

  it("rolls across year boundaries", () => {
    expect(previousDay("2026-01-01")).toBe("2025-12-31");
    expect(nextDay("2025-12-31")).toBe("2026-01-01");
  });

  it("handles leap days", () => {
    expect(nextDay("2024-02-28")).toBe("2024-02-29");
    expect(nextDay("2024-02-29")).toBe("2024-03-01");
    expect(nextDay("2025-02-28")).toBe("2025-03-01");
  });

  it("round-trips over a long span, staying on real calendar days", () => {
    let day = "2025-01-01";
    for (let i = 0; i < 400; i += 1) day = nextDay(day);
    for (let i = 0; i < 400; i += 1) day = previousDay(day);
    expect(day).toBe("2025-01-01");
  });

  it("shifts by arbitrary amounts", () => {
    expect(shiftDay("2026-07-30", 0)).toBe("2026-07-30");
    expect(shiftDay("2026-07-30", 7)).toBe("2026-08-06");
    expect(shiftDay("2026-07-30", -30)).toBe("2026-06-30");
  });
});

describe("yearOf", () => {
  it("extracts the year", () => {
    expect(yearOf("2026-07-30")).toBe("2026");
  });
});

/* ---------------------------------------------------------------------------
 * Event shape
 * ------------------------------------------------------------------------ */

describe("isWatchEvent", () => {
  it("accepts each kind", () => {
    expect(isWatchEvent({ k: "e", t: "tv:1396", s: 1, e: 5, m: 1290 })).toBe(true);
    expect(isWatchEvent({ k: "m", t: "movie:238", m: 600 })).toBe(true);
    expect(isWatchEvent({ k: "t", t: "tv:1396" })).toBe(true);
  });

  it("accepts a bulk flag of exactly 1", () => {
    expect(isWatchEvent({ k: "e", t: "tv:1396", s: 1, e: 5, b: 1 })).toBe(true);
    expect(isWatchEvent({ k: "e", t: "tv:1396", s: 1, e: 5, b: true })).toBe(false);
    expect(isWatchEvent({ k: "e", t: "tv:1396", s: 1, e: 5, b: 0 })).toBe(false);
  });

  it("requires coordinates on an episode event", () => {
    // Without these the event can't be attributed to anything.
    expect(isWatchEvent({ k: "e", t: "tv:1396", s: 1 })).toBe(false);
    expect(isWatchEvent({ k: "e", t: "tv:1396", e: 5 })).toBe(false);
  });

  it("accepts season 0 — Specials are real", () => {
    expect(isWatchEvent({ k: "e", t: "tv:1396", s: 0, e: 2 })).toBe(true);
  });

  it("rejects an out-of-range minute", () => {
    expect(isWatchEvent({ k: "m", t: "movie:238", m: 1440 })).toBe(false);
    expect(isWatchEvent({ k: "m", t: "movie:238", m: -1 })).toBe(false);
    expect(isWatchEvent({ k: "m", t: "movie:238", m: 12.5 })).toBe(false);
  });

  it("allows an absent minute — a Phase 7 import has no known time", () => {
    expect(isWatchEvent({ k: "m", t: "movie:238" })).toBe(true);
  });

  it("rejects junk", () => {
    for (const bad of [null, undefined, "e", 5, {}, { k: "x", t: "tv:1" }, { k: "m", t: "" }]) {
      expect(isWatchEvent(bad)).toBe(false);
    }
  });
});

describe("isWatchLogDay", () => {
  it("accepts an empty or valid array", () => {
    expect(isWatchLogDay([])).toBe(true);
    expect(isWatchLogDay([{ k: "m", t: "movie:238" }])).toBe(true);
  });

  it("rejects a non-array or an array with any bad event", () => {
    expect(isWatchLogDay({})).toBe(false);
    expect(isWatchLogDay([{ k: "m", t: "movie:238" }, { k: "zzz" }])).toBe(false);
  });
});

describe("watchTitleKey", () => {
  it("matches the shape used by tracking and ratings", () => {
    expect(watchTitleKey("tv", "1396")).toBe("tv:1396");
    expect(watchTitleKey("movie", "238")).toBe("movie:238");
  });
});

/* ---------------------------------------------------------------------------
 * Diffing — how every episode operation gets logged
 * ------------------------------------------------------------------------ */

describe("addedEpisodes", () => {
  it("finds a single newly-marked episode", () => {
    expect(addedEpisodes({}, { 1: [[5, 5]] })).toEqual([{ seasonNumber: 1, episodeNumber: 5 }]);
  });

  it("expands a whole-season mark", () => {
    const added = addedEpisodes({}, { 1: [[1, 13]] });
    expect(added).toHaveLength(13);
    expect(added[0]).toEqual({ seasonNumber: 1, episodeNumber: 1 });
    expect(added[12]).toEqual({ seasonNumber: 1, episodeNumber: 13 });
  });

  it("returns only the delta, not everything already watched", () => {
    // The bug this prevents: re-logging an entire season every time one more
    // episode is ticked.
    expect(addedEpisodes({ 1: [[1, 12]] }, { 1: [[1, 13]] })).toEqual([
      { seasonNumber: 1, episodeNumber: 13 },
    ]);
  });

  it("returns nothing for an un-mark", () => {
    // Append-only: removing progress does not un-happen the original watch.
    expect(addedEpisodes({ 1: [[1, 13]] }, { 1: [[1, 12]] })).toEqual([]);
  });

  it("returns nothing when nothing changed", () => {
    expect(addedEpisodes({ 1: [[1, 13]] }, { 1: [[1, 13]] })).toEqual([]);
  });

  it("handles a mid-range gap being filled", () => {
    expect(addedEpisodes({ 1: [[1, 4], [6, 10]] }, { 1: [[1, 10]] })).toEqual([
      { seasonNumber: 1, episodeNumber: 5 },
    ]);
  });

  it("spans seasons, as a cross-season binge does", () => {
    const added = addedEpisodes({ 1: [[1, 2]] }, { 1: [[1, 3]], 2: [[1, 2]] });
    expect(added).toEqual([
      { seasonNumber: 1, episodeNumber: 3 },
      { seasonNumber: 2, episodeNumber: 1 },
      { seasonNumber: 2, episodeNumber: 2 },
    ]);
  });

  it("sorts by season then episode", () => {
    const added = addedEpisodes({}, { 2: [[1, 1]], 1: [[2, 2]] });
    expect(added).toEqual([
      { seasonNumber: 1, episodeNumber: 2 },
      { seasonNumber: 2, episodeNumber: 1 },
    ]);
  });

  it("includes season 0", () => {
    expect(addedEpisodes({}, { 0: [[1, 1]] })).toEqual([{ seasonNumber: 0, episodeNumber: 1 }]);
  });
});

/* ---------------------------------------------------------------------------
 * Streaks
 * ------------------------------------------------------------------------ */

describe("activeDays", () => {
  it("de-duplicates, drops invalid keys, and sorts ascending", () => {
    expect(activeDays(["2026-07-30", "2026-07-28", "2026-07-30", "nope", "2026-02-30"])).toEqual([
      "2026-07-28",
      "2026-07-30",
    ]);
  });
});

describe("currentStreak", () => {
  it("counts back from today", () => {
    const days = ["2026-07-30", "2026-07-29", "2026-07-28"];
    expect(currentStreak(days, "2026-07-30")).toBe(3);
  });

  it("stays alive when today is empty but yesterday isn't", () => {
    // A 40-day streak must not read as 0 at 00:01 just because the new day is
    // young — the streak is alive, merely not yet extended.
    const days = ["2026-07-29", "2026-07-28", "2026-07-27"];
    expect(currentStreak(days, "2026-07-30")).toBe(3);
  });

  it("is 0 when the last activity was two days ago", () => {
    expect(currentStreak(["2026-07-28", "2026-07-27"], "2026-07-30")).toBe(0);
  });

  it("is 0 on an empty log", () => {
    expect(currentStreak([], "2026-07-30")).toBe(0);
  });

  it("stops at the first gap", () => {
    const days = ["2026-07-30", "2026-07-29", "2026-07-27", "2026-07-26"];
    expect(currentStreak(days, "2026-07-30")).toBe(2);
  });

  it("counts a single day as 1", () => {
    expect(currentStreak(["2026-07-30"], "2026-07-30")).toBe(1);
  });

  it("walks across a month boundary", () => {
    const days = ["2026-08-01", "2026-07-31", "2026-07-30"];
    expect(currentStreak(days, "2026-08-01")).toBe(3);
  });

  it("walks across a year boundary", () => {
    const days = ["2026-01-01", "2025-12-31", "2025-12-30"];
    expect(currentStreak(days, "2026-01-01")).toBe(3);
  });

  it("ignores days in the future", () => {
    expect(currentStreak(["2026-08-05", "2026-07-30"], "2026-07-30")).toBe(1);
  });
});

describe("longestStreak", () => {
  it("finds the longest run", () => {
    const days = [
      "2026-07-01", "2026-07-02", "2026-07-03", // 3
      "2026-07-10",                              // 1
      "2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23", // 4
    ];
    expect(longestStreak(days)).toBe(4);
  });

  it("is 0 on an empty log and 1 for a single day", () => {
    expect(longestStreak([])).toBe(0);
    expect(longestStreak(["2026-07-30"])).toBe(1);
  });

  it("doesn't care about input order", () => {
    expect(longestStreak(["2026-07-03", "2026-07-01", "2026-07-02"])).toBe(3);
  });

  it("spans a month boundary", () => {
    expect(longestStreak(["2026-07-30", "2026-07-31", "2026-08-01"])).toBe(3);
  });

  it("counts a run of exactly 1 between gaps", () => {
    expect(longestStreak(["2026-07-01", "2026-07-05", "2026-07-09"])).toBe(1);
  });
});

describe("trackingSince", () => {
  it("returns the earliest day", () => {
    expect(trackingSince(["2026-07-30", "2025-01-15", "2026-01-01"])).toBe("2025-01-15");
  });

  it("returns null on an empty log — the honest backfill gap", () => {
    expect(trackingSince([])).toBeNull();
  });
});

/* ---------------------------------------------------------------------------
 * Year in Review helpers
 * ------------------------------------------------------------------------ */

describe("daysInYear / yearsCovered", () => {
  const days = ["2025-12-31", "2026-01-01", "2026-07-30", "2027-03-03"];

  it("filters by year using the key alone", () => {
    expect(daysInYear(days, 2026)).toEqual(["2026-01-01", "2026-07-30"]);
    expect(daysInYear(days, "2026")).toEqual(["2026-01-01", "2026-07-30"]);
  });

  it("returns nothing for an unrepresented year", () => {
    expect(daysInYear(days, 2024)).toEqual([]);
  });

  it("lists distinct years ascending", () => {
    expect(yearsCovered(days)).toEqual(["2025", "2026", "2027"]);
  });
});

describe("totals", () => {
  const days: WatchLogDay[] = [
    [
      { k: WATCH_KIND.EPISODE, t: "tv:1396", s: 1, e: 1, m: 1200 },
      { k: WATCH_KIND.EPISODE, t: "tv:1396", s: 1, e: 2, m: 1260 },
    ],
    [
      { k: WATCH_KIND.MOVIE, t: "movie:238", m: 600 },
      { k: WATCH_KIND.EPISODE, t: "tv:1399", s: 1, e: 1, m: 1300, b: 1 },
      { k: WATCH_KIND.TITLE, t: "tv:456", m: 1400 },
    ],
  ];

  it("counts by kind", () => {
    expect(totals(days)).toEqual({
      events: 5,
      episodes: 3,
      movies: 1,
      titles: 1,
      fromBulk: 1,
    });
  });

  it("counts titles separately from episodes", () => {
    // A coarse "whole show watched" is not one episode; folding it in would
    // silently inflate the episode count.
    const result = totals([[{ k: WATCH_KIND.TITLE, t: "tv:456" }]]);
    expect(result.episodes).toBe(0);
    expect(result.titles).toBe(1);
  });

  it("is all zeroes on an empty log", () => {
    expect(totals([])).toEqual({ events: 0, episodes: 0, movies: 0, titles: 0, fromBulk: 0 });
  });
});

describe("byHourOfDay", () => {
  it("buckets by local hour", () => {
    const hours = byHourOfDay([
      [
        { k: WATCH_KIND.MOVIE, t: "movie:1", m: 0 },      // 00:00
        { k: WATCH_KIND.MOVIE, t: "movie:2", m: 1290 },   // 21:30
        { k: WATCH_KIND.MOVIE, t: "movie:3", m: 1319 },   // 21:59
      ],
    ]);
    expect(hours[0]).toBe(1);
    expect(hours[21]).toBe(2);
    expect(hours).toHaveLength(24);
  });

  it("skips events with no recorded time rather than defaulting to midnight", () => {
    // Defaulting would invent a spike at 00:00 for imported data.
    const hours = byHourOfDay([[{ k: WATCH_KIND.MOVIE, t: "movie:1" }]]);
    expect(hours.every((count) => count === 0)).toBe(true);
  });

  it("EXCLUDES bulk events — they record when you clicked, not when you watched", () => {
    // Measured on real data before this was fixed: a 39-event log where 33
    // events were one "mark season watched" reported "you watch most at 4am"
    // off the back of a single tap. Every event in a bulk batch shares the
    // minute of the click.
    const hours = byHourOfDay([
      [
        { k: WATCH_KIND.EPISODE, t: "tv:1", s: 1, e: 1, m: 283, b: 1 },
        { k: WATCH_KIND.EPISODE, t: "tv:1", s: 1, e: 2, m: 283, b: 1 },
        { k: WATCH_KIND.EPISODE, t: "tv:1", s: 1, e: 3, m: 283, b: 1 },
        { k: WATCH_KIND.MOVIE, t: "movie:1", m: 283 },
      ],
    ]);
    expect(hours[4]).toBe(1);
    expect(hours.reduce((sum, count) => sum + count, 0)).toBe(1);
  });
});

describe("byWeekday", () => {
  it("buckets by weekday with Sunday at 0", () => {
    // 2026-07-30 is a Thursday (4); 2026-08-02 is a Sunday (0).
    const weekdays = byWeekday([
      ["2026-07-30", [{ k: WATCH_KIND.MOVIE, t: "movie:1" }]],
      ["2026-08-02", [
        { k: WATCH_KIND.MOVIE, t: "movie:2" },
        { k: WATCH_KIND.MOVIE, t: "movie:3" },
      ]],
    ]);
    expect(weekdays[4]).toBe(1);
    expect(weekdays[0]).toBe(2);
    expect(weekdays).toHaveLength(7);
  });

  it("ignores invalid day keys", () => {
    const weekdays = byWeekday([["nope", [{ k: WATCH_KIND.MOVIE, t: "movie:1" }]]]);
    expect(weekdays.every((count) => count === 0)).toBe(true);
  });

  it("EXCLUDES bulk events, which skewed this harder than the hour histogram", () => {
    // This one counted `events.length` outright, so one 33-episode season
    // mark added 33 to a single weekday — one Friday afternoon reading as the
    // heaviest viewing day of someone's year.
    const weekdays = byWeekday([
      [
        "2026-07-30", // Thursday
        [
          { k: WATCH_KIND.EPISODE, t: "tv:1", s: 1, e: 1, m: 283, b: 1 },
          { k: WATCH_KIND.EPISODE, t: "tv:1", s: 1, e: 2, m: 283, b: 1 },
          { k: WATCH_KIND.MOVIE, t: "movie:1", m: 600 },
        ],
      ],
    ]);
    expect(weekdays[4]).toBe(1);
  });

  it("DOES count untimed imports, unlike byHourOfDay", () => {
    // A Letterboxd row has no clock time but a real calendar date, so it
    // knows exactly which weekday it was. Excluding it would throw away
    // information we actually have.
    const weekdays = byWeekday([["2026-08-02", [{ k: WATCH_KIND.MOVIE, t: "movie:1" }]]]);
    expect(weekdays[0]).toBe(1); // Sunday
  });
});

describe("eventsForTitle", () => {
  it("collects one title's events across days", () => {
    const days: WatchLogDay[] = [
      [{ k: WATCH_KIND.EPISODE, t: "tv:1396", s: 1, e: 1 }, { k: WATCH_KIND.MOVIE, t: "movie:238" }],
      [{ k: WATCH_KIND.EPISODE, t: "tv:1396", s: 1, e: 2 }],
    ];
    expect(eventsForTitle(days, "tv:1396")).toHaveLength(2);
    expect(eventsForTitle(days, "movie:238")).toHaveLength(1);
    expect(eventsForTitle(days, "tv:9999")).toHaveLength(0);
  });
});

describe("maxEpisodesOfSameTitleInADay", () => {
  it("is 0 for an empty log", () => {
    expect(maxEpisodesOfSameTitleInADay([])).toBe(0);
  });

  it("counts episode events for one title within a single day", () => {
    const days: WatchLogDay[] = [
      [
        { k: WATCH_KIND.EPISODE, t: "tv:1396", s: 1, e: 1 },
        { k: WATCH_KIND.EPISODE, t: "tv:1396", s: 1, e: 2 },
        { k: WATCH_KIND.EPISODE, t: "tv:1396", s: 1, e: 3 },
      ],
    ];
    expect(maxEpisodesOfSameTitleInADay(days)).toBe(3);
  });

  it("does not sum across separate days", () => {
    const days: WatchLogDay[] = [
      [{ k: WATCH_KIND.EPISODE, t: "tv:1396", s: 1, e: 1 }],
      [{ k: WATCH_KIND.EPISODE, t: "tv:1396", s: 1, e: 2 }],
    ];
    expect(maxEpisodesOfSameTitleInADay(days)).toBe(1);
  });

  it("does not mix two different titles' counts within the same day", () => {
    const days: WatchLogDay[] = [
      [
        { k: WATCH_KIND.EPISODE, t: "tv:1396", s: 1, e: 1 },
        { k: WATCH_KIND.EPISODE, t: "tv:1396", s: 1, e: 2 },
        { k: WATCH_KIND.EPISODE, t: "tv:9999", s: 1, e: 1 },
      ],
    ];
    expect(maxEpisodesOfSameTitleInADay(days)).toBe(2);
  });

  it("ignores non-episode events", () => {
    const days: WatchLogDay[] = [
      [
        { k: WATCH_KIND.MOVIE, t: "movie:238" },
        { k: WATCH_KIND.MOVIE, t: "movie:238" }, // hypothetical, still not an episode
        { k: WATCH_KIND.TITLE, t: "tv:1" },
      ],
    ];
    expect(maxEpisodesOfSameTitleInADay(days)).toBe(0);
  });
});

describe("hasRepeatedMark", () => {
  it("is false for an empty log", () => {
    expect(hasRepeatedMark([])).toBe(false);
  });

  it("is false when nothing repeats", () => {
    const days: WatchLogDay[] = [
      [
        { k: WATCH_KIND.EPISODE, t: "tv:1396", s: 1, e: 1 },
        { k: WATCH_KIND.EPISODE, t: "tv:1396", s: 1, e: 2 },
        { k: WATCH_KIND.MOVIE, t: "movie:238" },
      ],
    ];
    expect(hasRepeatedMark(days)).toBe(false);
  });

  it("detects the same episode logged on two different days (unmark, then remark)", () => {
    const days: WatchLogDay[] = [
      [{ k: WATCH_KIND.EPISODE, t: "tv:1396", s: 1, e: 1 }],
      [{ k: WATCH_KIND.EPISODE, t: "tv:1396", s: 1, e: 1 }],
    ];
    expect(hasRepeatedMark(days)).toBe(true);
  });

  it("detects a repeated movie mark", () => {
    const days: WatchLogDay[] = [
      [{ k: WATCH_KIND.MOVIE, t: "movie:238" }],
      [{ k: WATCH_KIND.MOVIE, t: "movie:238" }],
    ];
    expect(hasRepeatedMark(days)).toBe(true);
  });

  it("does not confuse two different episodes of the same show", () => {
    const days: WatchLogDay[] = [
      [
        { k: WATCH_KIND.EPISODE, t: "tv:1396", s: 1, e: 1 },
        { k: WATCH_KIND.EPISODE, t: "tv:1396", s: 1, e: 2 },
      ],
    ];
    expect(hasRepeatedMark(days)).toBe(false);
  });

  it("does not confuse a movie and a title-level event on the same id", () => {
    // Same t-string is possible only across kinds in synthetic data, but the
    // identity key includes `k`, so this must not be treated as a repeat.
    const days: WatchLogDay[] = [
      [
        { k: WATCH_KIND.MOVIE, t: "x:1" },
        { k: WATCH_KIND.TITLE, t: "x:1" },
      ],
    ];
    expect(hasRepeatedMark(days)).toBe(false);
  });
});

describe("earliestDayForTitle", () => {
  it("is empty for an empty log", () => {
    expect(earliestDayForTitle([])).toEqual({});
  });

  it("picks the earliest day per title regardless of input order", () => {
    const entries: [string, WatchLogDay][] = [
      ["2026-07-15", [{ k: WATCH_KIND.EPISODE, t: "tv:1396", s: 1, e: 3 }]],
      ["2026-07-01", [{ k: WATCH_KIND.EPISODE, t: "tv:1396", s: 1, e: 1 }]],
      ["2026-07-10", [{ k: WATCH_KIND.MOVIE, t: "movie:238" }]],
    ];
    expect(earliestDayForTitle(entries)).toEqual({
      "tv:1396": "2026-07-01",
      "movie:238": "2026-07-10",
    });
  });

  it("ignores invalid day keys", () => {
    const entries: [string, WatchLogDay][] = [
      ["not-a-day", [{ k: WATCH_KIND.EPISODE, t: "tv:1", s: 1, e: 1 }]],
    ];
    expect(earliestDayForTitle(entries)).toEqual({});
  });
});
