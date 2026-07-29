import { defineStore } from "@/lib/storage";

import type { TrackingEntry, TrackingStatus } from "./types";

const STATUSES: readonly TrackingStatus[] = ["watchlist", "watching", "watched"];

function isTrackingEntry(data: unknown): data is TrackingEntry {
  if (typeof data !== "object" || data === null) return false;
  const e = data as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    (e.mediaType === "movie" || e.mediaType === "tv") &&
    STATUSES.includes(e.status as TrackingStatus) &&
    e.addedAt instanceof Date &&
    e.updatedAt instanceof Date &&
    typeof e.summary === "object" &&
    e.summary !== null
  );
}

/**
 * Version 1 — this is the very first schema this namespace has ever had, so
 * there are no migrations yet. When Phase 3 adds episode-level progress, THIS
 * is the store whose shape changes, and the migration goes here as
 * `migrations: { 2: (old) => ... }`. Read the migration-design note under
 * "Local persistence" in CLAUDE.md before touching this — the short version
 * is that migrations run lazily per record on read, not eagerly over the
 * whole namespace, specifically so an interrupted session can't half-migrate
 * a user's library.
 */
export const trackingStore = defineStore<TrackingEntry>({
  namespace: "tracking",
  version: 1,
  validate: isTrackingEntry,
});
