import { describe, expect, it } from "vitest";

import type { Episode, TitleSummary } from "@/lib/content/types";

import {
  buildUpNextItem,
  DEFAULT_EPISODE_RUNTIME_MINUTES,
  RANKING_WEIGHTS,
  rankUpNext,
  REDISCOVERY_DORMANT_DAYS,
  selectUpNextCandidates,
  type UpNextItem,
} from "./upnext";
import type { SeasonEpisodeCounts, TrackingEntry, TvTrackingEntry } from "./types";

const NOW = new Date("2026-07-30T00:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

function summary(id: string, name: string): TitleSummary {
  return {
    id,
    mediaType: "tv",
    name,
    year: 2020,
    overview: "",
    genres: [],
    posterUrl: null,
    placeholder: { gradientFrom: "#111111", gradientTo: "#222222" },
    rating: null,
  };
}

function tvEntry(opts: {
  id: string;
  name?: string;
  status?: TvTrackingEntry["status"];
  watchedEpisodes?: TvTrackingEntry["watchedEpisodes"];
  updatedAt?: Date;
}): TvTrackingEntry {
  const updatedAt = opts.updatedAt ?? NOW;
  return {
    id: opts.id,
    mediaType: "tv",
    status: opts.status ?? "watching",
    addedAt: updatedAt,
    updatedAt,
    summary: summary(opts.id, opts.name ?? opts.id),
    watchedEpisodes: opts.watchedEpisodes ?? {},
    knownEpisodeCount: null,
  };
}

function ep(
  seasonNumber: number,
  episodeNumber: number,
  opts: { airDate?: string | null; runtimeMinutes?: number | null; name?: string } = {},
): Episode {
  return {
    id: `s${seasonNumber}e${episodeNumber}`,
    seasonNumber,
    episodeNumber,
    name: opts.name ?? `Episode ${episodeNumber}`,
    overview: "",
    airDate: opts.airDate === undefined ? "2020-01-01" : opts.airDate,
    runtimeMinutes: opts.runtimeMinutes === undefined ? 30 : opts.runtimeMinutes,
    stillUrl: null,
  };
}

const FUTURE_DATE = "2099-01-01";

describe("selectUpNextCandidates", () => {
  it("only considers TV entries with status watching", () => {
    const seasons: SeasonEpisodeCounts = [{ seasonNumber: 1, episodeCount: 10 }];
    const entries: Record<string, TrackingEntry> = {
      "tv:watching-show": tvEntry({ id: "watching-show", status: "watching" }),
      "tv:watchlist-show": tvEntry({ id: "watchlist-show", status: "watchlist" }),
      "tv:watched-show": tvEntry({ id: "watched-show", status: "watched" }),
      "movie:some-movie": {
        id: "some-movie",
        mediaType: "movie",
        // The app's UI never offers "watching" for a movie, but the type
        // permits it — this exercises the mediaType filter specifically,
        // independent of the status filter.
        status: "watching",
        addedAt: NOW,
        updatedAt: NOW,
        summary: summary("some-movie", "Some Movie"),
        runtimeMinutes: null,
      },
    };
    const seasonsByShowId = {
      "watching-show": seasons,
      "watchlist-show": seasons,
      "watched-show": seasons,
      "some-movie": seasons,
    };

    const candidates = selectUpNextCandidates(entries, seasonsByShowId);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].entry.id).toBe("watching-show");
  });

  it("skips shows with no season data available yet", () => {
    const entries: Record<string, TrackingEntry> = {
      "tv:no-seasons": tvEntry({ id: "no-seasons" }),
    };

    expect(selectUpNextCandidates(entries, {})).toEqual([]);
  });

  it("never offers a Season 0 episode as next (Twin Peaks shape)", () => {
    const seasons: SeasonEpisodeCounts = [
      { seasonNumber: 0, episodeCount: 3 },
      { seasonNumber: 1, episodeCount: 8 },
    ];
    // Specials fully watched, main run untouched.
    const entries: Record<string, TrackingEntry> = {
      "tv:twin-peaks": tvEntry({
        id: "twin-peaks",
        watchedEpisodes: { 0: [[1, 3]] },
      }),
    };

    const candidates = selectUpNextCandidates(entries, { "twin-peaks": seasons });

    expect(candidates).toEqual([
      expect.objectContaining({ seasonNumber: 1, episodeNumber: 1 }),
    ]);
  });

  it("produces no candidate once a truncated final season is fully watched (True Detective shape)", () => {
    const seasons: SeasonEpisodeCounts = [
      { seasonNumber: 1, episodeCount: 8 },
      { seasonNumber: 2, episodeCount: 3 }, // canceled mid-season
    ];
    const entries: Record<string, TrackingEntry> = {
      "tv:true-detective": tvEntry({
        id: "true-detective",
        watchedEpisodes: { 1: [[1, 8]], 2: [[1, 3]] },
      }),
    };

    expect(selectUpNextCandidates(entries, { "true-detective": seasons })).toEqual([]);
  });
});

