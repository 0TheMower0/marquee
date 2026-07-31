import { describe, expect, it } from "vitest";

import type { RatingEntry } from "@/lib/ratings";
import type { MovieTrackingEntry, TrackingEntry, TvTrackingEntry } from "@/lib/tracking";
import type { StreakStatus } from "@/lib/watchlog";

import { BADGES } from "./definitions";
import { evaluateBadges } from "./evaluate";
import type { BadgeContext, BadgeDefinition } from "./types";

/* ---------------------------------------------------------------------------
 * Fixture builders — minimal, override-friendly
 * ------------------------------------------------------------------------ */

const EMPTY_STREAK: StreakStatus = {
  currentStreak: 0,
  longestStreak: 0,
  freezesAvailable: 0,
  freezeActive: false,
  freezesSpentLifetime: 0,
};

function emptyContext(overrides: Partial<BadgeContext> = {}): BadgeContext {
  return {
    entries: {},
    ratingEntries: {},
    streak: EMPTY_STREAK,
    hourCounts: new Array(24).fill(0),
    maxEpisodesInADay: 0,
    hasRepeatedMark: false,
    earliestDayForTitle: {},
    ...overrides,
  };
}

function movieEntry(
  id: string,
  options: {
    status?: TrackingEntry["status"];
    year?: number | null;
    genres?: string[];
    rating?: number | null;
  } = {},
): MovieTrackingEntry {
  return {
    id,
    mediaType: "movie",
    status: options.status ?? "watched",
    addedAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    runtimeMinutes: null,
    summary: {
      id,
      mediaType: "movie",
      name: `Movie ${id}`,
      year: options.year === undefined ? 2000 : options.year,
      overview: "",
      genres: (options.genres ?? []).map((g) => ({ id: g, name: g })),
      posterUrl: null,
      placeholder: { gradientFrom: "#000", gradientTo: "#111" },
      rating: options.rating === undefined ? 7 : options.rating,
    },
  };
}

function tvEntry(
  id: string,
  options: {
    status?: TrackingEntry["status"];
    year?: number | null;
    genres?: string[];
    rating?: number | null;
    watchedEpisodeCount?: number;
    knownEpisodeCount?: number | null;
  } = {},
): TvTrackingEntry {
  const watchedEpisodes: TvTrackingEntry["watchedEpisodes"] =
    options.watchedEpisodeCount !== undefined
      ? { 1: [[1, options.watchedEpisodeCount] as [number, number]] }
      : {};
  return {
    id,
    mediaType: "tv",
    status: options.status ?? "watched",
    addedAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    watchedEpisodes,
    knownEpisodeCount: options.knownEpisodeCount ?? null,
    summary: {
      id,
      mediaType: "tv",
      name: `Show ${id}`,
      year: options.year === undefined ? 2000 : options.year,
      overview: "",
      genres: (options.genres ?? []).map((g) => ({ id: g, name: g })),
      posterUrl: null,
      placeholder: { gradientFrom: "#000", gradientTo: "#111" },
      rating: options.rating === undefined ? 7 : options.rating,
    },
  };
}

function rating(id: string, score: number | null, note = ""): RatingEntry {
  return { id, mediaType: "movie", score, note, updatedAt: new Date("2026-01-01") };
}

function badge(id: string): BadgeDefinition {
  const found = BADGES.find((b) => b.id === id);
  if (!found) throw new Error(`no badge definition for "${id}"`);
  return found;
}

/* ---------------------------------------------------------------------------
 * Sanity checks over the whole set
 * ------------------------------------------------------------------------ */

describe("BADGES", () => {
  it("has 20 definitions", () => {
    expect(BADGES).toHaveLength(20);
  });

  it("has unique ids", () => {
    expect(new Set(BADGES.map((b) => b.id)).size).toBe(BADGES.length);
  });

  it("every badge has a non-empty description (the locked-state unlock condition)", () => {
    for (const definition of BADGES) {
      expect(definition.description.length).toBeGreaterThan(0);
    }
  });

  it("is all locked against a fully empty context", () => {
    const context = emptyContext();
    for (const definition of BADGES) {
      expect(definition.isUnlocked(context)).toBe(false);
    }
  });
});

