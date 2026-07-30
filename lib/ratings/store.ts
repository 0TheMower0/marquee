import { defineStore } from "@/lib/storage";

import type { RatingEntry } from "./types";

function isRatingEntry(data: unknown): data is RatingEntry {
  if (typeof data !== "object" || data === null) return false;
  const e = data as Record<string, unknown>;

  const scoreValid =
    e.score === null ||
    (typeof e.score === "number" && Number.isInteger(e.score) && e.score >= 0 && e.score <= 100);

  return (
    typeof e.id === "string" &&
    (e.mediaType === "movie" || e.mediaType === "tv") &&
    scoreValid &&
    typeof e.note === "string" &&
    e.updatedAt instanceof Date
  );
}

/**
 * Version 1 — the first schema, so there is nothing to migrate yet. Left
 * with an explicit empty `migrations` object rather than omitted, as a
 * marker for whoever bumps this next: see the migration-design note under
 * "Local persistence" in CLAUDE.md before adding `migrations[2]`. Once
 * written, a migration can never be deleted — records migrate lazily, per
 * record, on read, so a v1 record can still be sitting in a browser years
 * from now.
 */
export const ratingsStore = defineStore<RatingEntry>({
  namespace: "ratings",
  version: 1,
  migrations: {},
  validate: isRatingEntry,
});
