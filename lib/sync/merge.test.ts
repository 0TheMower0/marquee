import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RatingEntry } from "@/lib/ratings/types";
import type { TitleSummary } from "@/lib/content/types";
import type { TrackingEntry, TrackingStatus, WatchedEpisodes } from "@/lib/tracking/types";
import type { WatchEvent } from "@/lib/watchlog/types";

import {
  buildMergePlan,
  emptyRemoteSnapshot,
  type LocalSnapshot,
  type RemoteSnapshot,
} from "./merge";
import { isUuid, preAccountEventId, randomUuid, uuidV5 } from "./uuid";
import type { TrackedTitleRow, WatchedEpisodeRow } from "./types";

/**
 * The merge is the one operation in this app that can destroy years of a
 * user's history, so these tests are written against the messy cases rather
 * than the happy path: overlapping ranges, the same title tracked differently
 * on each side, disagreeing ratings, notes written independently on two
 * devices, and — the one that makes "just run it again" safe — a full replay.
 */

const USER = "11111111-1111-1111-1111-111111111111";
const NOW = new Date("2026-08-07T12:00:00Z");

/** A REAL `TitleSummary`, not a loose literal. Building it properly is what
 *  caught `titleOf` reading `.title` when the field is `.name` — an error the
 *  types could not see, because the server row's `summary` is `unknown`. */
function summaryFor(id: string, mediaType: "movie" | "tv"): TitleSummary {
  return {
    id,
    mediaType,
    name: mediaType === "tv" ? `Show ${id}` : `Film ${id}`,
    year: 2020,
    overview: "",
    genres: [],
    posterUrl: null,
    placeholder: { gradientFrom: "#111", gradientTo: "#222" },
    rating: null,
  };
}

function tvEntry(
  id: string,
  status: TrackingStatus,
  watchedEpisodes: WatchedEpisodes,
  updatedAt = new Date("2026-06-01T00:00:00Z"),
): TrackingEntry {
  return {
    id,
    mediaType: "tv",
    status,
    addedAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt,
    summary: summaryFor(id, "tv"),
    watchedEpisodes,
    knownEpisodeCount: null,
  };
}

function movieEntry(
  id: string,
  status: TrackingStatus,
  updatedAt = new Date("2026-06-01T00:00:00Z"),
): TrackingEntry {
  return {
    id,
    mediaType: "movie",
    status,
    addedAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt,
    summary: summaryFor(id, "movie"),
    runtimeMinutes: null,
  };
}

function titleRow(
  titleId: string,
  status: TrackingStatus,
  overrides: Partial<TrackedTitleRow> = {},
): TrackedTitleRow {
  return {
    user_id: USER,
    media_type: "tv",
    title_id: titleId,
    status,
    summary: summaryFor(titleId, "tv"),
    runtime_minutes: null,
    known_episode_count: null,
    added_at: "2026-02-01T00:00:00.000Z",
    client_updated_at: "2026-05-01T00:00:00.000Z",
    deleted_at: null,
    ...overrides,
  };
}

function episodeRow(
  titleId: string,
  season: number,
  episode: number,
  overrides: Partial<WatchedEpisodeRow> = {},
): WatchedEpisodeRow {
  return {
    user_id: USER,
    media_type: "tv",
    title_id: titleId,
    season_number: season,
    episode_number: episode,
    client_updated_at: "2026-05-01T00:00:00.000Z",
    deleted_at: null,
    ...overrides,
  };
}

function emptyLocal(): LocalSnapshot {
  return { tracking: {}, ratings: {}, watchLog: {}, badges: {}, highestLevelSeen: 1 };
}

/* ==========================================================================
 * Episode ranges — the messiest data in the merge
 * ======================================================================= */

