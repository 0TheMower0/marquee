import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SyncBackendError } from "./backend";
import { fetchRemoteSnapshot } from "./engine";
import { SYNC_TABLES, type SyncBackend, type SyncTable } from "./types";

/**
 * The missing-table degradation — Phase 8 Step 3.
 *
 * A real deployment shipped `home_config` (the eighth sync table) without
 * applying its migration. Because `fetchRemoteSnapshot` pulled every table in
 * one `Promise.all`, that single absent table failed the ENTIRE first-login
 * merge: library, ratings, notes and watch history all refused to sync, with
 * the only symptom a console error naming a feature the user had never used.
 *
 * These tests pin BOTH halves of the fix, and the second half matters more
 * than the first: degrading on any-and-every error would be a worse bug than
 * the one being fixed, because a transient failure that silently reported the
 * remote side as EMPTY would skip the §6.6 wrong-account confirmation.
 */

function missingTableError(table: string): SyncBackendError {
  return new SyncBackendError(
    `Could not find the table 'public.${table}' in the schema cache`,
    // Retryable: the identical write succeeds once the migration runs.
    true,
    { missingTable: true },
  );
}

/** A backend that answers every table with one row, except those told to fail. */
function backendWith(failures: Partial<Record<SyncTable, unknown>>): SyncBackend {
  return {
    async pull<T>(table: SyncTable): Promise<T[]> {
      const failure = failures[table];
      if (failure) throw failure;
      return [{ user_id: "u1", table } as unknown as T];
    },
    async push() {},
    async countAll() {
      return Object.fromEntries(SYNC_TABLES.map((t) => [t, 0])) as Record<SyncTable, number>;
    },
  };
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // One spy for the whole file, re-created per test — spying twice on an
  // already-spied method returns the SAME spy with its previous calls still
  // recorded, which silently breaks any assertion on call counts.
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchRemoteSnapshot — a missing table degrades to a missing feature", () => {

  it("returns every OTHER table's rows when home_config does not exist", async () => {
    const snapshot = await fetchRemoteSnapshot(
      backendWith({ home_config: missingTableError("home_config") }),
    );

    // The regression this exists for: these were all empty before the fix,
    // because one absent table rejected the whole Promise.all.
    expect(snapshot.trackedTitles).toHaveLength(1);
    expect(snapshot.watchedEpisodes).toHaveLength(1);
    expect(snapshot.ratings).toHaveLength(1);
    expect(snapshot.ratingNotes).toHaveLength(1);
    expect(snapshot.watchEvents).toHaveLength(1);
    expect(snapshot.badges).toHaveLength(1);
    expect(snapshot.xp).not.toBeNull();
    // The un-deployed feature, and only it, comes back empty.
    expect(snapshot.homeConfig).toBeNull();
  });

  it("warns by name so the deployment gap is visible rather than swallowed", async () => {
    await fetchRemoteSnapshot(backendWith({ home_config: missingTableError("home_config") }));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("home_config");
  });

  it("degrades for ANY missing table, not just the one that caused the bug", async () => {
    // The fix must not be special-cased to home_config: the next table added
    // will hit exactly this path before its migration is applied.
    const snapshot = await fetchRemoteSnapshot(
      backendWith({ badges_earned: missingTableError("badges_earned") }),
    );
    expect(snapshot.badges).toEqual([]);
    expect(snapshot.trackedTitles).toHaveLength(1);
  });

  it("still degrades when several tables are missing at once", async () => {
    const snapshot = await fetchRemoteSnapshot(
      backendWith({
        home_config: missingTableError("home_config"),
        badges_earned: missingTableError("badges_earned"),
      }),
    );
    expect(snapshot.homeConfig).toBeNull();
    expect(snapshot.badges).toEqual([]);
    expect(snapshot.ratings).toHaveLength(1);
  });
});

describe("fetchRemoteSnapshot — every OTHER failure must still abort", () => {
  /**
   * This is the load-bearing half. If any of these degraded to an empty
   * result, the remote snapshot would look empty, `isSnapshotEmpty` would
   * report "nothing to confuse", and the merge would proceed WITHOUT the
   * confirmation that exists to catch signing into the wrong account —
   * uploading one person's library into someone else's.
   */
  it.each([
    ["a transient network failure", new SyncBackendError("network down", true)],
    ["an RLS rejection", new SyncBackendError("row-level security", false)],
    ["a bad JWT", new SyncBackendError("JWT expired", false)],
    ["a non-SyncBackendError", new TypeError("something else entirely")],
  ])("rethrows %s on tracked_titles rather than reporting an empty remote", async (_label, err) => {
    await expect(
      fetchRemoteSnapshot(backendWith({ tracked_titles: err })),
    ).rejects.toThrow();
  });

  it("rethrows a plain permanent error even on the table that caused the original bug", async () => {
    // Same table, different error: home_config failing for a reason OTHER than
    // not existing must not be quietly treated as "not deployed yet".
    await expect(
      fetchRemoteSnapshot(
        backendWith({ home_config: new SyncBackendError("permission denied", false) }),
      ),
    ).rejects.toThrow("permission denied");
  });

  it("does not warn when it rethrows — a warning would imply it was handled", async () => {
    await expect(
      fetchRemoteSnapshot(backendWith({ ratings: new SyncBackendError("boom", true) })),
    ).rejects.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });
});
