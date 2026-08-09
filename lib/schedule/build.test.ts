import { describe, expect, it } from "vitest";

import type { Episode, TitleSummary } from "@/lib/content/types";
import type { SeasonEpisodeCounts, TrackingEntry, TvTrackingEntry } from "@/lib/tracking";

import { buildScheduleItems, groupSchedule, selectScheduleCandidates } from "./build";

const TODAY = "2026-07-30";

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
  status?: TvTrackingEntry["status"];
  watchedEpisodes?: TvTrackingEntry["watchedEpisodes"];
}): TvTrackingEntry {
  return {
    id: opts.id,
    mediaType: "tv",
    status: opts.status ?? "watching",
    addedAt: new Date(TODAY),
    updatedAt: new Date(TODAY),
    summary: summary(opts.id, opts.id),
    watchedEpisodes: opts.watchedEpisodes ?? {},
    knownEpisodeCount: null,
  };
}

function ep(
  seasonNumber: number,
  episodeNumber: number,
  airDate: string | null,
): Episode {
  return {
    id: `s${seasonNumber}e${episodeNumber}`,
    seasonNumber,
    episodeNumber,
    name: `Episode ${episodeNumber}`,
    overview: "",
    airDate,
    runtimeMinutes: 30,
    stillUrl: null,
  };
}

describe("selectScheduleCandidates", () => {
  const seasons: SeasonEpisodeCounts = [{ seasonNumber: 1, episodeCount: 10 }];

  it("includes watching AND watched TV shows", () => {
    const entries: Record<string, TrackingEntry> = {
      "tv:a": tvEntry({ id: "a", status: "watching" }),
      "tv:b": tvEntry({ id: "b", status: "watched", watchedEpisodes: { 1: [[1, 9]] } }),
    };
    const candidates = selectScheduleCandidates(entries, { a: seasons, b: seasons });
    expect(candidates.map((c) => c.entry.id).sort()).toEqual(["a", "b"]);
  });

  it("excludes watchlist — nothing started yet, so nothing to have missed", () => {
    const entries: Record<string, TrackingEntry> = {
      "tv:a": tvEntry({ id: "a", status: "watchlist" }),
    };
    expect(selectScheduleCandidates(entries, { a: seasons })).toEqual([]);
  });

  it("excludes movies", () => {
    const entries: Record<string, TrackingEntry> = {
      "movie:x": {
        id: "x",
        mediaType: "movie",
        status: "watching",
        addedAt: new Date(TODAY),
        updatedAt: new Date(TODAY),
        summary: summary("x", "X"),
        runtimeMinutes: 120,
      },
    };
    expect(selectScheduleCandidates(entries, { x: seasons })).toEqual([]);
  });

  it("excludes a show with no season data yet (fetch pending or failed)", () => {
    const entries: Record<string, TrackingEntry> = {
      "tv:a": tvEntry({ id: "a" }),
    };
    expect(selectScheduleCandidates(entries, {})).toEqual([]);
  });

  it("excludes a fully caught-up show — the 'ended' and 'between seasons' cases both land here", () => {
    const entries: Record<string, TrackingEntry> = {
      "tv:a": tvEntry({ id: "a", status: "watched", watchedEpisodes: { 1: [[1, 10]] } }),
    };
    expect(selectScheduleCandidates(entries, { a: seasons })).toEqual([]);
  });

  it("a coarse 'watched' (empty ranges) is reconciled before checking, not treated as zero watched", () => {
    const entries: Record<string, TrackingEntry> = {
      "tv:a": tvEntry({ id: "a", status: "watched" }), // watchedEpisodes: {}
    };
    // Reconciled to "all 10 known episodes watched", so nothing is next.
    expect(selectScheduleCandidates(entries, { a: seasons })).toEqual([]);
  });

  it("a watched show gains a candidate the moment a new season appears in season data", () => {
    const grown: SeasonEpisodeCounts = [
      { seasonNumber: 1, episodeCount: 10 },
      { seasonNumber: 2, episodeCount: 8 },
    ];
    const entries: Record<string, TrackingEntry> = {
      "tv:a": tvEntry({ id: "a", status: "watched", watchedEpisodes: { 1: [[1, 10]] } }),
    };
    const candidates = selectScheduleCandidates(entries, { a: grown });
    expect(candidates).toEqual([{ entry: entries["tv:a"], seasonNumber: 2, episodeNumber: 1 }]);
  });
});

