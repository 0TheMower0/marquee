"use client";

import { badgesEarnedStore } from "@/lib/badges/store";
import { getHomeConfig, homeConfigStore } from "@/lib/home";
import { ratingsStore } from "@/lib/ratings/store";
import { trackingStore } from "@/lib/tracking/store";
import { watchLogStore } from "@/lib/watchlog/store";
import { seenLevelStore } from "@/lib/xp/store";

import { SyncBackendError } from "./backend";
import {
  captureLocalSnapshot,
  isSnapshotEmpty,
  takePreMergeBackup,
} from "./backup";
import {
  buildMergePlan,
  type MergePlan,
  type MergeSummary,
  type RemoteSnapshot,
} from "./merge";
import {
  markFailed,
  pendingTimestamps,
  readyEntries,
  removeEntries,
} from "./outbox";
import { reconcileEpisodes, reconcileRating, reconcileTitle } from "./reconcile";
import { getCursor, getMergeRecord, getSyncNotes, setCursor, setMergeRecord } from "./state";
import {
  SYNC_TABLES,
  type BadgeEarnedRow,
  type HomeConfigRow,
  type OutboxEntry,
  type RatingNoteRow,
  type RatingRow,
  type SyncBackend,
  type SyncTable,
  type TrackedTitleRow,
  type WatchEventRow,
  type WatchedEpisodeRow,
  type XpStateRow,
} from "./types";
import { outboxKey } from "./outbox";
import { rowToHomeConfig, rowToWatchEvent, titleRowKey } from "./wire";

/**
 * Orchestration: the first-login merge, the outbox flush, and the pull.
 *
 * Everything here is sequencing and I/O. Every rule that decides what data
 * *becomes* lives in `merge.ts` or `reconcile.ts`, both pure and both tested.
 * That split is deliberate — this file is the part that is hard to unit test,
 * so it is kept as close to logic-free as possible.
 */

/* ---------------------------------------------------------------------------
 * Cross-tab coordination — closes the gap CLAUDE.md has documented since
 * Phase 2.
 * ------------------------------------------------------------------------ */

const CHANNEL_NAME = "marquee-sync";
const LOCK_NAME = "marquee-sync-flush";

let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  channel ??= new BroadcastChannel(CHANNEL_NAME);
  return channel;
}

/** Tell other tabs that local storage changed under them. */
export function announceLocalChange(): void {
  getChannel()?.postMessage({ type: "local-changed" });
}

export function subscribeToOtherTabs(onChange: () => void): () => void {
  const bus = getChannel();
  if (!bus) return () => {};
  const handler = (event: MessageEvent) => {
    if (event.data?.type === "local-changed") onChange();
  };
  bus.addEventListener("message", handler);
  return () => bus.removeEventListener("message", handler);
}

/**
 * Run `task` with an exclusive cross-tab lock.
 *
 * Design doc §5 calls multi-tab "a prerequisite, not a nice-to-have": two tabs
 * each holding their own outbox would push the same records twice and, worse,
 * interleave read-modify-write cycles on the same day record in the watch log.
 *
 * The Web Locks API is the right primitive — it is cross-tab, it releases
 * automatically when a tab crashes or is closed (which a localStorage-based
 * mutex cannot promise), and it queues rather than spinning. Where it is
 * unavailable the task simply runs unguarded: sync is idempotent throughout,
 * so the failure mode is duplicated work rather than corruption.
 */
async function withFlushLock<T>(task: () => Promise<T>): Promise<T | null> {
  if (typeof navigator === "undefined" || !navigator.locks) return task();

  return navigator.locks.request(
    LOCK_NAME,
    // `ifAvailable` so a second tab skips instead of queueing. Queueing would
    // mean every tab eventually runs the same flush against an outbox the
    // first one already emptied.
    { ifAvailable: true },
    async (lock) => (lock ? task() : null),
  );
}

/* ---------------------------------------------------------------------------
 * Writing a merge plan into local storage
 * ------------------------------------------------------------------------ */

async function applyMergeLocally(plan: MergePlan): Promise<void> {
  for (const [key, entry] of Object.entries(plan.local.tracking)) {
    await trackingStore.set(key, entry);
  }
  for (const [key, entry] of Object.entries(plan.local.ratings)) {
    await ratingsStore.set(key, entry);
  }
  for (const [day, events] of Object.entries(plan.local.watchLog)) {
    await watchLogStore.set(day, events);
  }
  for (const [badgeId, record] of Object.entries(plan.local.badges)) {
    await badgesEarnedStore.set(badgeId, record);
  }
  await seenLevelStore.set("seen", { highestLevelSeen: plan.local.highestLevelSeen });
}

