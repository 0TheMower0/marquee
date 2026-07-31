import { describe, expect, it } from "vitest";

import type { RatingEntry } from "@/lib/ratings";
import type { MovieTrackingEntry, TrackingEntry, TvTrackingEntry } from "@/lib/tracking";
import type { WatchLogDay } from "@/lib/watchlog";
import { WATCH_KIND } from "@/lib/watchlog";

import {
  computeAllTimeCounts,
  computeDecadeCounts,
  computeGenreCounts,
  computeHeatmap,
  computeRatingComparison,
  computeRatingDistribution,
  computeThisYearCounts,
  computeTopShows,
  computeWatchTime,
} from "./aggregate";

/* ---------------------------------------------------------------------------
 * Fixture builders
 * ------------------------------------------------------------------------ */

function movieEntry(
  id: string,
  options: { status?: TrackingEntry["status"]; year?: number | null; genres?: string[]; rating?: number | null; runtimeMinutes?: number | null } = {},
): MovieTrackingEntry {
  return {
    id,
    mediaType: "movie",
    status: options.status ?? "watched",
    addedAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    runtimeMinutes: options.runtimeMinutes ?? null,
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
    watchedEpisodeCount?: number;
    knownEpisodeCount?: number | null;
    name?: string;
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
      name: options.name ?? `Show ${id}`,
      year: options.year === undefined ? 2000 : options.year,
      overview: "",
      genres: (options.genres ?? []).map((g) => ({ id: g, name: g })),
      posterUrl: null,
      placeholder: { gradientFrom: "#000", gradientTo: "#111" },
      rating: 7,
    },
  };
}

function rating(id: string, score: number | null): RatingEntry {
  return { id, mediaType: "movie", score, note: "", updatedAt: new Date("2026-01-01") };
}

/* ---------------------------------------------------------------------------
 * Genre / decade breakdowns
 * ------------------------------------------------------------------------ */

describe("computeGenreCounts", () => {
  it("counts occurrences across genres, sorted descending", () => {
    const entries: TrackingEntry[] = [
      movieEntry("1", { genres: ["action", "drama"] }),
      movieEntry("2", { genres: ["action"] }),
      tvEntry("3", { genres: ["drama"] }),
    ];
    expect(computeGenreCounts(entries)).toEqual([
      { id: "action", name: "action", count: 2 },
      { id: "drama", name: "drama", count: 2 },
    ]);
  });

  it("ignores watchlisted (not started) entries", () => {
    const entries: TrackingEntry[] = [movieEntry("1", { genres: ["action"], status: "watchlist" })];
    expect(computeGenreCounts(entries)).toEqual([]);
  });
});

describe("computeDecadeCounts", () => {
  it("buckets by decade and skips unknown years", () => {
    const entries: TrackingEntry[] = [
      movieEntry("1", { year: 1994 }),
      movieEntry("2", { year: 1999 }),
      movieEntry("3", { year: 2001 }),
      movieEntry("4", { year: null }),
    ];
    expect(computeDecadeCounts(entries)).toEqual([
      { decade: 1990, count: 2 },
      { decade: 2000, count: 1 },
    ]);
  });
});

/* ---------------------------------------------------------------------------
 * Top shows
 * ------------------------------------------------------------------------ */

describe("computeTopShows", () => {
  it("ranks by episodes watched, excludes zero, respects the limit", () => {
    const entries: TrackingEntry[] = [
      tvEntry("1", { watchedEpisodeCount: 5, name: "Small" }),
      tvEntry("2", { watchedEpisodeCount: 50, name: "Big", status: "watching" }),
      tvEntry("3", { watchedEpisodeCount: 0, name: "Untouched" }),
      movieEntry("4"), // never counted, not a show
    ];
    expect(computeTopShows(entries, 1)).toEqual([{ id: "2", name: "Big", episodesWatched: 50 }]);
    expect(computeTopShows(entries, 10).map((s) => s.id)).toEqual(["2", "1"]);
  });

  it("falls back to knownEpisodeCount for a coarse whole-show mark", () => {
    const entries: TrackingEntry[] = [tvEntry("1", { status: "watched", knownEpisodeCount: 24 })];
    expect(computeTopShows(entries, 10)).toEqual([{ id: "1", name: "Show 1", episodesWatched: 24 }]);
  });
});

/* ---------------------------------------------------------------------------
 * Watch time
 * ------------------------------------------------------------------------ */

describe("computeWatchTime", () => {
  it("sums flat-rate episode time and real (or fallback) movie runtime", () => {
    const entries: TrackingEntry[] = [
      tvEntry("1", { watchedEpisodeCount: 10 }), // 10 * 45 = 450
      movieEntry("2", { runtimeMinutes: 120 }), // real runtime
      movieEntry("3", { runtimeMinutes: null }), // falls back to 100
    ];
    const result = computeWatchTime(entries);
    expect(result.totalMinutes).toBe(450 + 120 + 100);
    expect(result.totalHours).toBe(Math.round(670 / 60));
    expect(result.totalDays).toBeCloseTo(670 / 60 / 24, 1);
  });

  it("excludes a movie that hasn't been watched", () => {
    const entries: TrackingEntry[] = [movieEntry("1", { status: "watchlist", runtimeMinutes: 120 })];
    expect(computeWatchTime(entries).totalMinutes).toBe(0);
  });

  it("counts a 'watching' show's episodes even though the show isn't finished", () => {
    const entries: TrackingEntry[] = [tvEntry("1", { status: "watching", watchedEpisodeCount: 3 })];
    expect(computeWatchTime(entries).totalMinutes).toBe(3 * 45);
  });
});

