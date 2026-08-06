import type { MediaType } from "@/lib/content/types";
import type { TrackingStatus } from "@/lib/tracking/types";

/**
 * Server row shapes, mirroring `supabase/migrations/20260801000001_initial_schema.sql`
 * exactly, in snake_case.
 *
 * Deliberately NOT reusing the local domain types. The whole point of design
 * doc §2.1 is that the server representation differs from the local one — one
 * row per watched episode versus the range encoding — and a shared type would
 * quietly invite someone to "simplify" that away. These are wire shapes; the
 * translation between them lives in `wire.ts` and nowhere else.
 *
 * Timestamps are ISO strings, not `Date`. They cross a JSON boundary in both
 * directions and PostgREST returns strings; parsing at the edge and
 * re-serializing would add two conversions per row for no benefit. `wire.ts`
 * converts at the point local types actually need a `Date`.
 */

/**
 * NOTE: every row shape below is a `type` alias, not an `interface`, and that
 * is load-bearing rather than stylistic. TypeScript gives type aliases an
 * implicit index signature but not interfaces, so only the alias form is
 * assignable to the `Record<string, unknown>` the outbox and the backend's
 * `push` accept. Converting any of these to an interface breaks the build in
 * a way whose error message points at the call site rather than at here.
 */
export type TrackedTitleRow = {
  user_id: string;
  media_type: MediaType;
  title_id: string;
  status: TrackingStatus;
  summary: unknown;
  runtime_minutes: number | null;
  known_episode_count: number | null;
  added_at: string;
  client_updated_at: string;
  updated_at?: string;
  deleted_at: string | null;
}

export type WatchedEpisodeRow = {
  user_id: string;
  media_type: "tv";
  title_id: string;
  season_number: number;
  episode_number: number;
  client_updated_at: string;
  updated_at?: string;
  deleted_at: string | null;
}

export type RatingRow = {
  user_id: string;
  media_type: MediaType;
  title_id: string;
  score: number | null;
  client_updated_at: string;
  updated_at?: string;
  deleted_at: string | null;
}

export type RatingNoteRow = {
  user_id: string;
  media_type: MediaType;
  title_id: string;
  note: string;
  client_updated_at: string;
  updated_at?: string;
  deleted_at: string | null;
}

export type WatchEventRow = {
  id: string;
  user_id: string;
  /** "YYYY-MM-DD". A `date` column, never a timestamp — see design doc §2.3.
   *  This value is written verbatim from the client's `localDayKey()` and must
   *  never be derived from any instant, server-side or client-side. */
  day_key: string;
  kind: "episode" | "movie" | "title";
  media_type: MediaType;
  title_id: string;
  season_number: number | null;
  episode_number: number | null;
  minute_of_day: number | null;
  bulk: boolean;
  created_at?: string;
  /** Server-set. The pull cursor for this table, same as every other — see
   *  CURSOR_COLUMN in backend.ts. */
  updated_at?: string;
}

export type BadgeEarnedRow = {
  user_id: string;
  badge_id: string;
  earned_at: string;
  updated_at?: string;
}

export type XpStateRow = {
  user_id: string;
  highest_level_seen: number;
  updated_at?: string;
}

/**
 * The tables the sync loop touches, in **dependency order**.
 *
 * The order is load-bearing on push: `watched_episodes` has a foreign key to
 * `tracked_titles`, so uploading an episode before its title fails with a
 * 23503. Anything iterating tables for a push must respect this array's order
 * rather than `Object.keys()` on some record.
 */
export const SYNC_TABLES = [
  "tracked_titles",
  "watched_episodes",
  "ratings",
  "rating_notes",
  "watch_events",
  "badges_earned",
  "xp_state",
] as const;

export type SyncTable = (typeof SYNC_TABLES)[number];

/**
 * A single pending upload.
 *
 * `table` plus `key` is the outbox's own identity. For the coalescing tables
 * `key` is the natural key, so a second write to the same record replaces the
 * first (design doc §5: "toggle a status five times offline and only the final
 * state needs to reach the server"). For `watch_events` the key is the event
 * UUID, so nothing ever coalesces — every event is a distinct row.
 */
export interface OutboxEntry {
  table: SyncTable;
  key: string;
  /** The row to upsert, already in server shape. */
  row: Record<string, unknown>;
  /** When the USER acted. Drives LWW server-side and ordering here. */
  clientUpdatedAt: Date;
  /** Failed attempts so far. Drives backoff and the "stuck" warning. */
  attempts: number;
  /** Safe message from the last failure, for the sync status UI. Never an
   *  upstream string — same rule as `handleRouteError`. */
  lastError: string | null;
  /** When the next attempt becomes eligible. */
  nextAttemptAt: Date;
}

/** Per-table pull cursors plus bookkeeping, stored locally. */
export interface SyncCursorRecord {
  /** ISO string of the newest server `updated_at` seen for this table. */
  lastPulledAt: string | null;
}

export type SyncPhase =
  /** No account, or Supabase unconfigured. The zero-config path. */
  | "disabled"
  /** Signed in, nothing pending, last attempt succeeded. */
  | "idle"
  /** A push or pull is in flight. */
  | "syncing"
  /** Writes are queued and the network is unavailable. Not an error. */
  | "offline"
  /**
   * Writes are queued and attempts are failing for a reason that is NOT
   * connectivity. This is the state the brief calls out — it must be visible,
   * because someone who believes they are synced and is not will eventually
   * lose data.
   */
  | "error";

export interface SyncState {
  phase: SyncPhase;
  /** Entries waiting in the outbox. */
  pending: number;
  /** Entries that have failed enough times to be considered stuck. */
  stuck: number;
  lastSyncedAt: Date | null;
  /** Safe, user-facing text. Null unless `phase === "error"`. */
  message: string | null;
}

/**
 * The sync abstraction — the second of the two layers design doc §8 calls for,
 * alongside `lib/auth`. Same selection rule: a Supabase implementation and a
 * **null implementation that no-ops every method**, chosen on whether Supabase
 * is configured, defaulting to null.
 *
 * The null backend is what keeps the zero-config promise structural rather
 * than remembered: with no project configured, every sync call is a no-op
 * returning empty, and the app is exactly what it was in Phase 5.
 */
export interface SyncBackend {
  /** Rows changed since `since` (exclusive), for one table. `null` pulls
   *  everything — the first pull after sign-in. */
  pull<T>(table: SyncTable, since: string | null): Promise<T[]>;
  /** Upsert a batch into one table. Must be idempotent: every table is keyed
   *  so that re-sending an identical row is a no-op or a harmless rewrite. */
  push(table: SyncTable, rows: Record<string, unknown>[]): Promise<void>;
  /** Row counts per table, for the §6.6 "both sides non-empty" prompt. */
  countAll(): Promise<Record<SyncTable, number>>;
}