describe("merge: episodes", () => {
  it("unions overlapping ranges from both sides into one canonical range", async () => {
    const local = emptyLocal();
    local.tracking["tv:100"] = tvEntry("100", "watching", { 1: [[1, 5]] });

    const remote: RemoteSnapshot = {
      ...emptyRemoteSnapshot(),
      trackedTitles: [titleRow("100", "watching")],
      watchedEpisodes: [3, 4, 5, 6, 7, 8].map((e) => episodeRow("100", 1, e)),
    };

    const plan = await buildMergePlan(USER, local, remote, { now: NOW });
    const merged = plan.local.tracking["tv:100"];

    // [[1,5]] union [[3,8]] must be [[1,8]] — one range, not two overlapping
    // runs, and not a duplicated episode 3-5.
    expect(merged.mediaType === "tv" && merged.watchedEpisodes).toEqual({ 1: [[1, 8]] });
  });

  it("merges adjacent ranges across the two sides", async () => {
    const local = emptyLocal();
    local.tracking["tv:100"] = tvEntry("100", "watching", { 1: [[1, 3]] });

    const remote: RemoteSnapshot = {
      ...emptyRemoteSnapshot(),
      trackedTitles: [titleRow("100", "watching")],
      watchedEpisodes: [4, 5].map((e) => episodeRow("100", 1, e)),
    };

    const plan = await buildMergePlan(USER, local, remote, { now: NOW });
    const merged = plan.local.tracking["tv:100"];
    // Adjacency must collapse: [[1,3]] + [[4,5]] is [[1,5]], never [[1,3],[4,5]].
    expect(merged.mediaType === "tv" && merged.watchedEpisodes).toEqual({ 1: [[1, 5]] });
  });

  it("keeps genuine gaps as separate ranges", async () => {
    const local = emptyLocal();
    local.tracking["tv:100"] = tvEntry("100", "watching", { 1: [[1, 2]] });

    const remote: RemoteSnapshot = {
      ...emptyRemoteSnapshot(),
      trackedTitles: [titleRow("100", "watching")],
      watchedEpisodes: [episodeRow("100", 1, 9)],
    };

    const plan = await buildMergePlan(USER, local, remote, { now: NOW });
    const merged = plan.local.tracking["tv:100"];
    expect(merged.mediaType === "tv" && merged.watchedEpisodes).toEqual({
      1: [
        [1, 2],
        [9, 9],
      ],
    });
  });

  it("merges across different seasons independently, including season 0", async () => {
    const local = emptyLocal();
    local.tracking["tv:100"] = tvEntry("100", "watching", { 0: [[1, 1]], 2: [[1, 4]] });

    const remote: RemoteSnapshot = {
      ...emptyRemoteSnapshot(),
      trackedTitles: [titleRow("100", "watching")],
      watchedEpisodes: [episodeRow("100", 1, 1), episodeRow("100", 2, 5)],
    };

    const plan = await buildMergePlan(USER, local, remote, { now: NOW });
    const merged = plan.local.tracking["tv:100"];
    expect(merged.mediaType === "tv" && merged.watchedEpisodes).toEqual({
      0: [[1, 1]],
      1: [[1, 1]],
      2: [[1, 5]],
    });
  });

  it("ignores a remote tombstone rather than removing a local episode", async () => {
    // §6.3: the merge is structurally incapable of losing an episode. A more
    // recent un-mark still wins, but via steady-state LWW on the next pull —
    // the merge itself never throws data away.
    const local = emptyLocal();
    local.tracking["tv:100"] = tvEntry("100", "watching", { 1: [[1, 3]] });

    const remote: RemoteSnapshot = {
      ...emptyRemoteSnapshot(),
      trackedTitles: [titleRow("100", "watching")],
      watchedEpisodes: [
        episodeRow("100", 1, 2, { deleted_at: "2026-07-01T00:00:00.000Z" }),
      ],
    };

    const plan = await buildMergePlan(USER, local, remote, { now: NOW });
    const merged = plan.local.tracking["tv:100"];
    expect(merged.mediaType === "tv" && merged.watchedEpisodes).toEqual({ 1: [[1, 3]] });
  });

  it("uploads one row per episode, not per range", async () => {
    const local = emptyLocal();
    local.tracking["tv:100"] = tvEntry("100", "watched", { 1: [[1, 3]], 2: [[1, 2]] });

    const plan = await buildMergePlan(USER, local, emptyRemoteSnapshot(), { now: NOW });
    expect(plan.push.watched_episodes).toHaveLength(5);
    expect(plan.push.watched_episodes.every((row) => row.deleted_at === null)).toBe(true);
  });
});

/* ==========================================================================
 * The same title tracked differently on each side
 * ======================================================================= */