/* ---------------------------------------------------------------------------
 * The first-login merge
 * ------------------------------------------------------------------------ */

export async function fetchRemoteSnapshot(backend: SyncBackend): Promise<RemoteSnapshot> {
  const [trackedTitles, watchedEpisodes, ratings, ratingNotes, watchEvents, badges, xp, homeConfig] =
    await Promise.all([
      backend.pull<TrackedTitleRow>("tracked_titles", null),
      backend.pull<WatchedEpisodeRow>("watched_episodes", null),
      backend.pull<RatingRow>("ratings", null),
      backend.pull<RatingNoteRow>("rating_notes", null),
      backend.pull<WatchEventRow>("watch_events", null),
      backend.pull<BadgeEarnedRow>("badges_earned", null),
      backend.pull<XpStateRow>("xp_state", null),
      backend.pull<HomeConfigRow>("home_config", null),
    ]);

  return {
    trackedTitles,
    watchedEpisodes,
    ratings,
    ratingNotes,
    watchEvents,
    badges,
    xp: xp[0] ?? null,
    homeConfig: homeConfig[0] ?? null,
  };
}

export interface MergeDecision {
  /** Both sides hold data, so §6.6 requires an explicit confirmation — the one
   *  guard against merging your library into someone else's account. */
  needsConfirmation: boolean;
  localCounts: { titles: number; ratings: number; days: number };
  remoteCounts: { titles: number; ratings: number; days: number };
}

/** Look before merging, so the UI can ask when it must and stay silent when it
 *  need not. Performs no writes. */
export async function inspectBeforeMerge(backend: SyncBackend): Promise<MergeDecision> {
  const local = await captureLocalSnapshot();
  const remote = await fetchRemoteSnapshot(backend);

  const localEmpty = isSnapshotEmpty(local);
  const remoteEmpty =
    remote.trackedTitles.length === 0 &&
    remote.ratings.length === 0 &&
    remote.watchEvents.length === 0 &&
    remote.badges.length === 0;

  return {
    // Automatic when EITHER side is empty. Those are the two cases that cannot
    // go wrong, and requiring a dialog on them is friction placed exactly
    // where there is no risk.
    needsConfirmation: !localEmpty && !remoteEmpty,
    localCounts: {
      titles: Object.keys(local.tracking).length,
      ratings: Object.keys(local.ratings).length,
      days: Object.keys(local.watchLog).length,
    },
    remoteCounts: {
      titles: remote.trackedTitles.length,
      ratings: remote.ratings.length,
      days: new Set(remote.watchEvents.map((event) => event.day_key)).size,
    },
  };
}

/**
 * The merge. Safe to run repeatedly — that IS the crash-recovery strategy
 * (§6.2), and `merge.test.ts` pins it with a full replay.
 *
 * Order is not negotiable:
 *   1. Snapshot and back up. If the backup write fails, ABORT — see
 *      `takePreMergeBackup`. Everything after this point is recoverable only
 *      because this step happened.
 *   2. Pull the remote side.
 *   3. Build the plan (pure).
 *   4. Write local first, then push. Local-first because a crash between the
 *      two leaves the device correct and the server stale, which the next
 *      flush fixes. The reverse leaves the server ahead of a device that has
 *      already told the user it merged.
 */
export async function runFirstLoginMerge(
  userId: string,
  backend: SyncBackend,
  options: { now?: Date } = {},
): Promise<MergeSummary> {
  const now = options.now ?? new Date();

  const local = await captureLocalSnapshot();
  const backupKey = await takePreMergeBackup(userId, local, now);

  const remote = await fetchRemoteSnapshot(backend);
  const plan = await buildMergePlan(userId, local, remote, { now, backupKey });

  await applyMergeLocally(plan);

  const syncNotes = await getSyncNotes();
  for (const table of SYNC_TABLES) {
    if (table === "rating_notes" && !syncNotes) continue;
    const rows = plan.push[table];
    if (rows.length > 0) {
      await backend.push(table, rows as unknown as Record<string, unknown>[]);
    }
  }

  // Cursors start from what the merge actually saw. Rows we just pushed carry
  // a newer server `updated_at`, so the next pull re-downloads our own writes
  // exactly once and reconciles them as no-ops — local already matches, so
  // every comparison returns "keep".
  for (const table of SYNC_TABLES) {
    const newest = newestCursorValue(table, remote);
    if (newest) await setCursor(userId, table, newest);
  }

  await setMergeRecord({
    userId,
    completedAt: now,
    backupKey,
    summary: plan.summary,
    acknowledged: false,
  });

  announceLocalChange();
  return plan.summary;
}

