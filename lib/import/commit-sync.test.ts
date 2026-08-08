import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { MediaType, TitleSummary } from "@/lib/content/types";
import { __setDriverForTesting } from "@/lib/storage/drivers";
import type { StorageDriver } from "@/lib/storage/types";
import { allEntries, clearOutbox } from "@/lib/sync/outbox";
import { setSyncUser } from "@/lib/sync/record";

import { commitRow } from "./commit";
import type { ImportRow, ResolvedRow } from "./types";

/**
 * ============================================================================
 * THE BUG CLASS THIS FILE EXISTS FOR
 * ============================================================================
 * `commit.ts` originally wrote directly to `trackingStore`, `ratingsStore` and
 * `watchLogStore` and never called `lib/sync/record.ts`. Every one of those
 * writes succeeded, the UI was correct, and `commit.test.ts` passed in full —
 * because it installs an in-memory driver and never mounts a sync user, so
 * there was no outbox for anything to be missing from.
 *
 * The result: for a signed-in user, an import landed on one device and
 * silently never reached any other. Nothing failed. Nothing warned. It was
 * found by noticing an EMPTY outbox while cleaning up test data.
 *
 * So these tests deliberately do the one thing the others don't: install a
 * real signed-in user and assert on the REAL outbox contents. Mocking
 * `record.ts` and asserting it was called would be weaker — it would pass
 * even if the recorder no-op'd — whereas a queued row proves the whole seam
 * ran.
 *
 * The last test in this file is the general guard: ANY local write commit
 * makes must leave a corresponding outbox row. A future field written here
 * without a recorder fails there rather than shipping as invisible data loss.
 */

const USER = "11111111-1111-4111-8111-111111111111";

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

function title(id: string, mediaType: MediaType = "movie"): TitleSummary {
  return {
    id,
    mediaType,
    name: "Gravity",
    year: 2013,
    overview: "",
    genres: [],
    posterUrl: null,
    placeholder: { gradientFrom: "#111", gradientTo: "#222" },
    rating: null,
  };
}

function resolved(overrides: Partial<ImportRow> = {}, chosen = title("49047")): ResolvedRow {
  return {
    row: {
      source: "letterboxd-diary",
      sourceRowId: "letterboxd-diary:2",
      imdbId: null,
      title: "Gravity",
      originalTitle: null,
      year: 2013,
      slug: null,
      mediaTypeHint: "movie",
      score: null,
      ratedOn: null,
      watchedOn: null,
      isRewatch: false,
      intent: "watched",
      sourceLine: 2,
      ...overrides,
    },
    bucket: "confident",
    candidates: [],
    chosen,
    skipped: false,
  };
}

beforeEach(async () => {
  __setDriverForTesting(memoryDriver());
  await clearOutbox();
  setSyncUser(USER);
});

afterEach(() => {
  // Module-level state in `record.ts` — leaking a signed-in user into another
  // suite would make unrelated tests queue rows they never asked for.
  setSyncUser(null);
});

async function tables(): Promise<string[]> {
  return (await allEntries()).map((entry) => entry.table).sort();
}

describe("signed in, an import reaches the sync outbox", () => {
  it("queues a tracked_titles row for a status write", async () => {
    await commitRow(resolved({ intent: "watched" }), null, {});
    expect(await tables()).toContain("tracked_titles");
  });

  it("queues ratings AND rating_notes for a score write", async () => {
    // Two rows from one local record — the note lives in its own table so a
    // future sharing feature cannot reach it.
    await commitRow(resolved({ score: 80 }), null, {});
    const queued = await tables();
    expect(queued).toContain("ratings");
    expect(queued).toContain("rating_notes");
  });

  it("queues a watch_events row for an imported watch date", async () => {
    await commitRow(resolved({ watchedOn: "2019-03-14" }), "evt-1", {});
    expect(await tables()).toContain("watch_events");
  });

  it("sends the row's OWN watch date upstream, not today", async () => {
    // The single most important assertion here: syncing the wrong day would
    // rewrite the user's streak history on every other device.
    await commitRow(resolved({ watchedOn: "2019-03-14" }), "evt-1", {});
    const [entry] = (await allEntries()).filter((e) => e.table === "watch_events");
    expect((entry.row as { day_key: string }).day_key).toBe("2019-03-14");
  });

  it("attributes queued rows to the signed-in user", async () => {
    await commitRow(resolved({ score: 80 }), null, {});
    const rows = await allEntries();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((e) => (e.row as { user_id?: string }).user_id === USER)).toBe(true);
  });
});

describe("signed out, nothing is queued", () => {
  beforeEach(() => setSyncUser(null));

  it("writes locally but queues nothing", async () => {
    const written = await commitRow(
      resolved({ score: 80, watchedOn: "2019-03-14" }),
      null,
      {},
    );
    // The local write still happened — signing out disables syncing, not
    // importing.
    expect(written.title).toBe(true);
    expect(written.rating).toBe(true);
    expect(written.event).toBe(true);
    expect(await allEntries()).toEqual([]);
  });
});

describe("no local write means no queued row", () => {
  it("queues nothing for a skipped row", async () => {
    await commitRow({ ...resolved({ score: 80, watchedOn: "2019-03-14" }), skipped: true }, "e", {});
    expect(await allEntries()).toEqual([]);
  });

  it("queues nothing when a status is left alone by the max-progress rule", async () => {
    await commitRow(resolved({ intent: "watched" }), null, {});
    await clearOutbox();

    // Second pass: already `watched`, so an imported `watchlist` changes
    // nothing locally and must therefore upload nothing.
    await commitRow(resolved({ intent: "watchlist" }), null, {});
    expect(await allEntries()).toEqual([]);
  });
});

describe("the general guard", () => {
  /**
   * Not tied to any particular field. It asserts the INVARIANT — a local write
   * always has a corresponding queued row — so a value added to `commitRow`
   * later without a recorder fails here, which is exactly how the original bug
   * would have been caught.
   */
  it("every kind of local write commitRow reports leaves an outbox row", async () => {
    const written = await commitRow(
      resolved({ score: 80, watchedOn: "2019-03-14" }),
      "evt-1",
      {},
    );

    // The row exercises all three write paths at once.
    expect(written).toEqual({ title: true, event: true, rating: true });

    const queued = await tables();
    const expected: Record<keyof typeof written, readonly string[]> = {
      title: ["tracked_titles"],
      event: ["watch_events"],
      rating: ["ratings", "rating_notes"],
    };

    for (const [kind, didWrite] of Object.entries(written) as [
      keyof typeof written,
      boolean,
    ][]) {
      if (!didWrite) continue;
      for (const table of expected[kind]) {
        expect(queued, `commitRow reported a ${kind} write but queued no ${table} row`).toContain(
          table,
        );
      }
    }
  });
});
