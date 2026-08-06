import { describe, expect, it } from "vitest";

import type { TitleSummary } from "@/lib/content/types";
import type { RatingEntry } from "@/lib/ratings/types";
import type { TrackingEntry, WatchedEpisodes } from "@/lib/tracking/types";

import { reconcileEpisodes, reconcileRating, reconcileTitle } from "./reconcile";
import type { RatingNoteRow, RatingRow, TrackedTitleRow, WatchedEpisodeRow } from "./types";
import { episodeRowKey } from "./wire";

/**
 * Steady-state sync: applying pulled rows on top of local state.
 *
 * The cases that matter are the ones where a device was offline and both sides
 * moved. The brief asks for exactly that, and the sharpest of them is the
 * pending-write guard — without it, a pull that lands before the outbox
 * flushes silently erases a mark the user has already been shown.
 */

const USER = "11111111-1111-1111-1111-111111111111";

function summaryFor(id: string): TitleSummary {
  return {
    id,
    mediaType: "tv",
    name: `Show ${id}`,
    year: 2020,
    overview: "",
    genres: [],
    posterUrl: null,
    placeholder: { gradientFrom: "#111", gradientTo: "#222" },
    rating: null,
  };
}

function localTv(
  id: string,
  updatedAt: string,
  watchedEpisodes: WatchedEpisodes = {},
): TrackingEntry {
  return {
    id,
    mediaType: "tv",
    status: "watching",
    addedAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date(updatedAt),
    summary: summaryFor(id),
    watchedEpisodes,
    knownEpisodeCount: null,
  };
}

function titleRow(overrides: Partial<TrackedTitleRow> = {}): TrackedTitleRow {
  return {
    user_id: USER,
    media_type: "tv",
    title_id: "100",
    status: "watched",
    summary: summaryFor("100"),
    runtime_minutes: null,
    known_episode_count: null,
    added_at: "2026-01-01T00:00:00.000Z",
    client_updated_at: "2026-07-01T00:00:00.000Z",
    deleted_at: null,
    ...overrides,
  };
}

function episodeRow(
  season: number,
  episode: number,
  overrides: Partial<WatchedEpisodeRow> = {},
): WatchedEpisodeRow {
  return {
    user_id: USER,
    media_type: "tv",
    title_id: "100",
    season_number: season,
    episode_number: episode,
    client_updated_at: "2026-07-01T00:00:00.000Z",
    deleted_at: null,
    ...overrides,
  };
}

const noPending = () => null;

/* ==========================================================================
 * Titles
 * ======================================================================= */

describe("reconcileTitle", () => {
  it("applies a newer server row", () => {
    const local = localTv("100", "2026-06-01T00:00:00Z");
    const result = reconcileTitle(local, titleRow(), null);
    expect(result.action).toBe("write");
    expect(result.action === "write" && result.entry.status).toBe("watched");
  });

  it("ignores an older server row", () => {
    const local = localTv("100", "2026-08-01T00:00:00Z");
    expect(reconcileTitle(local, titleRow(), null).action).toBe("keep");
  });

  it("writes a title this device has never seen", () => {
    expect(reconcileTitle(undefined, titleRow(), null).action).toBe("write");
  });

  it("PRESERVES local episode progress when a title row changes", () => {
    // Episodes live in their own table. A status change arriving from another
    // device must not carry `watchedEpisodes: {}` over this device's progress —
    // that would silently wipe a whole show's episode history on a one-field
    // update.
    const local = localTv("100", "2026-06-01T00:00:00Z", { 1: [[1, 8]] });
    const result = reconcileTitle(local, titleRow(), null);
    expect(result.action === "write" && result.entry.mediaType === "tv" && result.entry.watchedEpisodes).toEqual(
      { 1: [[1, 8]] },
    );
  });

  it("deletes on a tombstone, but only if the title is actually here", () => {
    const local = localTv("100", "2026-06-01T00:00:00Z");
    const tombstone = titleRow({ deleted_at: "2026-07-01T00:00:00.000Z" });
    expect(reconcileTitle(local, tombstone, null).action).toBe("delete");
    expect(reconcileTitle(undefined, tombstone, null).action).toBe("keep");
  });

  it("lets an un-pushed local write beat a server row of the same age", () => {
    // The guard. Pending write at T, server row at T: prefer local, because
    // the server row is almost always the echo of our own earlier push and
    // rewriting would be pointless churn.
    const local = localTv("100", "2026-06-01T00:00:00Z");
    const pending = new Date("2026-07-01T00:00:00.000Z");
    expect(reconcileTitle(local, titleRow(), pending).action).toBe("keep");
  });

  it("lets an un-pushed local write beat an OLDER server row", () => {
    const local = localTv("100", "2026-06-01T00:00:00Z");
    const pending = new Date("2026-09-01T00:00:00.000Z");
    expect(reconcileTitle(local, titleRow(), pending).action).toBe("keep");
  });

  it("still applies a server row newer than the pending write", () => {
    const local = localTv("100", "2026-06-01T00:00:00Z");
    const pending = new Date("2026-06-15T00:00:00.000Z");
    expect(reconcileTitle(local, titleRow(), pending).action).toBe("write");
  });

  it("does not let a pending write block a tombstone that is newer", () => {
    const local = localTv("100", "2026-06-01T00:00:00Z");
    const tombstone = titleRow({ deleted_at: "2026-09-01T00:00:00.000Z", client_updated_at: "2026-09-01T00:00:00.000Z" });
    const pending = new Date("2026-07-01T00:00:00.000Z");
    expect(reconcileTitle(local, tombstone, pending).action).toBe("delete");
  });
});