function newestCursorValue(table: SyncTable, remote: RemoteSnapshot): string | null {
  const stamps: Array<string | undefined> = (() => {
    switch (table) {
      case "tracked_titles":
        return remote.trackedTitles.map((row) => row.updated_at);
      case "watched_episodes":
        return remote.watchedEpisodes.map((row) => row.updated_at);
      case "ratings":
        return remote.ratings.map((row) => row.updated_at);
      case "rating_notes":
        return remote.ratingNotes.map((row) => row.updated_at);
      case "watch_events":
        return remote.watchEvents.map((row) => row.updated_at);
      case "badges_earned":
        return remote.badges.map((row) => row.updated_at);
      case "xp_state":
        return remote.xp ? [remote.xp.updated_at] : [];
      case "home_config":
        return remote.homeConfig ? [remote.homeConfig.updated_at] : [];
    }
  })();

  let newest: string | null = null;
  for (const stamp of stamps) {
    if (stamp && (!newest || stamp > newest)) newest = stamp;
  }
  return newest;
}

export async function hasMerged(userId: string): Promise<boolean> {
  return (await getMergeRecord(userId)) !== null;
}

/* ---------------------------------------------------------------------------
 * Push — flush the outbox
 * ------------------------------------------------------------------------ */

export interface FlushResult {
  sent: number;
  failed: number;
  /** Set when a failure is NOT connectivity — the state that must be visible. */
  permanentError: string | null;
  offline: boolean;
}

export async function flushOutbox(backend: SyncBackend): Promise<FlushResult> {
  const result = await withFlushLock(async () => {
    const entries = await readyEntries();
    if (entries.length === 0) {
      return { sent: 0, failed: 0, permanentError: null, offline: false };
    }

    // Grouped so a batch of 300 episodes is one request, not 300. Grouping
    // preserves the per-record failure guarantee because a failed group only
    // marks its own entries, never the whole outbox.
    const byTable = new Map<SyncTable, OutboxEntry[]>();
    for (const entry of entries) {
      const list = byTable.get(entry.table);
      if (list) list.push(entry);
      else byTable.set(entry.table, [entry]);
    }

    let sent = 0;
    let failed = 0;
    let permanentError: string | null = null;
    let offline = false;

    const syncNotes = await getSyncNotes();

    // SYNC_TABLES order, not Map insertion order: `watched_episodes` has a
    // foreign key to `tracked_titles`, so an episode pushed before its title
    // fails with a 23503 — and 23503 is classified permanent, which would park
    // a perfectly good write in the error state forever.
    for (const table of SYNC_TABLES) {
      const group = byTable.get(table);
      if (!group || group.length === 0) continue;

      if (table === "rating_notes" && !syncNotes) {
        // The user turned off note syncing. Drop the entries rather than
        // leaving them to accumulate and retry forever.
        await removeEntries(group);
        continue;
      }

      try {
        await backend.push(table, group.map((entry) => entry.row));
        await removeEntries(group);
        sent += group.length;
      } catch (error) {
        failed += group.length;
        const message =
          error instanceof SyncBackendError ? error.message : "Sync failed.";
        const retryable = error instanceof SyncBackendError ? error.retryable : true;

        await markFailed(group, message);
        if (retryable) offline = true;
        else permanentError ??= message;
      }
    }

    return { sent, failed, permanentError, offline };
  });

  return result ?? { sent: 0, failed: 0, permanentError: null, offline: false };
}

/* ---------------------------------------------------------------------------
 * Pull — apply server changes to local
 * ------------------------------------------------------------------------ */

