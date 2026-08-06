import { badgesEarnedStore } from "@/lib/badges/store";
import { ratingsStore } from "@/lib/ratings/store";
import { defineStore } from "@/lib/storage";
import { trackingStore } from "@/lib/tracking/store";
import { watchLogStore } from "@/lib/watchlog/store";
import { getHighestLevelSeen, seenLevelStore } from "@/lib/xp/store";

import type { LocalSnapshot } from "./merge";

/**
 * The pre-merge safety net — design doc §6.1, and the first requirement in the
 * brief for this step.
 *
 * > Before a single byte is uploaded: snapshot the entire local state ... This
 * > is minutes of work and it is the difference between "a bug cost someone
 * > years of tracking" and "a bug cost someone an afternoon."
 *
 * Two independent copies are made, deliberately, because they fail differently:
 *
 *   1. A record in this store, restorable in one click from the app.
 *   2. A JSON file the user can download and keep, which survives clearing
 *      site data, a broken app build, and this store itself being corrupt.
 *
 * ============================================================================
 * NEVER GARBAGE-COLLECTED
 * ============================================================================
 * §6.1 says "do not garbage-collect the backup automatically" and this module
 * has no expiry, no cap, and no cleanup path on purpose. A backup that
 * disappeared on a schedule would be gone at exactly the moment someone
 * finally noticed their library looked wrong — which is typically not the same
 * day the merge ran. Deleting one is an explicit user action.
 */

export interface BackupRecord {
  /** ISO timestamp of when the snapshot was taken. */
  takenAt: Date;
  /** Why it was taken, so a list of several is legible. */
  reason: "pre-merge";
  /** The account the merge was about to run against, so a backup taken before
   *  signing into the WRONG account is identifiable afterwards. */
  userId: string | null;
  snapshot: LocalSnapshot;
}

function isBackupRecord(data: unknown): data is BackupRecord {
  if (typeof data !== "object" || data === null) return false;
  const record = data as BackupRecord;
  return (
    record.takenAt instanceof Date &&
    typeof record.snapshot === "object" &&
    record.snapshot !== null
  );
}

/** Its own namespace, so `clear()` on any feature store can never touch it and
 *  the backup outlives every other kind of local reset. */
export const backupStore = defineStore<BackupRecord>({
  namespace: "premerge-backup",
  version: 1,
  migrations: {},
  validate: isBackupRecord,
});

/**
 * Read every local store into one plain object.
 *
 * This is also what `buildMergePlan` consumes, so the thing backed up and the
 * thing merged are the same value — there is no path where the backup captures
 * a different view of the data than the merge operates on.
 */
export async function captureLocalSnapshot(): Promise<LocalSnapshot> {
  const [tracking, ratings, watchLog, badges, highestLevelSeen] = await Promise.all([
    trackingStore.getAll(),
    ratingsStore.getAll(),
    watchLogStore.getAll(),
    badgesEarnedStore.getAll(),
    getHighestLevelSeen(),
  ]);

  return { tracking, ratings, watchLog, badges, highestLevelSeen };
}

/** True when there is nothing on this device worth merging. Drives the §6.6
 *  "run automatically vs. ask first" decision. */
export function isSnapshotEmpty(snapshot: LocalSnapshot): boolean {
  return (
    Object.keys(snapshot.tracking).length === 0 &&
    Object.keys(snapshot.ratings).length === 0 &&
    Object.keys(snapshot.watchLog).length === 0 &&
    Object.keys(snapshot.badges).length === 0
  );
}

export function backupKeyFor(takenAt: Date): string {
  // Colons are the storage layer's namespace separator, so an ISO timestamp
  // has to be sanitized before it can be a key.
  return `premerge-${takenAt.toISOString().replace(/[:.]/g, "-")}`;
}

/**
 * Take the snapshot and persist it. Returns the key, which the merge summary
 * points at.
 *
 * **Throws on failure, and the caller must not proceed.** This is the one
 * place in the codebase where a failed local write must abort the operation
 * rather than degrade: everywhere else (watch log appends, XP markers) a
 * failed write costs a nicety. Here it removes the only way back from a bad
 * merge, and the merge is about to upload the user's entire history.
 */