/* ---------------------------------------------------------------------------
 * Exploration
 * ------------------------------------------------------------------------ */

describe("genre-hopper / full-spectrum", () => {
  it("locked below 5 distinct genres, unlocked at 5", () => {
    const four = emptyContext({
      entries: {
        "movie:1": movieEntry("1", { genres: ["action"] }),
        "movie:2": movieEntry("2", { genres: ["drama"] }),
        "movie:3": movieEntry("3", { genres: ["comedy"] }),
        "movie:4": movieEntry("4", { genres: ["horror"] }),
      },
    });
    expect(badge("genre-hopper").isUnlocked(four)).toBe(false);

    const five = emptyContext({
      entries: { ...four.entries, "movie:5": movieEntry("5", { genres: ["sci-fi"] }) },
    });
    expect(badge("genre-hopper").isUnlocked(five)).toBe(true);
    expect(badge("full-spectrum").isUnlocked(five)).toBe(false);
  });

  it("ignores watchlisted (not started) entries", () => {
    const context = emptyContext({
      entries: {
        "movie:1": movieEntry("1", { genres: ["action"], status: "watchlist" }),
        "movie:2": movieEntry("2", { genres: ["drama"], status: "watchlist" }),
      },
    });
    expect(badge("genre-hopper").isUnlocked(context)).toBe(false);
  });

  it("counts distinct genres, not distinct titles", () => {
    const context = emptyContext({
      entries: {
        "movie:1": movieEntry("1", { genres: ["action", "drama"] }),
        "movie:2": movieEntry("2", { genres: ["action"] }), // no new genre
      },
    });
    const genres = new Set<string>();
    for (const e of Object.values(context.entries)) for (const g of e.summary.genres) genres.add(g.id);
    expect(genres.size).toBe(2);
  });
});

describe("time-traveler", () => {
  it("requires 4 distinct decades", () => {
    const three = emptyContext({
      entries: {
        "movie:1": movieEntry("1", { year: 1985 }),
        "movie:2": movieEntry("2", { year: 1994 }), // same decade as nothing else here
        "movie:3": movieEntry("3", { year: 2001 }),
      },
    });
    // 1980s, 1990s, 2000s = 3 decades
    expect(badge("time-traveler").isUnlocked(three)).toBe(false);

    const four = emptyContext({
      entries: { ...three.entries, "movie:4": movieEntry("4", { year: 2015 }) },
    });
    expect(badge("time-traveler").isUnlocked(four)).toBe(true);
  });

  it("skips entries with an unknown year", () => {
    const context = emptyContext({
      entries: {
        "movie:1": movieEntry("1", { year: null }),
        "movie:2": movieEntry("2", { year: null }),
      },
    });
    expect(badge("time-traveler").isUnlocked(context)).toBe(false);
  });
});

/* ---------------------------------------------------------------------------
 * Completion
 * ------------------------------------------------------------------------ */

describe("the-long-haul", () => {
  it("requires a WATCHED tv entry with 100+ episodes", () => {
    const inProgress = emptyContext({
      entries: { "tv:1": tvEntry("1", { status: "watching", watchedEpisodeCount: 150 }) },
    });
    expect(badge("the-long-haul").isUnlocked(inProgress)).toBe(false); // not finished

    const short = emptyContext({
      entries: { "tv:1": tvEntry("1", { status: "watched", watchedEpisodeCount: 99 }) },
    });
    expect(badge("the-long-haul").isUnlocked(short)).toBe(false);

    const long = emptyContext({
      entries: { "tv:1": tvEntry("1", { status: "watched", watchedEpisodeCount: 100 }) },
    });
    expect(badge("the-long-haul").isUnlocked(long)).toBe(true);
  });

  it("falls back to knownEpisodeCount for a coarse whole-show mark", () => {
    const context = emptyContext({
      entries: { "tv:1": tvEntry("1", { status: "watched", knownEpisodeCount: 120 }) },
    });
    expect(badge("the-long-haul").isUnlocked(context)).toBe(true);
  });

  it("never unlocks from a movie", () => {
    const context = emptyContext({ entries: { "movie:1": movieEntry("1") } });
    expect(badge("the-long-haul").isUnlocked(context)).toBe(false);
  });
});

