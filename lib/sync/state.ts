import { defineStore } from "@/lib/storage";

import type { MergeSummary } from "./merge";
import type { SyncTable } from "./types";

/**
 * Device-local sync bookkeeping: pull cursors, which accounts this device has
 * already merged into, and the last merge summary.
 *
 * Design doc §7 lists all of this under "never syncs — device-local by
 * nature". A pull cursor is a statement about what THIS replica has seen;
 * uploading it would be meaningless at best and, if another device's cursor
 * were ever applied here, would silently skip rows this device never received.
 */

/* ---------------------------------------------------------------------------
 * Pull cursors
 * ------------------------------------------------------------------------ */

interface CursorRecord {
  /** Newest server `updated_at` already applied for this table, ISO. */
  lastPulledAt: string | null;
}

function isCursorRecord(data: unknown): data is CursorRecord {
  if (typeof data !== "object" || data === null) return false;
  const record = data as CursorRecord;
  return record.lastPulledAt === null || typeof record.lastPulledAt === "string";
}

/** Keyed by `${userId}|${table}`, so signing into a different account on the
 *  same device starts from a clean cursor rather than inheriting one that
 *  would skip every row written before the switch. */
export const cursorStore = defineStore<CursorRecord>({
  namespace: "sync-cursor",
  version: 1,
  migrations: {},
  validate: isCursorRecord,
});

function cursorKey(userId: string, table: SyncTable): string {
  return `${userId}|${table}`;
}

export async function getCursor(userId: string, table: SyncTable): Promise<string | null> {
  const record = await cursorStore.get(cursorKey(userId, table));
  return record?.lastPulledAt ?? null;
}

/**
 * Advance the cursor.
 *
 * Only ever moves forward. A pull that returns rows out of order, or a clock
 * oddity on the server, must not be able to rewind the cursor and cause the
 * same rows to be re-applied forever. Re-applying is harmless (reconciliation
 * is idempotent) but it would mean every sync re-downloads the account.
 */
export async function setCursor(
  userId: string,
  table: SyncTable,
  lastPulledAt: string,
): Promise<void> {
  const current = await getCursor(userId, table);
  if (current && current >= lastPulledAt) return;
  try {
    await cursorStore.set(cursorKey(userId, table), { lastPulledAt });
  } catch (error) {
    console.warn("[sync] could not persist a pull cursor.", error);
  }
}

/* ---------------------------------------------------------------------------
 * Merge state
 * ------------------------------------------------------------------------ */

export interface MergeRecord {
  userId: string;
  completedAt: Date;
  backupKey: string | null;
  summary: MergeSummary;
  /** Set when the user has dismissed the summary. The record itself is kept —
   *  §6.4 asks for the summary to stay re-openable from Profile, because the
   *  merge happens at the exact moment the user is busy doing something else
   *  and least likely to read carefully. */
  acknowledged: boolean;
}

function isMergeRecord(data: unknown): data is MergeRecord {
  if (typeof data !== "object" || data === null) return false;
  const record = data as MergeRecord;
  return typeof record.userId === "string" && record.completedAt instanceof Date;
}

export const mergeStore = defineStore<MergeRecord>({
  namespace: "sync-merge",
  version: 1,
  migrations: {},
  validate: isMergeRecord,
});

/** Keyed by account, so "has this device merged into this account" is a
 *  per-(device, account) fact — which is what §6.7 means by "first login is
 *  per device, not per account". */
export async function getMergeRecord(userId: string): Promise<MergeRecord | null> {
  return mergeStore.get(userId);
}

export async function setMergeRecord(record: MergeRecord): Promise<void> {
  await mergeStore.set(record.userId, record);
}

export async function acknowledgeMerge(userId: string): Promise<void> {
  const record = await getMergeRecord(userId);
  if (!record) return;
  try {
    await mergeStore.set(userId, { ...record, acknowledged: true });
  } catch (error) {
    console.warn("[sync] could not acknowledge the merge summary.", error);
  }
}

/* ---------------------------------------------------------------------------
 * Notes sync preference — design doc §7
 * ------------------------------------------------------------------------ */

interface PreferencesRecord {
  /** Default ON. Off keeps private notes on this device; scores still sync. */
  syncNotes: boolean;
}

function isPreferencesRecord(data: unknown): data is PreferencesRecord {
  return (
    typeof data === "object" &&
    data !== null &&
    typeof (data as PreferencesRecord).syncNotes === "boolean"
  );
}

export const syncPreferencesStore = defineStore<PreferencesRecord>({
  namespace: "sync-preferences",
  version: 1,
  migrations: {},
  validate: isPreferencesRecord,
});

const PREFERENCES_KEY = "preferences";

/**
 * §7 asks for "a single 'sync private notes' toggle, default on ... Some
 * people genuinely want notes never to leave one device, and honoring that is
 * one skipped table in the sync loop."
 *
 * Defaulting to true when the record is missing means the absence of a
 * preference is not the same as opting out — a storage read failure must not
 * silently stop syncing someone's notes.
 */
export async function getSyncNotes(): Promise<boolean> {
  const record = await syncPreferencesStore.get(PREFERENCES_KEY);
  return record?.syncNotes ?? true;
}

export async function setSyncNotes(syncNotes: boolean): Promise<void> {
  await syncPreferencesStore.set(PREFERENCES_KEY, { syncNotes });
}