describe("computeAllTimeCounts", () => {
  it("counts watched movies and all episodes watched across every tv entry", () => {
    const entries: TrackingEntry[] = [
      movieEntry("1", { status: "watched" }),
      movieEntry("2", { status: "watchlist" }),
      tvEntry("3", { status: "watching", watchedEpisodeCount: 7 }),
    ];
    expect(computeAllTimeCounts(entries)).toEqual({ episodes: 7, movies: 1 });
  });
});

describe("computeThisYearCounts", () => {
  it("delegates to lib/watchlog totals()", () => {
    const days: WatchLogDay[] = [
      [{ k: WATCH_KIND.EPISODE, t: "tv:1", s: 1, e: 1 }, { k: WATCH_KIND.MOVIE, t: "movie:1" }],
    ];
    expect(computeThisYearCounts(days)).toEqual({ episodes: 1, movies: 1 });
  });
});

/* ---------------------------------------------------------------------------
 * Ratings
 * ------------------------------------------------------------------------ */

describe("computeRatingDistribution", () => {
  it("buckets into 10-point ranges, folding 100 into the last bucket", () => {
    const ratings = [rating("1", 5), rating("2", 15), rating("3", 100), rating("4", 95), rating("5", null)];
    const dist = computeRatingDistribution(ratings);
    expect(dist[0]).toEqual({ label: "0-9", count: 1 });
    expect(dist[1]).toEqual({ label: "10-19", count: 1 });
    expect(dist[9]).toEqual({ label: "90-100", count: 2 });
    expect(dist.reduce((sum, b) => sum + b.count, 0)).toBe(4); // the null score is excluded
  });
});

describe("computeRatingComparison", () => {
  it("averages only titles with BOTH a user score and a TMDB rating", () => {
    const entries: Record<string, TrackingEntry> = {
      "movie:1": movieEntry("1", { rating: 8 }), // 80 on a 100 scale
      "movie:2": movieEntry("2", { rating: 6 }), // 60
      "movie:3": movieEntry("3", { rating: null }), // excluded — no TMDB rating
    };
    const ratingEntries: Record<string, RatingEntry> = {
      "movie:1": rating("1", 100),
      "movie:2": rating("2", 40),
      "movie:3": rating("3", 90), // excluded, matches entry 3
      "movie:404": rating("404", 50), // excluded, no matching tracked entry
    };
    const result = computeRatingComparison(entries, ratingEntries);
    expect(result.sampleSize).toBe(2);
    expect(result.userAverage).toBe((100 + 40) / 2);
    expect(result.tmdbAverage).toBe((80 + 60) / 2);
  });

  it("returns nulls with a zero sample when nothing matches", () => {
    expect(computeRatingComparison({}, {})).toEqual({ userAverage: null, tmdbAverage: null, sampleSize: 0 });
  });
});

/* ---------------------------------------------------------------------------
 * Heatmap
 * ------------------------------------------------------------------------ */

describe("computeHeatmap", () => {
  it("returns every day of the year, zero-filled where the log has nothing", () => {
    const days = computeHeatmap([], "2025");
    expect(days).toHaveLength(365); // 2025 is not a leap year
    expect(days[0].day).toBe("2025-01-01");
    expect(days[days.length - 1].day).toBe("2025-12-31");
    expect(days.every((d) => d.count === 0)).toBe(true);
  });

  it("handles a leap year correctly", () => {
    expect(computeHeatmap([], "2028")).toHaveLength(366);
  });

  it("sums event counts for matching days and ignores other years", () => {
    const entries: [string, WatchLogDay][] = [
      ["2026-03-15", [{ k: WATCH_KIND.MOVIE, t: "movie:1" }, { k: WATCH_KIND.MOVIE, t: "movie:2" }]],
      ["2025-03-15", [{ k: WATCH_KIND.MOVIE, t: "movie:3" }]], // different year, ignored
    ];
    const days = computeHeatmap(entries, "2026");
    const target = days.find((d) => d.day === "2026-03-15")!;
    expect(target.count).toBe(2);
  });

  it("is correct across a DST spring-forward year without skipping or duplicating a day", () => {
    // 2026-03-08 is the US spring-forward date used elsewhere in this suite.
    const days = computeHeatmap([], "2026");
    const keys = days.map((d) => d.day);
    expect(new Set(keys).size).toBe(keys.length); // no duplicates
    expect(keys).toContain("2026-03-07");
    expect(keys).toContain("2026-03-08");
    expect(keys).toContain("2026-03-09");
    expect(days).toHaveLength(365);
  });
});