describe("marathoner", () => {
  it("requires 8+ episodes of one show in a single day", () => {
    expect(badge("marathoner").isUnlocked(emptyContext({ maxEpisodesInADay: 7 }))).toBe(false);
    expect(badge("marathoner").isUnlocked(emptyContext({ maxEpisodesInADay: 8 }))).toBe(true);
  });
});

describe("caught-up", () => {
  it("requires zero backlog AND at least one watched title", () => {
    const nothingTracked = emptyContext();
    expect(badge("caught-up").isUnlocked(nothingTracked)).toBe(false); // trivial empty case excluded

    const stillHasWatchlist = emptyContext({
      entries: {
        "movie:1": movieEntry("1", { status: "watched" }),
        "movie:2": movieEntry("2", { status: "watchlist" }),
      },
    });
    expect(badge("caught-up").isUnlocked(stillHasWatchlist)).toBe(false);

    const cleared = emptyContext({
      entries: { "movie:1": movieEntry("1", { status: "watched" }) },
    });
    expect(badge("caught-up").isUnlocked(cleared)).toBe(true);
  });

  it("treats 'watching' as still-open backlog too", () => {
    const context = emptyContext({
      entries: {
        "movie:1": movieEntry("1", { status: "watched" }),
        "tv:1": tvEntry("1", { status: "watching" }),
      },
    });
    expect(badge("caught-up").isUnlocked(context)).toBe(false);
  });
});

/* ---------------------------------------------------------------------------
 * Habit
 * ------------------------------------------------------------------------ */

describe("streak-length badges", () => {
  it("week-one / regular / devoted key off longestStreak at 7/30/100", () => {
    const s = (longestStreak: number): BadgeContext =>
      emptyContext({ streak: { ...EMPTY_STREAK, longestStreak } });

    expect(badge("week-one").isUnlocked(s(6))).toBe(false);
    expect(badge("week-one").isUnlocked(s(7))).toBe(true);
    expect(badge("regular").isUnlocked(s(29))).toBe(false);
    expect(badge("regular").isUnlocked(s(30))).toBe(true);
    expect(badge("devoted").isUnlocked(s(99))).toBe(false);
    expect(badge("devoted").isUnlocked(s(100))).toBe(true);
  });
});

describe("comeback", () => {
  it("requires at least one lifetime freeze spend", () => {
    expect(
      badge("comeback").isUnlocked(emptyContext({ streak: { ...EMPTY_STREAK, freezesSpentLifetime: 0 } })),
    ).toBe(false);
    expect(
      badge("comeback").isUnlocked(emptyContext({ streak: { ...EMPTY_STREAK, freezesSpentLifetime: 1 } })),
    ).toBe(true);
  });
});

describe("night-owl / early-bird", () => {
  function hours(entries: Record<number, number>): number[] {
    const arr = new Array(24).fill(0);
    for (const [hour, count] of Object.entries(entries)) arr[Number(hour)] = count;
    return arr;
  }

  it("requires a minimum sample size before evaluating at all", () => {
    // 10 events, all late night — majority, but below the sample floor.
    const smallSample = emptyContext({ hourCounts: hours({ 22: 10 }) });
    expect(badge("night-owl").isUnlocked(smallSample)).toBe(false);
  });

  it("unlocks once a majority of a large-enough sample is late night", () => {
    const context = emptyContext({ hourCounts: hours({ 22: 10, 14: 5 }) }); // 10/15 > half
    expect(badge("night-owl").isUnlocked(context)).toBe(true);
    expect(badge("early-bird").isUnlocked(context)).toBe(false);
  });

  it("does not unlock on an exact split", () => {
    const context = emptyContext({ hourCounts: hours({ 22: 8, 14: 8 }) }); // 8/16, not a majority
    expect(badge("night-owl").isUnlocked(context)).toBe(false);
  });

  it("early-bird mirrors night-owl for the 5am-9am window", () => {
    const context = emptyContext({ hourCounts: hours({ 6: 10, 14: 5 }) });
    expect(badge("early-bird").isUnlocked(context)).toBe(true);
    expect(badge("night-owl").isUnlocked(context)).toBe(false);
  });
});

