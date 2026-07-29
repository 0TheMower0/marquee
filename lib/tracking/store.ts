import { defineStore } from "@/lib/storage";
import type { Migration } from "@/lib/storage";

import { normalizeRanges } from "./ranges";
import type {
  EpisodeRange,
  TrackingEntry,
  TrackingStatus,
  WatchedEpisodes,
} from "./types";

const STATUSES: readonly TrackingStatus[] = ["watchlist", "watching", "watched"];

/**
 * The v1 record shape, frozen here for reference.
 *
 * This is not dead code and must not be deleted: migrations run lazily per
 * record on read (see the design note under "Local persistence" in
 * CLAUDE.md), so a record written at v1 can still be sitting in someone's
 * browser years from now. Whoever writes migration 3 needs to be able to see
 * what migration 2 was handed.
 */
interface V1TrackingEntry {
  id: string;
  mediaType: "movie" | "tv";
  status: TrackingStatus;
  addedAt: Date;
  updatedAt: Date;
  summary: unknown;
}

/**
 * v1 -> v2: TV entries gain per-episode watched state.
 *
 * ============================================================================
 * WHY THIS MIGRATION CAN BE THIS SMALL — AND WHY THAT'S THE POINT
 * ============================================================================
 * A `Migration` is `(previous: unknown) => unknown`: pure, synchronous, and
 * given exactly one record. It cannot fetch. That is a real constraint, and
 * it bites here, because the obvious thing to want is:
 *
 *   "This show was marked `watched` in v1, so mark every episode watched."
 *
 * That is impossible. The v1 record does not know how many episodes the show
 * has — `summary` is a `TitleSummary`, which deliberately carries no
 * `seasonCount` or `episodeCount` (see the TitleSummary/Title split in
 * lib/content/types.ts). Expanding "watched" into concrete ranges would need
 * a provider call, and migrations cannot make one.
 *
 * Rather than fight that, the schema is arranged so the question never has to
 * be asked. `status` and `watchedEpisodes` are two granularities of the same
 * fact, and `status` — which v1 already stored — remains authoritative for
 * the title as a whole. A v1 `watched` show migrates to `watchedEpisodes: {}`
 * and *keeps* `status: "watched"`; the derived queries treat that as 100%
 * complete with nothing remaining. **No information is lost, because v1 never
 * had per-episode information to lose.** The migration is small because the
 * shape was designed to make it small, not because it's cutting a corner.
 *
 * The alternative — an "async migration" hook that could fetch — was
 * considered and rejected: it would reintroduce exactly the partial-failure
 * problem that lazy per-record migration exists to avoid (what is a record's
 * state when the fetch fails halfway?), and it would make reads depend on
 * network availability.
 *
 * If a user opens a migrated show and we now *do* know its season structure,
 * backfilling concrete ranges is a UI-layer reconciliation, not a migration.
 * That is a Step 2 decision, deliberately not made here.
 */
const migrateV1ToV2: Migration = (previous) => {
  if (typeof previous !== "object" || previous === null) {
    // Malformed input. Throwing marks the record unreadable, which the
    // storage layer handles by skipping it and LEAVING IT ON DISK — a bad
    // migration should never be a data-loss event.
    throw new Error("v1 tracking record is not an object");
  }

  const v1 = previous as V1TrackingEntry;

  // Movies are structurally unchanged between v1 and v2. Returned as a copy
  // rather than the same reference, so a migration can never alias the
  // caller's decoded object.
  if (v1.mediaType !== "tv") return { ...v1 };

  return { ...v1, watchedEpisodes: {} satisfies WatchedEpisodes };
};

function isEpisodeRange(value: unknown): value is EpisodeRange {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    Number.isInteger(value[0]) &&
    Number.isInteger(value[1]) &&
    value[0] >= 0 &&
    value[0] <= value[1]
  );
}

function isWatchedEpisodes(value: unknown): value is WatchedEpisodes {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.entries(value).every(([seasonKey, ranges]) => {
    // JSON object keys are strings; season numbers must survive the round
    // trip as integers. Season 0 (Specials) is legal, negatives are not.
    const seasonNumber = Number(seasonKey);
    if (!Number.isInteger(seasonNumber) || seasonNumber < 0) return false;
    return Array.isArray(ranges) && ranges.every(isEpisodeRange);
  });
}

function isTrackingEntry(data: unknown): data is TrackingEntry {
  if (typeof data !== "object" || data === null) return false;
  const e = data as Record<string, unknown>;

  const baseValid =
    typeof e.id === "string" &&
    STATUSES.includes(e.status as TrackingStatus) &&
    e.addedAt instanceof Date &&
    e.updatedAt instanceof Date &&
    typeof e.summary === "object" &&
    e.summary !== null;

  if (!baseValid) return false;

  if (e.mediaType === "movie") return true;
  if (e.mediaType === "tv") return isWatchedEpisodes(e.watchedEpisodes);
  return false;
}

/**
 * Version 2 — per-episode watched state for TV (Phase 3 Step 1).
 *
 * Read the migration-design note under "Local persistence" in CLAUDE.md
 * before bumping this again. The short version: migrations run lazily, per
 * record, on read; `migrations[2]` above can never be deleted; and a
 * migration that throws leaves the original bytes untouched on disk.
 */
export const trackingStore = defineStore<TrackingEntry>({
  namespace: "tracking",
  version: 2,
  migrations: {
    2: migrateV1ToV2,
  },
  validate: isTrackingEntry,
});

/**
 * Sanitizes decoded episode data back into canonical form.
 *
 * `validate` above proves the *shape* is right, but not that the ranges are
 * sorted, merged and non-adjacent — a hand-edited localStorage value could
 * satisfy the type and still be `[[5,9],[1,3]]`. Every read path that is
 * about to reason over ranges should run them through here first, so the
 * query functions can rely on the invariant rather than re-checking it.
 */
export function normalizeWatchedEpisodes(
  watched: WatchedEpisodes,
): WatchedEpisodes {
  const out: WatchedEpisodes = {};
  for (const [seasonKey, ranges] of Object.entries(watched)) {
    const seasonNumber = Number(seasonKey);
    const normalized = normalizeRanges(ranges);
    // Stay sparse: a season that normalizes to nothing loses its key rather
    // than persisting an empty array forever.
    if (normalized.length > 0) out[seasonNumber] = normalized;
  }
  return out;
}