describe("buildUpNextItem — signals", () => {
  it("computes waitingInSeason from aired-and-unwatched episodes in the fetched season only", () => {
    const seasons: SeasonEpisodeCounts = [{ seasonNumber: 1, episodeCount: 20 }];
    const entry = tvEntry({ id: "show", watchedEpisodes: { 1: [[1, 8]] } });
    const episodes = [
      ...Array.from({ length: 8 }, (_, i) => ep(1, i + 1)), // watched
      ep(1, 9), // aired, unwatched
      ep(1, 10), // aired, unwatched
      ...Array.from({ length: 10 }, (_, i) => ep(1, i + 11, { airDate: FUTURE_DATE })), // unaired
    ];

    const item = buildUpNextItem(
      { entry, seasonNumber: 1, episodeNumber: 9 },
      seasons,
      episodes,
      NOW,
    );

    expect(item.signals.waitingInSeason).toBe(2);
  });

  it("floors waitingInSeason to 1 when the season's episodes haven't loaded", () => {
    const seasons: SeasonEpisodeCounts = [{ seasonNumber: 1, episodeCount: 10 }];
    const entry = tvEntry({ id: "show" });

    const item = buildUpNextItem({ entry, seasonNumber: 1, episodeNumber: 1 }, seasons, null, NOW);

    expect(item.signals.waitingInSeason).toBe(1);
    expect(item.episode).toBeNull();
  });

  it("computes remainingInSeries across the whole show, not just the current season", () => {
    const seasons: SeasonEpisodeCounts = [
      { seasonNumber: 1, episodeCount: 10 },
      { seasonNumber: 2, episodeCount: 10 },
    ];
    const entry = tvEntry({ id: "show", watchedEpisodes: { 1: [[1, 10]], 2: [[1, 3]] } });

    const item = buildUpNextItem(
      { entry, seasonNumber: 2, episodeNumber: 4 },
      seasons,
      [ep(2, 4)],
      NOW,
    );

    expect(item.signals.remainingInSeries).toBe(7); // 20 total - 13 watched
  });

  it("computes daysSinceLastWatched against the injected now", () => {
    const seasons: SeasonEpisodeCounts = [{ seasonNumber: 1, episodeCount: 10 }];
    const entry = tvEntry({ id: "show", updatedAt: daysAgo(9) });

    const item = buildUpNextItem({ entry, seasonNumber: 1, episodeNumber: 1 }, seasons, [ep(1, 1)], NOW);

    expect(item.signals.daysSinceLastWatched).toBe(9);
  });

  it("falls back to the default runtime when every fetched episode lacks one", () => {
    const seasons: SeasonEpisodeCounts = [{ seasonNumber: 1, episodeCount: 5 }];
    const entry = tvEntry({ id: "show" });
    // A single waiting episode so the expected minutes equal the default
    // runtime directly, isolating the fallback from the multiplication
    // tested separately below.
    const episodes = [ep(1, 1, { runtimeMinutes: null })];

    const item = buildUpNextItem({ entry, seasonNumber: 1, episodeNumber: 1 }, seasons, episodes, NOW);

    expect(item.signals.waitingInSeason).toBe(1);
    expect(item.signals.estimatedMinutesToFinishSeason).toBe(DEFAULT_EPISODE_RUNTIME_MINUTES);
  });

  it("uses the real average runtime when episodes carry one", () => {
    const seasons: SeasonEpisodeCounts = [{ seasonNumber: 1, episodeCount: 5 }];
    const entry = tvEntry({ id: "show" });
    // waitingInSeason will be 2 (both aired, unwatched); avg runtime 40.
    const episodes = [
      ep(1, 1, { runtimeMinutes: 30 }),
      ep(1, 2, { runtimeMinutes: 50 }),
    ];

    const item = buildUpNextItem({ entry, seasonNumber: 1, episodeNumber: 1 }, seasons, episodes, NOW);

    expect(item.signals.waitingInSeason).toBe(2);
    expect(item.signals.estimatedMinutesToFinishSeason).toBe(80); // 2 * 40
  });

  it("marks airingState 'airing' when the target episode hasn't aired yet", () => {
    const seasons: SeasonEpisodeCounts = [{ seasonNumber: 1, episodeCount: 4 }];
    const entry = tvEntry({ id: "the-bear", watchedEpisodes: { 1: [[1, 3]] } });
    const episodes = [ep(1, 4, { airDate: FUTURE_DATE })];

    const item = buildUpNextItem({ entry, seasonNumber: 1, episodeNumber: 4 }, seasons, episodes, NOW);

    expect(item.signals.airingState).toBe("airing");
  });

  it("marks airingState 'between-seasons' when a later season is already known", () => {
    const seasons: SeasonEpisodeCounts = [
      { seasonNumber: 1, episodeCount: 4 },
      { seasonNumber: 2, episodeCount: 4 },
    ];
    const entry = tvEntry({ id: "show", watchedEpisodes: { 1: [[1, 3]] } });
    const episodes = [ep(1, 4)]; // aired, unwatched

    const item = buildUpNextItem({ entry, seasonNumber: 1, episodeNumber: 4 }, seasons, episodes, NOW);

    expect(item.signals.airingState).toBe("between-seasons");
  });

  it("marks airingState 'ended' with no later season and an aired target episode", () => {
    const seasons: SeasonEpisodeCounts = [{ seasonNumber: 1, episodeCount: 4 }];
    const entry = tvEntry({ id: "show", watchedEpisodes: { 1: [[1, 3]] } });
    const episodes = [ep(1, 4)];

    const item = buildUpNextItem({ entry, seasonNumber: 1, episodeNumber: 4 }, seasons, episodes, NOW);

    expect(item.signals.airingState).toBe("ended");
  });
});