describe("buildScheduleItems", () => {
  const entry = tvEntry({ id: "a" });
  const candidates = [{ entry, seasonNumber: 1, episodeNumber: 3 }];

  it("drops a candidate whose episode fetch hasn't resolved yet", () => {
    expect(buildScheduleItems(candidates, {}, TODAY)).toEqual([]);
    expect(buildScheduleItems(candidates, { a: null }, TODAY)).toEqual([]);
  });

  it("drops a candidate whose target episode isn't in the fetched season (shouldn't happen, but no throw)", () => {
    const episodes = [ep(1, 1, "2020-01-01")];
    expect(buildScheduleItems(candidates, { a: episodes }, TODAY)).toEqual([]);
  });

  it("buckets an already-aired episode as 'ready'", () => {
    const episodes = [ep(1, 3, "2026-07-29")];
    const items = buildScheduleItems(candidates, { a: episodes }, TODAY);
    expect(items).toHaveLength(1);
    expect(items[0].bucket).toBe("ready");
  });

  it("buckets a same-day episode as 'ready', not a separate 'today' bucket", () => {
    const episodes = [ep(1, 3, TODAY)];
    const items = buildScheduleItems(candidates, { a: episodes }, TODAY);
    expect(items[0].bucket).toBe("ready");
  });

  it("buckets an unknown air date as 'ready' — matches isFutureAirDate's own null handling", () => {
    const episodes = [ep(1, 3, null)];
    const items = buildScheduleItems(candidates, { a: episodes }, TODAY);
    expect(items[0].bucket).toBe("ready");
  });

  it("buckets tomorrow through +7 days as 'this-week'", () => {
    const tomorrow = ep(1, 3, "2026-07-31");
    const sevenOut = ep(1, 3, "2026-08-06");
    expect(buildScheduleItems(candidates, { a: [tomorrow] }, TODAY)[0].bucket).toBe("this-week");
    expect(buildScheduleItems(candidates, { a: [sevenOut] }, TODAY)[0].bucket).toBe("this-week");
  });

  it("buckets beyond 7 days as 'later'", () => {
    const eightOut = ep(1, 3, "2026-08-07");
    expect(buildScheduleItems(candidates, { a: [eightOut] }, TODAY)[0].bucket).toBe("later");
  });
});

describe("groupSchedule", () => {
  const showA = tvEntry({ id: "a" });
  const showB = tvEntry({ id: "b" });
  const showC = tvEntry({ id: "c" });

  it("splits by bucket and sorts ready newest-first, upcoming soonest-first", () => {
    const items = buildScheduleItems(
      [
        { entry: showA, seasonNumber: 1, episodeNumber: 1 },
        { entry: showB, seasonNumber: 1, episodeNumber: 1 },
        { entry: showC, seasonNumber: 1, episodeNumber: 1 },
      ],
      {
        a: [ep(1, 1, "2026-07-20")], // ready, older
        b: [ep(1, 1, "2026-07-29")], // ready, newer
        c: [ep(1, 1, "2026-08-10")], // later
      },
      TODAY,
    );

    const feed = groupSchedule(items);
    expect(feed.ready.map((i) => i.entry.id)).toEqual(["b", "a"]);
    expect(feed.thisWeek).toEqual([]);
    expect(feed.later.map((i) => i.entry.id)).toEqual(["c"]);
  });

  it("sorts a null air date to the bottom of 'ready' rather than the top", () => {
    const items = buildScheduleItems(
      [
        { entry: showA, seasonNumber: 1, episodeNumber: 1 },
        { entry: showB, seasonNumber: 1, episodeNumber: 1 },
      ],
      {
        a: [ep(1, 1, null)],
        b: [ep(1, 1, "2026-07-29")],
      },
      TODAY,
    );

    const feed = groupSchedule(items);
    expect(feed.ready.map((i) => i.entry.id)).toEqual(["b", "a"]);
  });
});