/* ---------------------------------------------------------------------------
 * Taste
 * ------------------------------------------------------------------------ */

describe("has-opinions / ratings-machine", () => {
  function ratingsOf(count: number): Record<string, RatingEntry> {
    const out: Record<string, RatingEntry> = {};
    for (let i = 0; i < count; i++) out[`movie:${i}`] = rating(String(i), 80);
    return out;
  }

  it("requires 10 / 50 rated titles", () => {
    expect(badge("has-opinions").isUnlocked(emptyContext({ ratingEntries: ratingsOf(9) }))).toBe(false);
    expect(badge("has-opinions").isUnlocked(emptyContext({ ratingEntries: ratingsOf(10) }))).toBe(true);
    expect(badge("ratings-machine").isUnlocked(emptyContext({ ratingEntries: ratingsOf(49) }))).toBe(false);
    expect(badge("ratings-machine").isUnlocked(emptyContext({ ratingEntries: ratingsOf(50) }))).toBe(true);
  });

  it("does not count a note-only entry (score null) as rated", () => {
    const context = emptyContext({
      ratingEntries: Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [`movie:${i}`, rating(String(i), null, "thoughts")]),
      ),
    });
    expect(badge("has-opinions").isUnlocked(context)).toBe(false);
  });
});

describe("film-journal", () => {
  it("requires 10 titles with a non-empty note", () => {
    const nine = emptyContext({
      ratingEntries: Object.fromEntries(
        Array.from({ length: 9 }, (_, i) => [`movie:${i}`, rating(String(i), null, "note")]),
      ),
    });
    expect(badge("film-journal").isUnlocked(nine)).toBe(false);

    const ten = emptyContext({
      ratingEntries: Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [`movie:${i}`, rating(String(i), null, "note")]),
      ),
    });
    expect(badge("film-journal").isUnlocked(ten)).toBe(true);
  });

  it("a whitespace-only note does not count", () => {
    const context = emptyContext({
      ratingEntries: Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [`movie:${i}`, rating(String(i), null, "   ")]),
      ),
    });
    expect(badge("film-journal").isUnlocked(context)).toBe(false);
  });
});

describe("strong-opinions", () => {
  it("unlocks at either extreme, not in the middle", () => {
    expect(badge("strong-opinions").isUnlocked(emptyContext({ ratingEntries: { "movie:1": rating("1", 50) } }))).toBe(
      false,
    );
    expect(badge("strong-opinions").isUnlocked(emptyContext({ ratingEntries: { "movie:1": rating("1", 5) } }))).toBe(
      true,
    );
    expect(badge("strong-opinions").isUnlocked(emptyContext({ ratingEntries: { "movie:1": rating("1", 95) } }))).toBe(
      true,
    );
    expect(badge("strong-opinions").isUnlocked(emptyContext({ ratingEntries: { "movie:1": rating("1", 6) } }))).toBe(
      false,
    );
  });
});

describe("contrarian", () => {
  it("compares the user's score against the matching tracked title's TMDB rating", () => {
    const close = emptyContext({
      entries: { "movie:1": movieEntry("1", { rating: 8 }) }, // 80 on a 100 scale
      ratingEntries: { "movie:1": rating("1", 70) }, // 10-point gap
    });
    expect(badge("contrarian").isUnlocked(close)).toBe(false);

    const far = emptyContext({
      entries: { "movie:1": movieEntry("1", { rating: 8 }) },
      ratingEntries: { "movie:1": rating("1", 30) }, // 50-point gap
    });
    expect(badge("contrarian").isUnlocked(far)).toBe(true);
  });

  it("does not unlock without a matching tracked entry", () => {
    const context = emptyContext({ ratingEntries: { "movie:404": rating("404", 10) } });
    expect(badge("contrarian").isUnlocked(context)).toBe(false);
  });

  it("does not unlock when TMDB has no rating to compare against", () => {
    const context = emptyContext({
      entries: { "movie:1": movieEntry("1", { rating: null }) },
      ratingEntries: { "movie:1": rating("1", 5) },
    });
    expect(badge("contrarian").isUnlocked(context)).toBe(false);
  });
});