describe("buildUpNextItem — score", () => {
  it("matches the worked examples from the ranking design", () => {
    const cases: { name: string; waiting: number; seasonPct: number; days: number; expected: number }[] = [
      { name: "watched last night, small backlog", waiting: 2, seasonPct: 0, days: 0, expected: 8.49 },
      { name: "watched last night, 1 left", waiting: 1, seasonPct: 0, days: 0, expected: 6.0 },
      { name: "abandoned 2 months, big backlog", waiting: 20, seasonPct: 0, days: 60, expected: 3.06 },
      { name: "abandoned 2 weeks, near season end", waiting: 1, seasonPct: 95, days: 14, expected: 5.59 },
      { name: "watched 2 days ago, near season end", waiting: 1, seasonPct: 95, days: 2, expected: 11.2 },
      { name: "watched a week ago, moderate backlog", waiting: 3, seasonPct: 0, days: 7, expected: 6.79 },
      { name: "pathological huge backlog, 6mo dormant", waiting: 100, seasonPct: 0, days: 180, expected: 6.0 },
    ];

    for (const { name, waiting, seasonPct, days, expected } of cases) {
      // seasonPct is achieved via episodeCount/watchedCount directly, waiting
      // via a hand-built episode list sized to match — see helper below.
      const episodeCount = 100; // large denominator so percent is exact and independent of `waiting`
      const watchedCount = Math.round((seasonPct / 100) * episodeCount);
      const seasons: SeasonEpisodeCounts = [{ seasonNumber: 1, episodeCount }];
      const entry = tvEntry({
        id: name,
        watchedEpisodes: watchedCount > 0 ? { 1: [[1, watchedCount]] } : {},
        updatedAt: daysAgo(days),
      });
      const episodeNumber = watchedCount + 1;
      const episodes = Array.from({ length: waiting }, (_, i) => ep(1, episodeNumber + i));

      const item = buildUpNextItem({ entry, seasonNumber: 1, episodeNumber }, seasons, episodes, NOW);

      expect(item.signals.waitingInSeason, name).toBe(waiting);
      expect(item.score, name).toBeCloseTo(expected, 1);
    }
  });

  it("ranks a recently-watched show with a small backlog above a long-dormant show with a large one", () => {
    const seasons: SeasonEpisodeCounts = [{ seasonNumber: 1, episodeCount: 100 }];

    const recent = buildUpNextItem(
      { entry: tvEntry({ id: "recent", updatedAt: daysAgo(0) }), seasonNumber: 1, episodeNumber: 1 },
      seasons,
      [ep(1, 1), ep(1, 2)],
      NOW,
    );
    const dormant = buildUpNextItem(
      { entry: tvEntry({ id: "dormant", updatedAt: daysAgo(60) }), seasonNumber: 1, episodeNumber: 1 },
      seasons,
      Array.from({ length: 20 }, (_, i) => ep(1, i + 1)),
      NOW,
    );

    expect(recent.score).toBeGreaterThan(dormant.score);
  });
});