export async function pullChanges(userId: string, backend: SyncBackend): Promise<number> {
  const pending = await pendingTimestamps();
  const pendingFor = (table: SyncTable) => (key: string) =>
    pending.get(outboxKey(table, key)) ?? null;

  let applied = 0;

  /* ----- tracked_titles ------------------------------------------------- */
  const titleRows = await backend.pull<TrackedTitleRow>(
    "tracked_titles",
    await getCursor(userId, "tracked_titles"),
  );
  for (const row of titleRows) {
    const key = titleRowKey(row.media_type, row.title_id);
    const local = await trackingStore.get(key);
    const decision = reconcileTitle(
      local ?? undefined,
      row,
      pendingFor("tracked_titles")(key),
    );
    if (decision.action === "write") {
      await trackingStore.set(key, decision.entry);
      applied += 1;
    } else if (decision.action === "delete") {
      await trackingStore.remove(key);
      applied += 1;
    }
  }
  await advanceCursor(userId, "tracked_titles", titleRows.map((r) => r.updated_at));

  /* ----- watched_episodes ----------------------------------------------- */
  const episodeRows = await backend.pull<WatchedEpisodeRow>(
    "watched_episodes",
    await getCursor(userId, "watched_episodes"),
  );
  const episodesByTitle = new Map<string, WatchedEpisodeRow[]>();
  for (const row of episodeRows) {
    const key = titleRowKey(row.media_type, row.title_id);
    const list = episodesByTitle.get(key);
    if (list) list.push(row);
    else episodesByTitle.set(key, [row]);
  }
  const appliedEpisodeStamps: Array<string | undefined> = [];
  for (const [key, rows] of episodesByTitle) {
    const local = await trackingStore.get(key);
    // An episode row whose title is not here yet is SKIPPED, and its timestamp
    // is deliberately left out of the cursor advance below. The FK guarantees
    // the title exists on the server, so the ordering is transient — but if
    // the cursor moved past these rows now, the pull that finally brings the
    // title would never re-deliver them and that episode progress would be
    // silently absent on this device forever.
    if (!local || local.mediaType !== "tv") continue;

    const next = reconcileEpisodes(
      local.watchedEpisodes,
      rows,
      pendingFor("watched_episodes"),
    );
    await trackingStore.set(key, { ...local, watchedEpisodes: next });
    appliedEpisodeStamps.push(...rows.map((row) => row.updated_at));
    applied += 1;
  }
  await advanceCursor(userId, "watched_episodes", appliedEpisodeStamps);

  /* ----- ratings and notes ---------------------------------------------- */
  const scoreRows = await backend.pull<RatingRow>(
    "ratings",
    await getCursor(userId, "ratings"),
  );
  const syncNotes = await getSyncNotes();
  const noteRows = syncNotes
    ? await backend.pull<RatingNoteRow>("rating_notes", await getCursor(userId, "rating_notes"))
    : [];

  const ratingKeys = new Set<string>();
  const scoresByKey = new Map<string, RatingRow>();
  const notesByKey = new Map<string, RatingNoteRow>();
  for (const row of scoreRows) {
    const key = titleRowKey(row.media_type, row.title_id);
    scoresByKey.set(key, row);
    ratingKeys.add(key);
  }
  for (const row of noteRows) {
    const key = titleRowKey(row.media_type, row.title_id);
    notesByKey.set(key, row);
    ratingKeys.add(key);
  }

  for (const key of ratingKeys) {
    const local = await ratingsStore.get(key);
    const scoreRow = scoresByKey.get(key);
    const noteRow = notesByKey.get(key);
    const identity = scoreRow ?? noteRow!;
    const decision = reconcileRating(
      local ?? undefined,
      scoreRow,
      noteRow,
      pendingFor("ratings")(key) ?? pendingFor("rating_notes")(key),
      { mediaType: identity.media_type, titleId: identity.title_id },
    );
    if (decision.action === "write") {
      await ratingsStore.set(key, decision.entry);
      applied += 1;
    } else if (decision.action === "delete") {
      await ratingsStore.remove(key);
      applied += 1;
    }
  }
  await advanceCursor(userId, "ratings", scoreRows.map((r) => r.updated_at));
  if (syncNotes) {
    await advanceCursor(userId, "rating_notes", noteRows.map((r) => r.updated_at));
  }

  /* ----- watch_events: append-only union -------------------------------- */
  const eventRows = await backend.pull<WatchEventRow>(
    "watch_events",
    await getCursor(userId, "watch_events"),
  );
  const eventsByDay = new Map<string, WatchEventRow[]>();
  for (const row of eventRows) {
    const list = eventsByDay.get(row.day_key);
    if (list) list.push(row);
    else eventsByDay.set(row.day_key, [row]);
  }
  for (const [day, rows] of eventsByDay) {
    const existing = (await watchLogStore.get(day)) ?? [];
    const seen = new Set(existing.map((event) => event.id).filter(Boolean));
    const additions = rows.filter((row) => !seen.has(row.id)).map(rowToWatchEvent);
    if (additions.length === 0) continue;
    await watchLogStore.set(day, [...existing, ...additions]);
    applied += additions.length;
  }
  await advanceCursor(userId, "watch_events", eventRows.map((r) => r.updated_at));

  /* ----- badges: union, earliest wins ------------------------------------ */
  const badgeRows = await backend.pull<BadgeEarnedRow>(
    "badges_earned",
    await getCursor(userId, "badges_earned"),
  );
  for (const row of badgeRows) {
    const local = await badgesEarnedStore.get(row.badge_id);
    const incoming = new Date(row.earned_at);
    if (!local || incoming.getTime() < local.earnedAt.getTime()) {
      await badgesEarnedStore.set(row.badge_id, { earnedAt: incoming });
      applied += 1;
    }
  }
  await advanceCursor(userId, "badges_earned", badgeRows.map((r) => r.updated_at));

  /* ----- xp_state: greatest --------------------------------------------- */
  const xpRows = await backend.pull<XpStateRow>(
    "xp_state",
    await getCursor(userId, "xp_state"),
  );
  for (const row of xpRows) {
    const local = await seenLevelStore.get("seen");
    const highest = Math.max(local?.highestLevelSeen ?? 1, row.highest_level_seen);
    if (highest !== local?.highestLevelSeen) {
      await seenLevelStore.set("seen", { highestLevelSeen: highest });
      applied += 1;
    }
  }
  await advanceCursor(userId, "xp_state", xpRows.map((r) => r.updated_at));

  /* ----- home_config: newer client_updated_at wins, wholesale ------------
   *
   * Same rule as the first-login merge's `pickNewerHomeConfig` — no union,
   * because an arbitrary preference blob has no honest union. Unlike the
   * merge, this compares against local's OWN `updatedAt` rather than trusting
   * the pull alone: a pending outbox write for home_config (this device
   * mid-edit, not yet pushed) must not be clobbered by an older remote row
   * arriving on the same pull. Same pending-write guard every other
   * reconcile function in this file already applies.
   */
  const homeConfigRows = await backend.pull<HomeConfigRow>(
    "home_config",
    await getCursor(userId, "home_config"),
  );
  if (homeConfigRows.length > 0) {
    const remoteConfig = rowToHomeConfig(homeConfigRows[homeConfigRows.length - 1]);
    const localConfig = await getHomeConfig();
    if (remoteConfig && (!localConfig || remoteConfig.updatedAt > localConfig.updatedAt)) {
      // The raw store, not setHomeConfig() — this value just came FROM the
      // outbox's own remote counterpart, so pushing it back would only
      // re-queue what the server already has. Same reasoning as xp_state's
      // seenLevelStore.set(...) two blocks up.
      await homeConfigStore.set("config", remoteConfig);
      applied += 1;
    }
  }
  await advanceCursor(userId, "home_config", homeConfigRows.map((r) => r.updated_at));

  if (applied > 0) announceLocalChange();
  return applied;
}

