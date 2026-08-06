/**
 * Public surface of the sync layer. Import from here, never the inner modules
 * — same rule every other `lib/` package follows.
 *
 * Design and reasoning: `docs/phase-6-sync-design.md`. Read §2.1 (why the
 * episode range encoding does not survive into Postgres), §4 (the conflict
 * rule and what it costs) and §6 (the first-login merge) before changing
 * anything here.
 *
 * The one thing to keep in mind while reading: **local storage is a complete,
 * self-sufficient replica and every UI read hits it.** The server is a
 * convergence point, never the read path. Nothing in this package is on the
 * critical path of rendering anything.
 */
export { SyncProvider, useSync } from "./context";

export {
  backupFilename,
  backupStore,
  captureLocalSnapshot,
  deleteBackup,
  isSnapshotEmpty,
  listBackups,
  restoreSnapshot,
  snapshotToJson,
  type BackupRecord,
} from "./backup";

export {
  fetchRemoteSnapshot,
  hasMerged,
  inspectBeforeMerge,
  runFirstLoginMerge,
  type MergeDecision,
} from "./engine";

export {
  buildMergePlan,
  emptyRemoteSnapshot,
  type LocalSnapshot,
  type MergePlan,
  type MergeSummary,
  type NoteConcatenation,
  type RemoteSnapshot,
  type ScoreDifference,
  type StatusDifference,
} from "./merge";

export { getSyncNotes, getMergeRecord, setSyncNotes } from "./state";
export { getSyncUser, setSyncUser } from "./record";
export { clearOutbox } from "./outbox";
export { SYNC_TABLES, type SyncPhase, type SyncState, type SyncTable } from "./types";
export { preAccountEventId, randomUuid, uuidV5 } from "./uuid";