describe("merge: status", () => {
  it("takes the higher progress and reports the difference", async () => {
    const local = emptyLocal();
    local.tracking["tv:100"] = tvEntry("100", "watchlist", {});

    const remote: RemoteSnapshot = {
      ...emptyRemoteSnapshot(),
      trackedTitles: [titleRow("100", "watched")],
    };

    const plan = await buildMergePlan(USER, local, remote, { now: NOW });
    expect(plan.local.tracking["tv:100"].status).toBe("watched");
    expect(plan.summary.statusDifferences).toEqual([
      expect.objectContaining({
        key: "tv:100",
        local: "watchlist",
        remote: "watched",
        result: "watched",
      }),
    ]);
  });

  it("resurrects a deliberate downgrade, and says so in the summary", async () => {
    // The accepted failure mode of max-progress (§6.3). It is acceptable ONLY
    // because the summary makes it visible — this test pins both halves.
    const local = emptyLocal();
    local.tracking["tv:100"] = tvEntry("100", "watchlist", {});

    const remote: RemoteSnapshot = {
      ...emptyRemoteSnapshot(),
      trackedTitles: [titleRow("100", "watched")],
    };

    const plan = await buildMergePlan(USER, local, remote, { now: NOW });
    expect(plan.local.tracking["tv:100"].status).toBe("watched");
    expect(plan.summary.statusDifferences).toHaveLength(1);
  });

  it("reports nothing when the two sides agree", async () => {
    const local = emptyLocal();
    local.tracking["tv:100"] = tvEntry("100", "watching", {});

    const remote: RemoteSnapshot = {
      ...emptyRemoteSnapshot(),
      trackedTitles: [titleRow("100", "watching")],
    };

    const plan = await buildMergePlan(USER, local, remote, { now: NOW });
    expect(plan.summary.statusDifferences).toHaveLength(0);
  });

  it("ranks watchlist < watching < watched", async () => {
    const cases: Array<[TrackingStatus, TrackingStatus, TrackingStatus]> = [
      ["watchlist", "watching", "watching"],
      ["watching", "watchlist", "watching"],
      ["watching", "watched", "watched"],
      ["watched", "watchlist", "watched"],
    ];

    for (const [localStatus, remoteStatus, expected] of cases) {
      const local = emptyLocal();
      local.tracking["tv:100"] = tvEntry("100", localStatus, {});
      const remote: RemoteSnapshot = {
        ...emptyRemoteSnapshot(),
        trackedTitles: [titleRow("100", remoteStatus)],
      };
      const plan = await buildMergePlan(USER, local, remote, { now: NOW });
      expect(plan.local.tracking["tv:100"].status, `${localStatus}+${remoteStatus}`).toBe(
        expected,
      );
    }
  });

  it("keeps the earliest addedAt and the latest updatedAt", async () => {
    const local = emptyLocal();
    local.tracking["tv:100"] = tvEntry("100", "watching", {}, new Date("2026-06-01T00:00:00Z"));
    local.tracking["tv:100"].addedAt = new Date("2026-03-01T00:00:00Z");

    const remote: RemoteSnapshot = {
      ...emptyRemoteSnapshot(),
      trackedTitles: [
        titleRow("100", "watching", {
          added_at: "2026-01-15T00:00:00.000Z",
          client_updated_at: "2026-07-20T00:00:00.000Z",
        }),
      ],
    };

    const plan = await buildMergePlan(USER, local, remote, { now: NOW });
    const merged = plan.local.tracking["tv:100"];
    expect(merged.addedAt.toISOString()).toBe("2026-01-15T00:00:00.000Z");
    expect(merged.updatedAt.toISOString()).toBe("2026-07-20T00:00:00.000Z");
  });

  it("prefers a known scalar over a null on either side", async () => {
    const local = emptyLocal();
    const entry = movieEntry("200", "watched");
    (entry as { runtimeMinutes: number | null }).runtimeMinutes = null;
    local.tracking["movie:200"] = entry;

    const remote: RemoteSnapshot = {
      ...emptyRemoteSnapshot(),
      trackedTitles: [
        titleRow("200", "watched", { media_type: "movie", runtime_minutes: 148 }),
      ],
    };

    const plan = await buildMergePlan(USER, local, remote, { now: NOW });
    const merged = plan.local.tracking["movie:200"];
    expect(merged.mediaType === "movie" && merged.runtimeMinutes).toBe(148);
  });

  it("downloads a remote-only title and its episodes", async () => {
    const remote: RemoteSnapshot = {
      ...emptyRemoteSnapshot(),
      trackedTitles: [titleRow("300", "watching")],
      watchedEpisodes: [episodeRow("300", 1, 1), episodeRow("300", 1, 2)],
    };

    const plan = await buildMergePlan(USER, emptyLocal(), remote, { now: NOW });
    const received = plan.local.tracking["tv:300"];
    expect(received.status).toBe("watching");
    expect(received.mediaType === "tv" && received.watchedEpisodes).toEqual({ 1: [[1, 2]] });
    expect(plan.summary.counts.titlesReceived).toBe(1);
  });

  it("does not resurrect a remote-only title that was deleted elsewhere", async () => {
    const remote: RemoteSnapshot = {
      ...emptyRemoteSnapshot(),
      trackedTitles: [titleRow("300", "watching", { deleted_at: "2026-07-01T00:00:00.000Z" })],
    };
    const plan = await buildMergePlan(USER, emptyLocal(), remote, { now: NOW });
    expect(plan.local.tracking["tv:300"]).toBeUndefined();
  });
});