/* ==========================================================================
 * Episodes — the offline scenario from design doc §4.1
 * ======================================================================= */

describe("reconcileEpisodes", () => {
  it("phone marks S3E4 offline, laptop marks S3E5 — both survive", () => {
    // §4.1: "there is no conflict and no rule is needed". This is the return on
    // exploding the range encoding into rows, and it is worth pinning.
    const localAfterPhoneMark: WatchedEpisodes = { 3: [[4, 4]] };
    const fromLaptop = [episodeRow(3, 5)];

    const result = reconcileEpisodes(localAfterPhoneMark, fromLaptop, noPending);
    expect(result).toEqual({ 3: [[4, 5]] });
  });

  it("adds an episode and keeps ranges canonical", () => {
    const result = reconcileEpisodes({ 1: [[1, 3]] }, [episodeRow(1, 4)], noPending);
    expect(result).toEqual({ 1: [[1, 4]] });
  });

  it("removes an episode on a tombstone, splitting the range", () => {
    const result = reconcileEpisodes(
      { 1: [[1, 5]] },
      [episodeRow(1, 3, { deleted_at: "2026-07-01T00:00:00.000Z" })],
      noPending,
    );
    expect(result).toEqual({
      1: [
        [1, 2],
        [4, 5],
      ],
    });
  });

  it("drops a season key entirely when its last episode is tombstoned", () => {
    const result = reconcileEpisodes(
      { 1: [[1, 1]] },
      [episodeRow(1, 1, { deleted_at: "2026-07-01T00:00:00.000Z" })],
      noPending,
    );
    expect(result).toEqual({});
  });

  it("ignores a server row for an episode still pending locally", () => {
    // The failure this prevents: mark offline, reconnect, a pull lands before
    // the flush, the mark disappears from the screen while still queued — and
    // then reappears minutes later when the push finally goes through.
    const pendingKey = episodeRowKey("tv", "100", 1, 3);
    const pendingAt = (key: string) =>
      key === pendingKey ? new Date("2026-09-01T00:00:00.000Z") : null;

    const result = reconcileEpisodes(
      { 1: [[3, 3]] },
      [episodeRow(1, 3, { deleted_at: "2026-07-01T00:00:00.000Z" })],
      pendingAt,
    );
    expect(result).toEqual({ 1: [[3, 3]] });
  });

  it("applies a server tombstone that is newer than the pending write", () => {
    const pendingKey = episodeRowKey("tv", "100", 1, 3);
    const pendingAt = (key: string) =>
      key === pendingKey ? new Date("2026-05-01T00:00:00.000Z") : null;

    const result = reconcileEpisodes(
      { 1: [[3, 3]] },
      [episodeRow(1, 3, { deleted_at: "2026-07-01T00:00:00.000Z" })],
      pendingAt,
    );
    expect(result).toEqual({});
  });

  it("applies a batch of adds and removes in one pass", () => {
    const result = reconcileEpisodes(
      { 1: [[1, 5]] },
      [
        episodeRow(1, 6),
        episodeRow(1, 2, { deleted_at: "2026-07-01T00:00:00.000Z" }),
        episodeRow(2, 1),
      ],
      noPending,
    );
    expect(result).toEqual({
      1: [
        [1, 1],
        [3, 6],
      ],
      2: [[1, 1]],
    });
  });

  it("is idempotent — re-applying the same rows changes nothing", () => {
    const once = reconcileEpisodes({ 1: [[1, 3]] }, [episodeRow(1, 4)], noPending);
    const twice = reconcileEpisodes(once, [episodeRow(1, 4)], noPending);
    expect(twice).toEqual(once);
  });
});

