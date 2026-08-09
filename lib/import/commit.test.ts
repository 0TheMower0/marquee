import { beforeEach, describe, expect, it } from "vitest";

import type { MediaType, TitleSummary } from "@/lib/content/types";
import { ratingsStore } from "@/lib/ratings/store";
import { __setDriverForTesting } from "@/lib/storage/drivers";
import type { StorageDriver } from "@/lib/storage/types";
import { trackingStore } from "@/lib/tracking/store";
import type { TrackingEntry, TrackingStatus } from "@/lib/tracking/types";
import { watchLogStore } from "@/lib/watchlog/store";

import { commitRow, committableRows } from "./commit";
import type { ImportRow, ResolvedRow } from "./types";

/**
 * These tests exist because this is the ONE layer of the importer that
 * touches data the user cannot get back. Everything upstream can be re-run;
 * a commit that demotes a `watched` title or overwrites a hand-entered rating
 * has destroyed something.
 *
 * A real in-memory `StorageDriver` is installed rather than mocking the
 * stores, so the version envelope, serialization and validation all run for
 * real — the same reason `merge.test.ts` builds real snapshots instead of
 * loose object literals.
 */
function memoryDriver(): StorageDriver {
  const map = new Map<string, string>();
  return {
    status: "memory",
    get: async (key) => map.get(key) ?? null,
    set: async (key, value) => void map.set(key, value),
    remove: async (key) => void map.delete(key),
    keys: async (prefix) => [...map.keys()].filter((key) => key.startsWith(prefix)),
    removeByPrefix: async (prefix) => {
      for (const key of [...map.keys()]) if (key.startsWith(prefix)) map.delete(key);
    },
  };
}

function title(
  id: string,
  name = "Gravity",
  mediaType: MediaType = "movie",
): TitleSummary {
  return {
    id,
    mediaType,
    name,
    year: 2013,
    overview: "",
    genres: [],
    posterUrl: null,
    placeholder: { gradientFrom: "#111", gradientTo: "#222" },
    rating: null,
  };
}

function row(overrides: Partial<ImportRow> = {}): ImportRow {
  return {
    source: "letterboxd-diary",
    sourceRowId: "letterboxd-diary:2",
    imdbId: null,
    tmdbId: null,
    title: "Gravity",
    originalTitle: null,
    year: 2013,
    slug: null,
    mediaTypeHint: "movie",
    score: null,
    ratedOn: null,
    watchedOn: null,
    season: null,
    episode: null,
    watchedMinute: null,
    isRewatch: false,
    intent: "watched",
    sourceLine: 2,
    ...overrides,
  };
}

function resolved(
  rowOverrides: Partial<ImportRow> = {},
  chosen: TitleSummary = title("49047"),
): ResolvedRow {
  return {
    row: row(rowOverrides),
    bucket: "confident",
    candidates: [],
    chosen,
    skipped: false,
  };
}

beforeEach(() => {
  __setDriverForTesting(memoryDriver());
});

describe("committableRows", () => {
  it("commits only rows that were decided AND chosen", () => {
    const rows: ResolvedRow[] = [
      resolved(),
      { ...resolved(), skipped: true },
      { ...resolved(), chosen: null }, // undecided — user walked away
    ];
    expect(committableRows(rows)).toHaveLength(1);
  });

  it("never commits an undecided ambiguous row", () => {
    // The property that makes abandoning the review queue safe.
    const ambiguous: ResolvedRow = {
      row: row(),
      bucket: "ambiguous",
      candidates: [],
      chosen: null,
      skipped: false,
    };
    expect(committableRows([ambiguous])).toEqual([]);
  });
});