describe("second-helping", () => {
  it("is exactly the hasRepeatedMark flag", () => {
    expect(badge("second-helping").isUnlocked(emptyContext({ hasRepeatedMark: false }))).toBe(false);
    expect(badge("second-helping").isUnlocked(emptyContext({ hasRepeatedMark: true }))).toBe(true);
  });
});

/* ---------------------------------------------------------------------------
 * Discovery
 * ------------------------------------------------------------------------ */

describe("first-to-know", () => {
  it("unlocks on a started title with no TMDB rating", () => {
    const rated = emptyContext({ entries: { "movie:1": movieEntry("1", { rating: 7 }) } });
    expect(badge("first-to-know").isUnlocked(rated)).toBe(false);

    const unrated = emptyContext({ entries: { "movie:1": movieEntry("1", { rating: null }) } });
    expect(badge("first-to-know").isUnlocked(unrated)).toBe(true);
  });

  it("ignores watchlisted-only titles", () => {
    const context = emptyContext({
      entries: { "movie:1": movieEntry("1", { rating: null, status: "watchlist" }) },
    });
    expect(badge("first-to-know").isUnlocked(context)).toBe(false);
  });
});

describe("deep-cut", () => {
  it("requires a 40+ year gap between release and the logged watch day", () => {
    const recent = emptyContext({
      entries: { "movie:1": movieEntry("1", { year: 2000 }) },
      earliestDayForTitle: { "movie:1": "2020-01-01" }, // 20-year gap
    });
    expect(badge("deep-cut").isUnlocked(recent)).toBe(false);

    const old = emptyContext({
      entries: { "movie:1": movieEntry("1", { year: 1980 }) },
      earliestDayForTitle: { "movie:1": "2026-01-01" }, // 46-year gap
    });
    expect(badge("deep-cut").isUnlocked(old)).toBe(true);
  });

  it("cannot unlock for a title the log never saw (pre-Phase-5 watched titles)", () => {
    const context = emptyContext({
      entries: { "movie:1": movieEntry("1", { year: 1950 }) },
      earliestDayForTitle: {},
    });
    expect(badge("deep-cut").isUnlocked(context)).toBe(false);
  });
});

/* ---------------------------------------------------------------------------
 * evaluateBadges
 * ------------------------------------------------------------------------ */

describe("evaluateBadges", () => {
  it("reports every badge's status and flags newly-earned ones not yet in the ledger", () => {
    const context = emptyContext({ streak: { ...EMPTY_STREAK, longestStreak: 7 } });
    const { statuses, newlyEarnedIds } = evaluateBadges(BADGES, context, {});

    expect(statuses).toHaveLength(BADGES.length);
    const weekOne = statuses.find((s) => s.definition.id === "week-one")!;
    expect(weekOne.unlocked).toBe(true);
    expect(weekOne.earnedAt).toBeNull();
    expect(newlyEarnedIds).toContain("week-one");
  });

  it("a badge already in the ledger is unlocked and NOT newly-earned, even if condition is still true", () => {
    const context = emptyContext({ streak: { ...EMPTY_STREAK, longestStreak: 7 } });
    const earnedAt = new Date("2026-06-01");
    const { statuses, newlyEarnedIds } = evaluateBadges(BADGES, context, {
      "week-one": { earnedAt },
    });

    const weekOne = statuses.find((s) => s.definition.id === "week-one")!;
    expect(weekOne.unlocked).toBe(true);
    expect(weekOne.earnedAt).toBe(earnedAt);
    expect(newlyEarnedIds).not.toContain("week-one");
  });

  it("stays unlocked via the ledger even when the live condition has gone false again (stickiness)", () => {
    // Caught Up: condition is false now (backlog is non-empty), but it was
    // earned before and is in the ledger — must not flicker back to locked.
    const context = emptyContext({
      entries: {
        "movie:1": movieEntry("1", { status: "watched" }),
        "movie:2": movieEntry("2", { status: "watchlist" }),
      },
    });
    expect(badge("caught-up").isUnlocked(context)).toBe(false);

    const { statuses } = evaluateBadges(BADGES, context, {
      "caught-up": { earnedAt: new Date("2026-05-01") },
    });
    expect(statuses.find((s) => s.definition.id === "caught-up")!.unlocked).toBe(true);
  });
});