/* ==========================================================================
 * Ratings and notes
 * ======================================================================= */

function rating(
  id: string,
  score: number | null,
  note: string,
  updatedAt = new Date("2026-06-01T00:00:00Z"),
): RatingEntry {
  return { id, mediaType: "tv", score, note, updatedAt };
}

describe("merge: ratings", () => {
  it("takes the later score when both sides differ, and reports it", async () => {
    const local = emptyLocal();
    local.ratings["tv:100"] = rating("100", 70, "", new Date("2026-06-01T00:00:00Z"));

    const remote: RemoteSnapshot = {
      ...emptyRemoteSnapshot(),
      ratings: [
        {
          user_id: USER,
          media_type: "tv",
          title_id: "100",
          score: 90,
          client_updated_at: "2026-07-01T00:00:00.000Z",
          deleted_at: null,
        },
      ],
    };

    const plan = await buildMergePlan(USER, local, remote, { now: NOW });
    expect(plan.local.ratings["tv:100"].score).toBe(90);
    expect(plan.summary.scoreDifferences).toEqual([
      expect.objectContaining({ local: 70, remote: 90, result: 90 }),
    ]);
  });

  it("keeps the local score when it is the later one", async () => {
    const local = emptyLocal();
    local.ratings["tv:100"] = rating("100", 70, "", new Date("2026-08-01T00:00:00Z"));

    const remote: RemoteSnapshot = {
      ...emptyRemoteSnapshot(),
      ratings: [
        {
          user_id: USER,
          media_type: "tv",
          title_id: "100",
          score: 90,
          client_updated_at: "2026-07-01T00:00:00.000Z",
          deleted_at: null,
        },
      ],
    };

    const plan = await buildMergePlan(USER, local, remote, { now: NOW });
    expect(plan.local.ratings["tv:100"].score).toBe(70);
  });

  it("never lets an unrated side beat a real score", async () => {
    // "Not rated" is the absence of an opinion, not a later opinion.
    const local = emptyLocal();
    local.ratings["tv:100"] = rating("100", null, "", new Date("2026-08-01T00:00:00Z"));

    const remote: RemoteSnapshot = {
      ...emptyRemoteSnapshot(),
      ratings: [
        {
          user_id: USER,
          media_type: "tv",
          title_id: "100",
          score: 90,
          client_updated_at: "2026-01-01T00:00:00.000Z",
          deleted_at: null,
        },
      ],
    };

    const plan = await buildMergePlan(USER, local, remote, { now: NOW });
    expect(plan.local.ratings["tv:100"].score).toBe(90);
    expect(plan.summary.scoreDifferences).toHaveLength(0);
  });

  it("concatenates two independently written notes with a dated marker", async () => {
    const local = emptyLocal();
    local.ratings["tv:100"] = rating("100", null, "Loved the finale.");

    const remote: RemoteSnapshot = {
      ...emptyRemoteSnapshot(),
      ratingNotes: [
        {
          user_id: USER,
          media_type: "tv",
          title_id: "100",
          note: "Slow start but worth it.",
          client_updated_at: "2026-07-01T00:00:00.000Z",
          deleted_at: null,
        },
      ],
    };

    const plan = await buildMergePlan(USER, local, remote, { now: NOW });
    const note = plan.local.ratings["tv:100"].note;

    // Neither side's prose may be lost — that is the whole reason notes
    // concatenate instead of taking LWW.
    expect(note).toContain("Loved the finale.");
    expect(note).toContain("Slow start but worth it.");
    expect(note).toContain("merged from another device, 2026-08-07");
    expect(plan.summary.noteConcatenations).toHaveLength(1);
  });

  it("does not concatenate identical notes", async () => {
    const local = emptyLocal();
    local.ratings["tv:100"] = rating("100", null, "Same text.");

    const remote: RemoteSnapshot = {
      ...emptyRemoteSnapshot(),
      ratingNotes: [
        {
          user_id: USER,
          media_type: "tv",
          title_id: "100",
          note: "Same text.",
          client_updated_at: "2026-07-01T00:00:00.000Z",
          deleted_at: null,
        },
      ],
    };

    const plan = await buildMergePlan(USER, local, remote, { now: NOW });
    expect(plan.local.ratings["tv:100"].note).toBe("Same text.");
    expect(plan.summary.noteConcatenations).toHaveLength(0);
  });

  it("takes the remote note when the local side has none", async () => {
    const local = emptyLocal();
    local.ratings["tv:100"] = rating("100", 80, "");

    const remote: RemoteSnapshot = {
      ...emptyRemoteSnapshot(),
      ratingNotes: [
        {
          user_id: USER,
          media_type: "tv",
          title_id: "100",
          note: "From the laptop.",
          client_updated_at: "2026-07-01T00:00:00.000Z",
          deleted_at: null,
        },
      ],
    };

    const plan = await buildMergePlan(USER, local, remote, { now: NOW });
    expect(plan.local.ratings["tv:100"].note).toBe("From the laptop.");
    expect(plan.summary.noteConcatenations).toHaveLength(0);
  });

  it("uploads a local-only rating as both a score row and a note row", async () => {
    const local = emptyLocal();
    local.ratings["tv:100"] = rating("100", 85, "Great.");

    const plan = await buildMergePlan(USER, local, emptyRemoteSnapshot(), { now: NOW });
    expect(plan.push.ratings).toHaveLength(1);
    expect(plan.push.rating_notes).toHaveLength(1);
    expect(plan.push.rating_notes[0].note).toBe("Great.");
  });
});