describe("buildUpNextItem — label", () => {
  const seasons: SeasonEpisodeCounts = [{ seasonNumber: 1, episodeCount: 10 }];

  it("labels a season premiere that hasn't aired yet", () => {
    const entry = tvEntry({ id: "show" });
    const item = buildUpNextItem(
      { entry, seasonNumber: 2, episodeNumber: 1 },
      [{ seasonNumber: 1, episodeCount: 10 }, { seasonNumber: 2, episodeCount: 10 }],
      [ep(2, 1, { airDate: FUTURE_DATE })],
      NOW,
    );
    expect(item.label).toMatch(/^Season 2 starts /);
  });

  it("labels a mid-season episode that hasn't aired yet", () => {
    const entry = tvEntry({ id: "show", watchedEpisodes: { 1: [[1, 3]] } });
    const item = buildUpNextItem(
      { entry, seasonNumber: 1, episodeNumber: 4 },
      seasons,
      [ep(1, 4, { airDate: FUTURE_DATE })],
      NOW,
    );
    expect(item.label).toMatch(/^New episode airs /);
  });

  it("labels several aired-unwatched episodes as waiting", () => {
    const entry = tvEntry({ id: "show", updatedAt: NOW });
    const item = buildUpNextItem(
      { entry, seasonNumber: 1, episodeNumber: 1 },
      seasons,
      [ep(1, 1), ep(1, 2), ep(1, 3)],
      NOW,
    );
    expect(item.label).toBe("3 episodes waiting");
  });

  it("labels a near-complete season as 'left to finish'", () => {
    const entry = tvEntry({ id: "show", watchedEpisodes: { 1: [[1, 8]] }, updatedAt: NOW });
    const item = buildUpNextItem(
      { entry, seasonNumber: 1, episodeNumber: 9 },
      seasons,
      [ep(1, 9)],
      NOW,
    );
    expect(item.label).toBe("2 left to finish the season");
  });

  it("falls back to a generic S/E label when nothing else applies", () => {
    const entry = tvEntry({ id: "show", updatedAt: NOW });
    const item = buildUpNextItem(
      { entry, seasonNumber: 1, episodeNumber: 1 },
      [{ seasonNumber: 1, episodeCount: 10 }],
      // Only 1 aired-unwatched fetched, and 9 remain in the season overall
      // (unaired), so neither the "waiting" nor "finish season" branch fires.
      [ep(1, 1), ...Array.from({ length: 8 }, (_, i) => ep(1, i + 2, { airDate: FUTURE_DATE }))],
      NOW,
    );
    expect(item.label).toBe("Next: S1 · E1 — Episode 1");
  });

  it("appends how far behind the user is once past the dormancy threshold", () => {
    const entry = tvEntry({ id: "show", updatedAt: daysAgo(REDISCOVERY_DORMANT_DAYS) });
    const item = buildUpNextItem(
      { entry, seasonNumber: 1, episodeNumber: 1 },
      seasons,
      [ep(1, 1), ep(1, 2)],
      NOW,
    );
    expect(item.label).toBe("2 episodes waiting · You're 3 weeks behind");
  });
});