async function advanceCursor(
  userId: string,
  table: SyncTable,
  stamps: Array<string | undefined>,
): Promise<void> {
  let newest: string | null = null;
  for (const stamp of stamps) {
    if (stamp && (!newest || stamp > newest)) newest = stamp;
  }
  if (newest) await setCursor(userId, table, newest);
}

/* ---------------------------------------------------------------------------
 * One full cycle
 * ------------------------------------------------------------------------ */

export interface SyncCycleResult extends FlushResult {
  pulled: number;
}

/**
 * Push before pull, always.
 *
 * Pushing first means our own pending writes are on the server before we ask
 * what the server has, so the rows that come back already reflect them and
 * the pending-write guard in `reconcile.ts` has less work to do. Pulling first
 * would routinely hand us state that is about to be superseded by the outbox
 * we have not flushed yet.
 */
export async function syncOnce(
  userId: string,
  backend: SyncBackend,
): Promise<SyncCycleResult> {
  const flushed = await flushOutbox(backend);
  let pulled = 0;
  try {
    pulled = await pullChanges(userId, backend);
  } catch (error) {
    const message = error instanceof SyncBackendError ? error.message : "Sync failed.";
    const retryable = error instanceof SyncBackendError ? error.retryable : true;
    return {
      ...flushed,
      pulled: 0,
      offline: flushed.offline || retryable,
      permanentError: flushed.permanentError ?? (retryable ? null : message),
    };
  }
  return { ...flushed, pulled };
}