export async function takePreMergeBackup(
  userId: string | null,
  snapshot: LocalSnapshot,
  takenAt = new Date(),
): Promise<string> {
  const key = backupKeyFor(takenAt);
  await backupStore.set(key, { takenAt, reason: "pre-merge", userId, snapshot });
  return key;
}

export async function listBackups(): Promise<Array<{ key: string; record: BackupRecord }>> {
  const all = await backupStore.getAll();
  return Object.entries(all)
    .map(([key, record]) => ({ key, record }))
    .sort((a, b) => b.record.takenAt.getTime() - a.record.takenAt.getTime());
}

export async function deleteBackup(key: string): Promise<void> {
  await backupStore.remove(key);
}

/**
 * Put a snapshot back.
 *
 * ============================================================================
 * WHY THIS IS ADDITIVE AND NOT A TRUE ROLLBACK — SAY SO IN THE UI
 * ============================================================================
 * It restores every record the snapshot contains, overwriting whatever is
 * there now. It does **not** delete records created after the snapshot was
 * taken, because doing so would make "undo a bad merge" capable of destroying
 * everything the user tracked in the meantime — a worse failure than the one
 * it is fixing, and the exact inversion of this feature's whole point.
 *
 * The practical effect on the case that matters is complete: a merge that
 * resurrected statuses or concatenated notes is fully undone, because those
 * are overwrites of records the snapshot holds. What survives is anything
 * genuinely new, which is what the user would want kept.
 *
 * The UI must state this rather than promising a clean rollback. Anything
 * downloaded from another account still needs the "sign out and erase local
 * data" path, not this.
 */
export async function restoreSnapshot(snapshot: LocalSnapshot): Promise<void> {
  for (const [key, entry] of Object.entries(snapshot.tracking)) {
    await trackingStore.set(key, entry);
  }
  for (const [key, entry] of Object.entries(snapshot.ratings)) {
    await ratingsStore.set(key, entry);
  }
  for (const [day, events] of Object.entries(snapshot.watchLog)) {
    await watchLogStore.set(day, events);
  }
  for (const [badgeId, record] of Object.entries(snapshot.badges)) {
    await badgesEarnedStore.set(badgeId, record);
  }
  await seenLevelStore.set("seen", { highestLevelSeen: snapshot.highestLevelSeen });
}

/* ---------------------------------------------------------------------------
 * The downloadable copy
 * ------------------------------------------------------------------------ */

/**
 * Serialize a snapshot to JSON.
 *
 * Uses a plain `JSON.stringify` with an explicit Date replacer rather than
 * `lib/storage`'s internal `encode`, because this file is meant to be readable
 * by a human and possibly by a future importer. `{"__mq_date": "..."}` tagging
 * is an internal storage detail; ISO strings in a `"$date"` wrapper are
 * self-describing. The `version` field is what lets a future restore path know
 * which shape it is looking at.
 */
export function snapshotToJson(record: BackupRecord): string {
  return JSON.stringify(
    {
      format: "marquee-backup",
      version: 1,
      takenAt: record.takenAt.toISOString(),
      userId: record.userId,
      data: record.snapshot,
    },
    function replacer(key, value) {
      // Must be a `function`, not an arrow: JSON.stringify calls
      // Date.prototype.toJSON BEFORE the replacer sees the value, so by then
      // it is already a string and `instanceof Date` is false. `this[key]`
      // reaches the original, and an arrow does not receive that binding.
      // Same trap documented in lib/storage/serialize.ts.
      const original = (this as Record<string, unknown>)[key];
      if (original instanceof Date) return { $date: original.toISOString() };
      return value;
    },
    2,
  );
}

/** Filename for the download. Dated so several are distinguishable in a
 *  Downloads folder. */
export function backupFilename(takenAt: Date): string {
  const stamp = takenAt.toISOString().slice(0, 19).replace(/[:]/g, "-");
  return `marquee-backup-${stamp}.json`;
}