function fakeReadyItem(id: string, score: number, daysSinceLastWatched: number): UpNextItem {
  return {
    entry: tvEntry({ id, updatedAt: daysAgo(daysSinceLastWatched) }),
    seasonNumber: 1,
    episodeNumber: 1,
    episode: ep(1, 1), // aired -> ready bucket
    signals: {
      waitingInSeason: 1,
      remainingInSeries: 1,
      seasonPercentComplete: 0,
      daysSinceLastWatched,
      estimatedMinutesToFinishSeason: 0,
      estimatedMinutesToFinishSeries: 0,
      airingState: "ended",
    },
    label: "",
    score,
    isRediscovery: false,
  };
}

describe("rankUpNext", () => {
  it("buckets on whether the target episode has aired", () => {
    const readyItem = fakeReadyItem("ready-show", 5, 0);
    const upcomingItem: UpNextItem = {
      ...fakeReadyItem("upcoming-show", 5, 0),
      episode: ep(1, 1, { airDate: FUTURE_DATE }),
    };

    const { ready, upcoming } = rankUpNext([readyItem, upcomingItem]);

    expect(ready.map((i) => i.entry.id)).toEqual(["ready-show"]);
    expect(upcoming.map((i) => i.entry.id)).toEqual(["upcoming-show"]);
  });

  it("sorts upcoming items by air date ascending", () => {
    const later: UpNextItem = { ...fakeReadyItem("later", 0, 0), episode: ep(1, 1, { airDate: "2099-06-01" }) };
    const sooner: UpNextItem = { ...fakeReadyItem("sooner", 0, 0), episode: ep(1, 1, { airDate: "2099-01-01" }) };

    const { upcoming } = rankUpNext([later, sooner]);

    expect(upcoming.map((i) => i.entry.id)).toEqual(["sooner", "later"]);
  });

  it("sorts ready items by score descending before applying the rediscovery slot", () => {
    const items = [fakeReadyItem("low", 1, 0), fakeReadyItem("high", 10, 0)];
    const { ready } = rankUpNext(items);
    expect(ready.map((i) => i.entry.id)).toEqual(["high", "low"]);
  });

  it("repositions the most dormant qualifying candidate to index 2", () => {
    const items = [
      fakeReadyItem("a", 10, 0),
      fakeReadyItem("b", 9, 1),
      fakeReadyItem("c", 8, 2),
      fakeReadyItem("d", 1, 40),
      fakeReadyItem("e", 0.5, 100),
    ];

    const { ready } = rankUpNext(items);

    expect(ready.map((i) => i.entry.id)).toEqual(["a", "b", "e", "c", "d"]);
    expect(ready[2].isRediscovery).toBe(true);
    expect(ready.filter((i) => i.isRediscovery)).toHaveLength(1);
  });

  it("does not reposition anything when no candidate is dormant enough", () => {
    const items = [
      fakeReadyItem("a", 10, 0),
      fakeReadyItem("b", 9, 1),
      fakeReadyItem("c", 8, 2),
      fakeReadyItem("d", 1, REDISCOVERY_DORMANT_DAYS - 1),
    ];

    const { ready } = rankUpNext(items);

    expect(ready.map((i) => i.entry.id)).toEqual(["a", "b", "c", "d"]);
    expect(ready.some((i) => i.isRediscovery)).toBe(false);
  });

  it("does nothing with fewer than 3 ready items", () => {
    const items = [fakeReadyItem("a", 1, 100), fakeReadyItem("b", 2, 0)];
    const { ready } = rankUpNext(items);
    expect(ready.map((i) => i.entry.id)).toEqual(["b", "a"]);
    expect(ready.some((i) => i.isRediscovery)).toBe(false);
  });
});

describe("RANKING_WEIGHTS / constants", () => {
  it("match the values documented in the ranking design", () => {
    expect(RANKING_WEIGHTS).toEqual({
      waiting: 6,
      wrapUpThresholdPct: 70,
      wrapUp: 8,
      recencyHalfLifeDays: 10,
      recencyFloor: 0.1,
    });
    expect(REDISCOVERY_DORMANT_DAYS).toBe(21);
    expect(DEFAULT_EPISODE_RUNTIME_MINUTES).toBe(45);
  });
});