describe("status — max progress only", () => {
  async function seed(status: TrackingStatus) {
    const entry: TrackingEntry = {
      id: "49047",
      mediaType: "movie",
      status,
      addedAt: new Date("2020-01-01"),
      updatedAt: new Date("2020-01-01"),
      summary: title("49047"),
      runtimeMinutes: 91,
    };
    await trackingStore.set("movie:49047", entry);
  }

  it("promotes watchlist to watched", async () => {
    await seed("watchlist");
    await commitRow(resolved({ intent: "watched" }), null, {});
    expect((await trackingStore.get("movie:49047"))?.status).toBe("watched");
  });

  it("NEVER demotes watched to watchlist", async () => {
    // The single most important assertion in this file. An IMDb watchlist
    // export routinely contains films the user has since watched.
    await seed("watched");
    await commitRow(resolved({ intent: "watchlist" }), null, {});
    expect((await trackingStore.get("movie:49047"))?.status).toBe("watched");
  });

  it("never demotes watching to watchlist either", async () => {
    await seed("watching");
    await commitRow(resolved({ intent: "watchlist" }), null, {});
    expect((await trackingStore.get("movie:49047"))?.status).toBe("watching");
  });

  it("treats a rating-only row as watched", async () => {
    await commitRow(resolved({ intent: "rating-only", score: 80 }), null, {});
    expect((await trackingStore.get("movie:49047"))?.status).toBe("watched");
  });

  it("creates an entry that did not exist", async () => {
    await commitRow(resolved({ intent: "watchlist" }), null, {});
    const entry = await trackingStore.get("movie:49047");
    expect(entry?.status).toBe("watchlist");
    expect(entry?.summary.name).toBe("Gravity");
  });

  it("keeps the EXISTING summary snapshot rather than replacing it", async () => {
    // A stored snapshot came from a full Title fetch; an imported one is
    // reconstructed from a search result and can be thinner.
    await seed("watchlist");
    await commitRow(resolved({}, title("49047", "Gravity (imported)")), null, {});
    expect((await trackingStore.get("movie:49047"))?.summary.name).toBe("Gravity");
  });

  it("preserves a TV title's episode progress", async () => {
    // Overwriting real episode ranges with {} would destroy the data that is
    // hardest for a user to reconstruct.
    await trackingStore.set("tv:1396", {
      id: "1396",
      mediaType: "tv",
      status: "watching",
      addedAt: new Date("2020-01-01"),
      updatedAt: new Date("2020-01-01"),
      summary: title("1396", "Breaking Bad", "tv"),
      watchedEpisodes: { 1: [[1, 7]] },
      knownEpisodeCount: 62,
    });

    await commitRow(
      resolved({ intent: "watched" }, title("1396", "Breaking Bad", "tv")),
      null,
      {},
    );

    const entry = await trackingStore.get("tv:1396");
    expect(entry?.mediaType === "tv" && entry.watchedEpisodes).toEqual({ 1: [[1, 7]] });
    expect(entry?.status).toBe("watched");
  });
});

describe("ratings", () => {
  it("writes an imported score when there is none locally", async () => {
    await commitRow(resolved({ score: 80 }), null, {});
    expect((await ratingsStore.get("movie:49047"))?.score).toBe(80);
  });

  it("does NOT overwrite an existing local score by default", async () => {
    await ratingsStore.set("movie:49047", {
      id: "49047",
      mediaType: "movie",
      score: 95,
      note: "",
      updatedAt: new Date("2020-01-01"),
    });

    await commitRow(resolved({ score: 60 }), null, {});
    expect((await ratingsStore.get("movie:49047"))?.score).toBe(95);
  });

  it("overwrites only when the user explicitly asked", async () => {
    await ratingsStore.set("movie:49047", {
      id: "49047",
      mediaType: "movie",
      score: 95,
      note: "",
      updatedAt: new Date("2020-01-01"),
    });

    await commitRow(resolved({ score: 60 }), null, { preferImportedScores: true });
    expect((await ratingsStore.get("movie:49047"))?.score).toBe(60);
  });

  it("never touches an existing note, even when overwriting the score", async () => {
    await ratingsStore.set("movie:49047", {
      id: "49047",
      mediaType: "movie",
      score: 95,
      note: "my own words",
      updatedAt: new Date("2020-01-01"),
    });

    await commitRow(resolved({ score: 60 }), null, { preferImportedScores: true });
    expect((await ratingsStore.get("movie:49047"))?.note).toBe("my own words");
  });

  it("writes no rating at all for a row that carries none", async () => {
    await commitRow(resolved({ score: null }), null, {});
    expect(await ratingsStore.get("movie:49047")).toBeNull();
  });
});

