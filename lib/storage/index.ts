/**
 * Public surface of the storage layer.
 *
 * Call sites import from here, never from the individual modules — that is
 * what keeps the IndexedDB swap in Phase 3 a change to drivers.ts alone.
 *
 * Writes reject with `StorageError`. Handle it: a full quota or blocked
 * storage is a normal condition on the web, not an exceptional one. See
 * CLAUDE.md ("Local persistence") for the expected call-site pattern.
 */
export { defineStore } from "./store";
export { getStorageStatus } from "./drivers";
export { StorageError } from "./types";
export type {
  Migration,
  Store,
  StorageDriver,
  StorageErrorReason,
  StorageStatus,
  StoreConfig,
} from "./types";