/* ==========================================================================
 * Badges and XP
 * ======================================================================= */

describe("merge: badges and xp", () => {
  it("keeps a badge earned only locally and uploads it", async () => {
    const local = emptyLocal();
    local.badges["genre-hopper"] = { earnedAt: new Date("2026-04-01T00:00:00Z") };

    const plan = await buildMergePlan(USER, local, emptyRemoteSnapshot(), { now: NOW });
    expect(plan.local.badges["genre-hopper"]).toBeDefined();
    expect(plan.push.badges_earned).toHaveLength(1);
  });

  it("takes the earliest earned_at when both sides have the badge", async () => {
    const local = emptyLocal();
    local.badges["genre-hopper"] = { earnedAt: new Date("2026-04-01T00:00:00Z") };

    const remote: RemoteSnapshot = {
      ...emptyRemoteSnapshot(),
      badges: [
        { user_id: USER, badge_id: "genre-hopper", earned_at: "2026-02-01T00:00:00.000Z" },
      ],
    };

    const plan = await buildMergePlan(USER, local, remote, { now: NOW });
    expect(plan.local.badges["genre-hopper"].earnedAt.toISOString()).toBe(
      "2026-02-01T00:00:00.000Z",
    );
  });

  it("downloads a badge earned only remotely", async () => {
    const remote: RemoteSnapshot = {
      ...emptyRemoteSnapshot(),
      badges: [{ user_id: USER, badge_id: "night-owl", earned_at: "2026-03-01T00:00:00.000Z" }],
    };

    const plan = await buildMergePlan(USER, emptyLocal(), remote, { now: NOW });
    expect(plan.local.badges["night-owl"]).toBeDefined();
  });

  it("takes the greatest highest-level-seen", async () => {
    const local = emptyLocal();
    local.highestLevelSeen = 12;

    const remote: RemoteSnapshot = {
      ...emptyRemoteSnapshot(),
      xp: { user_id: USER, highest_level_seen: 30 },
    };

    const plan = await buildMergePlan(USER, local, remote, { now: NOW });
    expect(plan.local.highestLevelSeen).toBe(30);
    expect(plan.push.xp_state[0].highest_level_seen).toBe(30);
  });
});

/* ==========================================================================
 * The watch log, and the idempotency guarantee
 * ======================================================================= */

const EPISODE_EVENT: WatchEvent = { k: "e", t: "tv:100", s: 1, e: 1, m: 600 };