describe("watch events", () => {
  it("files an event under the row's OWN date, not today", async () => {
    // The whole reason importing a diary is worth doing.
    await commitRow(resolved({ watchedOn: "2019-03-14" }), "evt-1", {});
    const day = await watchLogStore.get("2019-03-14");
    expect(day).toHaveLength(1);
    expect(day?.[0].t).toBe("movie:49047");
  });

  it("writes no event for a row with no watch date", async () => {
    // An IMDb ratings row has no watch date, and inventing one is refused.
    await commitRow(resolved({ watchedOn: null, ratedOn: "2020-05-04" }), "evt-1", {});
    expect(await watchLogStore.get("2020-05-04")).toBeNull();
  });

  it("uses the rating date ONLY when explicitly opted in", async () => {
    await commitRow(resolved({ watchedOn: null, ratedOn: "2020-05-04" }), "evt-1", {
      useRatingDateAsWatchDate: true,
    });
    expect(await watchLogStore.get("2020-05-04")).toHaveLength(1);
  });

  it("omits the minute-of-day, because no source records a watch TIME", async () => {
    await commitRow(resolved({ watchedOn: "2019-03-14" }), "evt-1", {});
    expect((await watchLogStore.get("2019-03-14"))?.[0].m).toBeUndefined();
  });

  it("does not flag imported diary events as bulk", async () => {
    // A diary row IS one real viewing on one real date; flagging a decade of
    // genuine history as bulk would understate it in Year in Review.
    await commitRow(resolved({ watchedOn: "2019-03-14" }), "evt-1", {});
    expect((await watchLogStore.get("2019-03-14"))?.[0].b).toBeUndefined();
  });

  it("is idempotent for the same event id — re-import writes nothing", async () => {
    await commitRow(resolved({ watchedOn: "2019-03-14" }), "evt-1", {});
    const second = await commitRow(resolved({ watchedOn: "2019-03-14" }), "evt-1", {});

    expect(second.event).toBe(false);
    expect(await watchLogStore.get("2019-03-14")).toHaveLength(1);
  });

  it("keeps two genuine viewings on the same day as separate events", async () => {
    // Distinct sourceRowIds mean distinct event ids, so a real double feature
    // is not collapsed into one.
    await commitRow(resolved({ watchedOn: "2019-03-14", sourceRowId: "a" }), "evt-a", {});
    await commitRow(resolved({ watchedOn: "2019-03-14", sourceRowId: "b" }), "evt-b", {});
    expect(await watchLogStore.get("2019-03-14")).toHaveLength(2);
  });

  it("appends an event with NO id when signed out", async () => {
    // The established pre-account shape; the first-login merge assigns ids
    // later. `isWatchEvent` rejects a present-but-empty id, so it must be
    // absent rather than null.
    await commitRow(resolved({ watchedOn: "2019-03-14" }), null, {});
    const day = await watchLogStore.get("2019-03-14");
    expect(day).toHaveLength(1);
    expect(day?.[0].id).toBeUndefined();
  });

  it("preserves events already on that day from other sources", async () => {
    await watchLogStore.set("2019-03-14", [{ k: "m", t: "movie:existing" }]);
    await commitRow(resolved({ watchedOn: "2019-03-14" }), "evt-1", {});

    const day = await watchLogStore.get("2019-03-14");
    expect(day).toHaveLength(2);
    expect(day?.[0].t).toBe("movie:existing");
  });

  it("logs a TV title as a whole-show event, not a movie one", async () => {
    await commitRow(
      resolved({ watchedOn: "2019-03-14" }, title("1396", "Breaking Bad", "tv")),
      "evt-1",
      {},
    );
    expect((await watchLogStore.get("2019-03-14"))?.[0].k).toBe("t");
  });
});

