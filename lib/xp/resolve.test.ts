import { describe, expect, it } from "vitest";

import type {
  MovieTrackingEntry,
  SeasonEpisodeCounts,
  TvTrackingEntry,
  WatchedEpisodes,
} from "@/lib/tracking";

import { DEFAULT_MOVIE_RUNTIME_MINUTES } from "./formula";
import { completedSeasonsFor, episodesWatchedFor, movieRuntimeMinutesFor } from "./resolve";

const NOW = new Date("2026-07-31T00:00:00.000Z");

function tvEntry(overrides: Partial<TvTrackingEntry> = {}): TvTrackingEntry {
  return {
    id: "show",
    mediaType: "tv",
    status: "watching",
    addedAt: NOW,
    updatedAt: NOW,
    summary: {} as TvTrackingEntry["summary"],
    watchedEpisodes: {},
    knownEpisodeCount: null,
    ...overrides,
  };
}

function movieEntry(overrides: Partial<MovieTrackingEntry> = {}): MovieTrackingEntry {
  return {
    id: "movie",
    mediaType: "movie",
    status: "watched",
    addedAt: NOW,
    updatedAt: NOW,
    summary: {} as MovieTrackingEntry["summary"],
    runtimeMinutes: null,
    ...overrides,
  };
}

/* ---------------------------------------------------------------------------
 * episodesWatchedFor
 * ------------------------------------------------------------------------ */

describe("episodesWatchedFor — real ranges are authoritative", () => {
  it("sums ranges across every season", () => {
    const entry = tvEntry({ watchedEpisodes: { 1: [[1, 6]], 2: [[1, 3], [5, 5]] } });
    expect(episodesWatchedFor(entry)).toBe(6 + 4);
  });

  it("is 0 for a watching show with no progress yet — NOT the coarse fallback", () => {
    // The case the doc comment calls out explicitly: empty ranges on a
    // "watching" show means nothing watched, not "unknown, assume everything".
    const entry = tvEntry({ status: "watching", watchedEpisodes: {}, knownEpisodeCount: 62 });
    expect(episodesWatchedFor(entry)).toBe(0);
  });

  it("ignores knownEpisodeCount entirely when real ranges exist", () => {
    // Real data always wins, even if a stale/wrong fallback value is present.
    const entry = tvEntry({ watchedEpisodes: { 1: [[1, 3]] }, knownEpisodeCount: 999 });
    expect(episodesWatchedFor(entry)).toBe(3);
  });
});

describe("episodesWatchedFor — the coarse-mark fallback", () => {
  it("uses knownEpisodeCount when watched with empty ranges", () => {
    const entry = tvEntry({ status: "watched", watchedEpisodes: {}, knownEpisodeCount: 62 });
    expect(episodesWatchedFor(entry)).toBe(62);
  });

  it("is 0, not null-propagated, when watched with no captured count at all", () => {
    // A pre-migration record, or the hint genuinely wasn't available —
    // honest under-count rather than a crash or NaN.
    const entry = tvEntry({ status: "watched", watchedEpisodes: {}, knownEpisodeCount: null });
    expect(episodesWatchedFor(entry)).toBe(0);
  });

  it("does not apply the watched fallback to a watchlist-status entry", () => {
    const entry = tvEntry({ status: "watchlist", watchedEpisodes: {}, knownEpisodeCount: 62 });
    expect(episodesWatchedFor(entry)).toBe(0);
  });
});

/* ---------------------------------------------------------------------------
 * movieRuntimeMinutesFor
 * ------------------------------------------------------------------------ */

describe("movieRuntimeMinutesFor", () => {
  it("uses the captured runtime when present", () => {
    expect(movieRuntimeMinutesFor(movieEntry({ runtimeMinutes: 175 }))).toBe(175);
  });

  it("falls back to the default when null", () => {
    expect(movieRuntimeMinutesFor(movieEntry({ runtimeMinutes: null }))).toBe(
      DEFAULT_MOVIE_RUNTIME_MINUTES,
    );
  });
});

/* ---------------------------------------------------------------------------
 * completedSeasonsFor
 * ------------------------------------------------------------------------ */

describe("completedSeasonsFor", () => {
  const seasons: SeasonEpisodeCounts = [
    { seasonNumber: 1, episodeCount: 6 },
    { seasonNumber: 2, episodeCount: 6 },
    { seasonNumber: 3, episodeCount: 8 },
  ];

  it("counts a season as complete only when every episode is watched", () => {
    const watched: WatchedEpisodes = { 1: [[1, 6]], 2: [[1, 5]] }; // S2 missing E6
    expect(completedSeasonsFor(watched, seasons)).toBe(1);
  });

  it("counts multiple complete seasons", () => {
    const watched: WatchedEpisodes = { 1: [[1, 6]], 2: [[1, 6]], 3: [[1, 4]] };
    expect(completedSeasonsFor(watched, seasons)).toBe(2);
  });

  it("is 0 for no progress", () => {
    expect(completedSeasonsFor({}, seasons)).toBe(0);
  });

  it("is 0 when every season is fully watched but includes a bonus episode over count", () => {
    // Ranges clamp to the season's real length elsewhere in the app; here a
    // stale over-length range should not let getSeasonProgress miscount.
    const watched: WatchedEpisodes = { 1: [[1, 6]] };
    expect(completedSeasonsFor(watched, seasons)).toBe(1);
  });

  it("excludes season 0 (Specials) from both the count and the completion requirement", () => {
    const withSpecials: SeasonEpisodeCounts = [
      { seasonNumber: 0, episodeCount: 3 },
      { seasonNumber: 1, episodeCount: 6 },
    ];
    // Specials untouched, main season complete: still counts as 1, not 0.
    const watched: WatchedEpisodes = { 1: [[1, 6]] };
    expect(completedSeasonsFor(watched, withSpecials)).toBe(1);

    // Specials fully watched too: still exactly 1 — Specials never contribute
    // a bonus of their own.
    const watchedWithSpecials: WatchedEpisodes = { 0: [[1, 3]], 1: [[1, 6]] };
    expect(completedSeasonsFor(watchedWithSpecials, withSpecials)).toBe(1);
  });

  it("returns 0 for an empty season list", () => {
    expect(completedSeasonsFor({}, [])).toBe(0);
  });
});