/* ==========================================================================
 * Ratings — two server tables folding into one local record
 * ======================================================================= */

function rating(score: number | null, note: string, updatedAt: string): RatingEntry {
  return { id: "100", mediaType: "tv", score, note, updatedAt: new Date(updatedAt) };
}

function scoreRow(score: number | null, at: string, deleted = false): RatingRow {
  return {
    user_id: USER,
    media_type: "tv",
    title_id: "100",
    score,
    client_updated_at: at,
    deleted_at: deleted ? at : null,
  };
}

function noteRow(note: string, at: string, deleted = false): RatingNoteRow {
  return {
    user_id: USER,
    media_type: "tv",
    title_id: "100",
    note,
    client_updated_at: at,
    deleted_at: deleted ? at : null,
  };
}

const IDENTITY = { mediaType: "tv" as const, titleId: "100" };

describe("reconcileRating", () => {
  it("takes a newer server score", () => {
    const result = reconcileRating(
      rating(50, "", "2026-06-01T00:00:00Z"),
      scoreRow(90, "2026-07-01T00:00:00.000Z"),
      undefined,
      null,
      IDENTITY,
    );
    expect(result.action === "write" && result.entry.score).toBe(90);
  });

  it("keeps a newer local score", () => {
    const result = reconcileRating(
      rating(50, "", "2026-08-01T00:00:00Z"),
      scoreRow(90, "2026-07-01T00:00:00.000Z"),
      undefined,
      null,
      IDENTITY,
    );
    expect(result.action).toBe("keep");
  });

  it("applies score and note independently, per table", () => {
    // The two halves live in separate tables with separate clocks (§7). A
    // score edited on the phone must not revert a note edited on the laptop.
    const result = reconcileRating(
      rating(50, "old note", "2026-06-01T00:00:00Z"),
      scoreRow(90, "2026-07-01T00:00:00.000Z"),
      noteRow("new note", "2026-07-02T00:00:00.000Z"),
      null,
      IDENTITY,
    );
    expect(result.action === "write" && result.entry.score).toBe(90);
    expect(result.action === "write" && result.entry.note).toBe("new note");
  });

  it("clears a note on a tombstone without touching the score", () => {
    const result = reconcileRating(
      rating(90, "gone soon", "2026-06-01T00:00:00Z"),
      undefined,
      noteRow("", "2026-07-01T00:00:00.000Z", true),
      null,
      IDENTITY,
    );
    expect(result.action === "write" && result.entry.note).toBe("");
    expect(result.action === "write" && result.entry.score).toBe(90);
  });

  it("deletes the record when both halves end up empty", () => {
    const result = reconcileRating(
      rating(90, "", "2026-06-01T00:00:00Z"),
      scoreRow(null, "2026-07-01T00:00:00.000Z", true),
      undefined,
      null,
      IDENTITY,
    );
    expect(result.action).toBe("delete");
  });

  it("respects a pending local write", () => {
    const result = reconcileRating(
      rating(50, "", "2026-06-01T00:00:00Z"),
      scoreRow(90, "2026-07-01T00:00:00.000Z"),
      undefined,
      new Date("2026-09-01T00:00:00.000Z"),
      IDENTITY,
    );
    expect(result.action).toBe("keep");
  });

  it("keeps when there is nothing on the server side at all", () => {
    const result = reconcileRating(
      rating(50, "", "2026-06-01T00:00:00Z"),
      undefined,
      undefined,
      null,
      IDENTITY,
    );
    expect(result.action).toBe("keep");
  });

  it("creates a local record from server rows alone", () => {
    const result = reconcileRating(
      undefined,
      scoreRow(75, "2026-07-01T00:00:00.000Z"),
      noteRow("from the laptop", "2026-07-01T00:00:00.000Z"),
      null,
      IDENTITY,
    );
    expect(result.action === "write" && result.entry).toMatchObject({
      score: 75,
      note: "from the laptop",
    });
  });
});