describe("episode rows", () => {
  const show = title("1396", "Breaking Bad", "tv");

  async function seedShow(status: TrackingStatus, watchedEpisodes = {}) {
    await trackingStore.set("tv:1396", {
      id: "1396",
      mediaType: "tv",
      status,
      addedAt: new Date("2020-01-01"),
      updatedAt: new Date("2020-01-01"),
      summary: show,
      watchedEpisodes,
      knownEpisodeCount: 62,
    });
  }

  it("merges an imported episode into progress", async () => {
    const written = await commitRow(resolved({ season: 1, episode: 3 }, show), null, {});
    expect(written.episodes).toBe(true);

    const entry = await trackingStore.get("tv:1396");
    expect(entry?.mediaType === "tv" && entry.watchedEpisodes).toEqual({ 1: [[3, 3]] });
  });

  it("unions with existing progress rather than replacing it", async () => {
    await seedShow("watching", { 1: [[1, 2]] });
    await commitRow(resolved({ season: 1, episode: 3 }, show), null, {});

    const entry = await trackingStore.get("tv:1396");
    // Adjacent, so the canonical invariant collapses it to one range.
    expect(entry?.mediaType === "tv" && entry.watchedEpisodes).toEqual({ 1: [[1, 3]] });
  });

  it("promotes to watching, NEVER to watched", async () => {
    // One episode is not the whole show, and without season counts nothing
    // can honestly say otherwise.
    await commitRow(resolved({ season: 1, episode: 3 }, show), null, {});
    expect((await trackingStore.get("tv:1396"))?.status).toBe("watching");
  });

  it("logs an episode event carrying its coordinates", async () => {
    await commitRow(
      resolved({ season: 2, episode: 7, watchedOn: "2019-03-14" }, show),
      "evt-1",
      {},
    );
    const [event] = (await watchLogStore.get("2019-03-14")) ?? [];
    expect(event.k).toBe("e");
    expect(event.s).toBe(2);
    expect(event.e).toBe(7);
  });

  it("carries a real minute-of-day when the source recorded a time", async () => {
    await commitRow(
      resolved({ season: 1, episode: 1, watchedOn: "2019-03-14", watchedMinute: 1215 }, show),
      "evt-1",
      {},
    );
    expect(((await watchLogStore.get("2019-03-14")) ?? [])[0].m).toBe(1215);
  });

  it("omits the minute when the source gave only a date", async () => {
    await commitRow(
      resolved({ season: 1, episode: 1, watchedOn: "2019-03-14" }, show),
      "evt-1",
      {},
    );
    expect(((await watchLogStore.get("2019-03-14")) ?? [])[0].m).toBeUndefined();
  });

  it("writes progress even with no date at all", async () => {
    // Progress is a fact the source asserts; a date is not something we may
    // invent. So the range lands and the log stays empty.
    const written = await commitRow(resolved({ season: 1, episode: 5 }, show), null, {});
    expect(written.episodes).toBe(true);
    expect(written.event).toBe(false);
  });

  describe("the coarse-watched exception", () => {
    it("does NOT merge episodes into a title-level watched show", async () => {
      // The user asserted the WHOLE show. Merging 1 episode into a 62-episode
      // show would silently discard 61 they had already claimed.
      await seedShow("watched", {});
      const written = await commitRow(resolved({ season: 1, episode: 3 }, show), null, {});

      expect(written.episodes).toBe(false);
      const entry = await trackingStore.get("tv:1396");
      expect(entry?.mediaType === "tv" && entry.watchedEpisodes).toEqual({});
      expect(entry?.status).toBe("watched");
    });

    it("STILL writes the watch date for such a show", async () => {
      // The log is append-only and cannot demote anything, so the part an
      // import uniquely supplies still lands.
      await seedShow("watched", {});
      const written = await commitRow(
        resolved({ season: 1, episode: 3, watchedOn: "2019-03-14" }, show),
        "evt-1",
        {},
      );

      expect(written.episodes).toBe(false);
      expect(written.event).toBe(true);
      expect((await watchLogStore.get("2019-03-14")) ?? []).toHaveLength(1);
    });

    it("DOES merge into a show that already has explicit ranges", async () => {
      // `watched` with real ranges is not a coarse claim, so union is safe.
      await seedShow("watched", { 1: [[1, 2]] });
      const written = await commitRow(resolved({ season: 1, episode: 9 }, show), null, {});

      expect(written.episodes).toBe(true);
      const entry = await trackingStore.get("tv:1396");
      expect(entry?.mediaType === "tv" && entry.watchedEpisodes).toEqual({
        1: [
          [1, 2],
          [9, 9],
        ],
      });
    });
  });

  it("ignores episode coordinates on a MOVIE match", async () => {
    // A row claiming S1E3 that resolved to a film is incoherent; the
    // coordinates are dropped rather than written somewhere meaningless.
    const written = await commitRow(
      resolved({ season: 1, episode: 3 }, title("49047")),
      null,
      {},
    );
    expect(written.episodes).toBe(false);
    expect((await trackingStore.get("movie:49047"))?.status).toBe("watched");
  });
});

describe("skipped and undecided rows write nothing", () => {
  it("writes nothing for a skipped row", async () => {
    await commitRow(
      { ...resolved({ score: 80, watchedOn: "2019-03-14" }), skipped: true },
      "evt-1",
      {},
    );
    expect(await trackingStore.get("movie:49047")).toBeNull();
    expect(await ratingsStore.get("movie:49047")).toBeNull();
    expect(await watchLogStore.get("2019-03-14")).toBeNull();
  });

  it("writes nothing for a row with no chosen title", async () => {
    await commitRow(
      { ...resolved({ score: 80, watchedOn: "2019-03-14" }), chosen: null },
      "evt-1",
      {},
    );
    expect(await watchLogStore.get("2019-03-14")).toBeNull();
  });
});