describe("merge: watch log", () => {
  it("mints deterministic ids for pre-account events", async () => {
    const local = emptyLocal();
    local.watchLog["2026-07-01"] = [EPISODE_EVENT, { ...EPISODE_EVENT, e: 2 }];

    const first = await buildMergePlan(USER, local, emptyRemoteSnapshot(), { now: NOW });
    const second = await buildMergePlan(USER, local, emptyRemoteSnapshot(), { now: NOW });

    const idsA = first.push.watch_events.map((row) => row.id);
    const idsB = second.push.watch_events.map((row) => row.id);
    expect(idsA).toEqual(idsB);
    expect(idsA.every(isUuid)).toBe(true);
  });

  it("A RETRIED MERGE INSERTS NOTHING NEW — the recovery strategy", async () => {
    // This is the test the whole "if it fails, just run it again" strategy
    // rests on. Run the merge, feed its own output back as the server state,
    // and the second run must have nothing left to push.
    const local = emptyLocal();
    local.watchLog["2026-07-01"] = [EPISODE_EVENT, { ...EPISODE_EVENT, e: 2 }];
    local.watchLog["2026-07-02"] = [{ k: "m", t: "movie:9", m: 1200 }];

    const first = await buildMergePlan(USER, local, emptyRemoteSnapshot(), { now: NOW });
    expect(first.push.watch_events).toHaveLength(3);

    const afterFirst: RemoteSnapshot = {
      ...emptyRemoteSnapshot(),
      watchEvents: first.push.watch_events,
    };

    const second = await buildMergePlan(USER, local, afterFirst, { now: NOW });
    expect(second.push.watch_events).toHaveLength(0);
  });

  it("keeps two identical marks of the same episode on the same day distinct", async () => {
    // An unmark-then-remark is the only way this can happen, and it is exactly
    // the signal the "Second Helping" badge reads. Hashing event CONTENT
    // instead of the array index would collapse these into one row.
    const local = emptyLocal();
    local.watchLog["2026-07-01"] = [EPISODE_EVENT, { ...EPISODE_EVENT }];

    const plan = await buildMergePlan(USER, local, emptyRemoteSnapshot(), { now: NOW });
    const ids = plan.push.watch_events.map((row) => row.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("does not re-push an event that already carries an id present remotely", async () => {
    const local = emptyLocal();
    const withId: WatchEvent = { ...EPISODE_EVENT, id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" };
    local.watchLog["2026-07-01"] = [withId];

    const remote: RemoteSnapshot = {
      ...emptyRemoteSnapshot(),
      watchEvents: [
        {
          id: withId.id!,
          user_id: USER,
          day_key: "2026-07-01",
          kind: "episode",
          media_type: "tv",
          title_id: "100",
          season_number: 1,
          episode_number: 1,
          minute_of_day: 600,
          bulk: false,
        },
      ],
    };

    const plan = await buildMergePlan(USER, local, remote, { now: NOW });
    expect(plan.push.watch_events).toHaveLength(0);
  });

  it("unions remote events into a day this device also has", async () => {
    const local = emptyLocal();
    local.watchLog["2026-07-01"] = [EPISODE_EVENT];

    const remote: RemoteSnapshot = {
      ...emptyRemoteSnapshot(),
      watchEvents: [
        {
          id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          user_id: USER,
          day_key: "2026-07-01",
          kind: "episode",
          media_type: "tv",
          title_id: "555",
          season_number: 2,
          episode_number: 4,
          minute_of_day: 100,
          bulk: true,
        },
      ],
    };

    const plan = await buildMergePlan(USER, local, remote, { now: NOW });
    expect(plan.local.watchLog["2026-07-01"]).toHaveLength(2);
    expect(plan.local.watchLog["2026-07-01"][1]).toMatchObject({
      t: "tv:555",
      s: 2,
      e: 4,
      b: 1,
    });
  });

  it("preserves the local day key verbatim — never re-derived", async () => {
    // §2.3. Deriving the day from an instant rewrites a user's streak history
    // when they travel.
    const local = emptyLocal();
    local.watchLog["2026-01-01"] = [EPISODE_EVENT];

    const plan = await buildMergePlan(USER, local, emptyRemoteSnapshot(), { now: NOW });
    expect(plan.push.watch_events[0].day_key).toBe("2026-01-01");
  });
});

/* ==========================================================================
 * The guarantee the brief asks for
 * ======================================================================= */

describe("merge: never loses local data", () => {
  it("keeps every local title, episode, rating, note, badge and log event", async () => {
    const local: LocalSnapshot = {
      tracking: {
        "tv:100": tvEntry("100", "watched", { 1: [[1, 10]], 2: [[1, 3]] }),
        "movie:200": movieEntry("200", "watched"),
        "tv:300": tvEntry("300", "watchlist", {}),
      },
      ratings: {
        "tv:100": rating("100", 95, "A local note."),
        "movie:200": rating("200", 60, ""),
      },
      watchLog: {
        "2026-07-01": [EPISODE_EVENT, { ...EPISODE_EVENT, e: 2 }],
        "2026-07-05": [{ k: "t", t: "tv:300" }],
      },
      badges: {
        "genre-hopper": { earnedAt: new Date("2026-04-01T00:00:00Z") },
        marathoner: { earnedAt: new Date("2026-05-01T00:00:00Z") },
      },
      highestLevelSeen: 21,
    };

    // A busy remote side that disagrees in every way it can.
    const remote: RemoteSnapshot = {
      trackedTitles: [
        titleRow("100", "watchlist"),
        titleRow("400", "watching"),
      ],
      watchedEpisodes: [episodeRow("100", 1, 11), episodeRow("400", 1, 1)],
      ratings: [
        {
          user_id: USER,
          media_type: "tv",
          title_id: "100",
          score: 40,
          client_updated_at: "2026-07-30T00:00:00.000Z",
          deleted_at: null,
        },
      ],
      ratingNotes: [
        {
          user_id: USER,
          media_type: "tv",
          title_id: "100",
          note: "A remote note.",
          client_updated_at: "2026-07-30T00:00:00.000Z",
          deleted_at: null,
        },
      ],
      watchEvents: [],
      badges: [{ user_id: USER, badge_id: "deep-cut", earned_at: "2026-06-01T00:00:00.000Z" }],
      xp: { user_id: USER, highest_level_seen: 8 },
    };

    const plan = await buildMergePlan(USER, local, remote, { now: NOW });

    // Every local title survives, and the remote-only one arrives.
    for (const key of Object.keys(local.tracking)) {
      expect(plan.local.tracking[key], key).toBeDefined();
    }
    expect(plan.local.tracking["tv:400"]).toBeDefined();

    // Status was promoted, never demoted.
    expect(plan.local.tracking["tv:100"].status).toBe("watched");

    // Episodes unioned, nothing dropped.
    const merged100 = plan.local.tracking["tv:100"];
    expect(merged100.mediaType === "tv" && merged100.watchedEpisodes).toEqual({
      1: [[1, 11]],
      2: [[1, 3]],
    });

    // Both notes survive.
    expect(plan.local.ratings["tv:100"].note).toContain("A local note.");
    expect(plan.local.ratings["tv:100"].note).toContain("A remote note.");

    // Every badge from both sides.
    expect(Object.keys(plan.local.badges).sort()).toEqual([
      "deep-cut",
      "genre-hopper",
      "marathoner",
    ]);

    // XP takes the higher of the two.
    expect(plan.local.highestLevelSeen).toBe(21);

    // Every local log day survives.
    expect(Object.keys(plan.local.watchLog).sort()).toEqual(["2026-07-01", "2026-07-05"]);
  });

  it("is a full no-op replayed against its own result", async () => {
    const local: LocalSnapshot = {
      tracking: { "tv:100": tvEntry("100", "watched", { 1: [[1, 4]] }) },
      ratings: { "tv:100": rating("100", 90, "Note.") },
      watchLog: { "2026-07-01": [EPISODE_EVENT] },
      badges: { marathoner: { earnedAt: new Date("2026-05-01T00:00:00Z") } },
      highestLevelSeen: 5,
    };

    const first = await buildMergePlan(USER, local, emptyRemoteSnapshot(), { now: NOW });

    const asRemote: RemoteSnapshot = {
      trackedTitles: first.push.tracked_titles,
      watchedEpisodes: first.push.watched_episodes,
      ratings: first.push.ratings,
      ratingNotes: first.push.rating_notes,
      watchEvents: first.push.watch_events,
      badges: first.push.badges_earned,
      xp: first.push.xp_state[0],
    };

    const second = await buildMergePlan(USER, first.local, asRemote, { now: NOW });

    // Local state must be identical — no duplicated notes, no shifted ranges.
    expect(second.local.tracking["tv:100"]).toEqual(first.local.tracking["tv:100"]);
    expect(second.local.ratings["tv:100"].note).toBe("Note.");
    expect(second.local.watchLog["2026-07-01"]).toHaveLength(1);
    expect(second.push.watch_events).toHaveLength(0);
    expect(second.summary.noteConcatenations).toHaveLength(0);
  });
});

/* ==========================================================================
 * UUID scheme
 * ======================================================================= */

describe("uuid", () => {
  it("produces the RFC 4122 v5 vector for the DNS namespace", async () => {
    // Known-answer test against the published vector, so a refactor of the
    // bit-twiddling is caught rather than silently producing new ids for every
    // pre-account event in existence.
    const dns = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
    expect(await uuidV5("www.example.com", dns)).toBe(
      "2ed6657d-e927-568b-95e1-2665a8aea6a2",
    );
  });

  it("is stable across calls and sensitive to every input", async () => {
    const a = await preAccountEventId(USER, "2026-07-01", 0);
    const b = await preAccountEventId(USER, "2026-07-01", 0);
    expect(a).toBe(b);

    expect(await preAccountEventId(USER, "2026-07-01", 1)).not.toBe(a);
    expect(await preAccountEventId(USER, "2026-07-02", 0)).not.toBe(a);
    expect(await preAccountEventId("22222222-2222-2222-2222-222222222222", "2026-07-01", 0)).not.toBe(a);
  });

  it("sets the version and variant nibbles", async () => {
    const id = await preAccountEventId(USER, "2026-07-01", 0);
    expect(id[14]).toBe("5");
    expect("89ab").toContain(id[19]);
    expect(isUuid(id)).toBe(true);
  });

  it("rejects malformed ids", () => {
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("")).toBe(false);
    expect(isUuid(null)).toBe(false);
    // Wrong variant nibble.
    expect(isUuid("aaaaaaaa-bbbb-4ccc-1ddd-eeeeeeeeeeee")).toBe(false);
  });
});

/* ==========================================================================
 * Insecure origins — http://<lan-ip>:3000, and any non-HTTPS deployment
 * ======================================================================= */

describe("uuid on a NON-SECURE origin", () => {
  /**
   * `crypto.subtle` and `crypto.randomUUID` are secure-context only. They
   * exist on https:// and on localhost, and are `undefined` on a plain-HTTP
   * origin — which is how a phone reaches a dev server over the LAN, how any
   * non-HTTPS deployment is reached, and the exact configuration that broke a
   * live two-device test.
   *
   * `getRandomValues` is NOT gated, so it stays available and the fallback has
   * real randomness.
   */
  const realCrypto = globalThis.crypto;

  beforeEach(() => {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { getRandomValues: realCrypto.getRandomValues.bind(realCrypto) },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: realCrypto,
    });
  });

  it("confirms the simulated environment really is missing both APIs", () => {
    // Without this the rest of the block could pass trivially against a
    // still-secure context, proving nothing.
    expect(globalThis.crypto.subtle).toBeUndefined();
    expect(
      (globalThis.crypto as { randomUUID?: unknown }).randomUUID,
    ).toBeUndefined();
  });

  it("still produces the RFC 4122 v5 vector", async () => {
    const dns = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
    expect(await uuidV5("www.example.com", dns)).toBe(
      "2ed6657d-e927-568b-95e1-2665a8aea6a2",
    );
  });

  it("derives IDENTICAL event ids to a secure origin", async () => {
    // The one that actually matters. Two devices, one on HTTPS and one not,
    // must derive the same id for the same pre-account event — otherwise a
    // merge from the second device inserts the user's entire history again.
    const insecure = await preAccountEventId(USER, "2026-07-01", 0);

    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: realCrypto,
    });
    const secure = await preAccountEventId(USER, "2026-07-01", 0);

    expect(insecure).toBe(secure);
  });

  it("still mints a valid random v4 without crypto.randomUUID", () => {
    const id = randomUuid();
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe("4");
    expect(randomUuid()).not.toBe(id);
  });

  it("runs a full merge without throwing", async () => {
    // The end-to-end regression: this threw `Cannot read properties of
    // undefined (reading 'digest')` before the fix, so the first-login merge
    // failed outright on every non-HTTPS origin.
    const local = emptyLocal();
    local.tracking["tv:100"] = tvEntry("100", "watched", { 1: [[1, 3]] });
    local.watchLog["2026-07-01"] = [EPISODE_EVENT];

    const plan = await buildMergePlan(USER, local, emptyRemoteSnapshot(), { now: NOW });
    expect(plan.push.watch_events).toHaveLength(1);
    expect(isUuid(plan.push.watch_events[0].id)).toBe(true);
  });
});
