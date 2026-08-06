"use client";

import { getSupabaseBrowserClient } from "@/lib/supabase/browser-client";

import { SYNC_TABLES, type SyncBackend, type SyncTable } from "./types";

/**
 * The sync backend — the second abstraction design doc §8 calls for, selected
 * the same way `getAuthProvider()` is: a Supabase implementation and a null
 * implementation that no-ops every method, defaulting to null.
 *
 * The null backend is what keeps the zero-config promise structural rather
 * than remembered. With no project configured, `pull` returns nothing, `push`
 * discards, and every caller upstream behaves as though the account simply has
 * no data — which is exactly the Phase 5 app.
 */

/** Conflict targets, matching each table's primary key in
 *  `supabase/migrations/20260801000001_initial_schema.sql`. Wrong values here
 *  would turn an idempotent upsert into a duplicate-key error or, worse, an
 *  update of the wrong row. */
const CONFLICT_TARGET: Record<SyncTable, string> = {
  tracked_titles: "user_id,media_type,title_id",
  watched_episodes: "user_id,media_type,title_id,season_number,episode_number",
  ratings: "user_id,media_type,title_id",
  rating_notes: "user_id,media_type,title_id",
  watch_events: "id",
  badges_earned: "user_id,badge_id",
  xp_state: "user_id",
};

/**
 * The column each table's pull cursor is ordered by.
 *
 * `updated_at` on EVERY table, without exception, and it must stay that way:
 * it is the column the pull-cursor indexes are built on. An earlier draft used
 * `created_at` for `watch_events`, reasoning that an append-only table has no
 * `updated_at` — it has one, the index is on it, and querying `created_at`
 * instead turned that pull into a sequential scan over every event the user
 * had ever logged. See the note in 20260807000001_sync_conflict_rules.sql.
 */
const CURSOR_COLUMN: Record<SyncTable, string> = {
  tracked_titles: "updated_at",
  watched_episodes: "updated_at",
  ratings: "updated_at",
  rating_notes: "updated_at",
  watch_events: "updated_at",
  badges_earned: "updated_at",
  xp_state: "updated_at",
};

/** Postgres has a parameter ceiling per statement and PostgREST bodies are not
 *  free. 500 rows keeps a 3,000-episode first upload to six requests without
 *  building a payload big enough to time out on a slow connection. */
const PUSH_CHUNK = 500;

export class SyncBackendError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SyncBackendError";
    this.retryable = retryable;
  }
}

/**
 * Whether a failure is worth retrying.
 *
 * The distinction drives the user-facing status: retryable failures are
 * "offline / will catch up", non-retryable ones are the state the brief
 * insists must be visible, because they will never resolve on their own.
 *
 * A constraint violation (23xxx) or a policy rejection (42501) means the row
 * itself is wrong. Retrying it forever would hide a real bug behind a
 * permanently spinning indicator, which is exactly the "thinks they're synced
 * and isn't" failure.
 */
function classify(error: { code?: string; message?: string } | null): SyncBackendError {
  const code = error?.code ?? "";
  const message = error?.message ?? "unknown sync failure";

  const permanent =
    code.startsWith("23") || // integrity constraint violation
    code === "42501" || // RLS / insufficient privilege
    code === "22P02" || // malformed literal (a bad uuid, say)
    code === "PGRST204" || // column not found — schema drift
    code === "PGRST301"; // JWT problem the client cannot fix by waiting

  return new SyncBackendError(message, !permanent, { cause: error });
}

export const nullSyncBackend: SyncBackend = {
  async pull() {
    return [];
  },
  async push() {
    // Silently discards. Not a failure: with no project configured there is
    // nowhere for a write to go, and the local replica is already complete.
  },
  async countAll() {
    return Object.fromEntries(SYNC_TABLES.map((table) => [table, 0])) as Record<
      SyncTable,
      number
    >;
  },
};

export function createSupabaseSyncBackend(userId: string): SyncBackend {
  return {
    async pull<T>(table: SyncTable, since: string | null): Promise<T[]> {
      const supabase = getSupabaseBrowserClient();
      if (!supabase) return [];

      let query = supabase
        .from(table)
        .select("*")
        // Redundant with RLS, which already restricts every row to the caller —
        // but explicit, so a policy regression shows up as an empty result
        // rather than as another user's data quietly entering local storage.
        .eq("user_id", userId)
        .order(CURSOR_COLUMN[table], { ascending: true });

      if (since) query = query.gt(CURSOR_COLUMN[table], since);

      const { data, error } = await query;
      if (error) throw classify(error);
      return (data ?? []) as T[];
    },

    async push(table: SyncTable, rows: Record<string, unknown>[]): Promise<void> {
      const supabase = getSupabaseBrowserClient();
      if (!supabase || rows.length === 0) return;

      for (let index = 0; index < rows.length; index += PUSH_CHUNK) {
        const chunk = rows.slice(index, index + PUSH_CHUNK);

        const { error } = await supabase.from(table).upsert(chunk, {
          onConflict: CONFLICT_TARGET[table],
          // watch_events is append-only and immutable: a re-sent event is
          // already recorded, and rewriting it would be pointless work at
          // best. DO NOTHING is what makes a replayed merge a genuine no-op.
          // Every other table needs DO UPDATE so the LWW trigger can decide.
          ignoreDuplicates: table === "watch_events",
          // We do not need the rows back, and asking for them doubles the
          // response size on a 500-row batch.
          count: undefined,
        });

        if (error) throw classify(error);
      }
    },

    async countAll(): Promise<Record<SyncTable, number>> {
      const supabase = getSupabaseBrowserClient();
      const counts = Object.fromEntries(SYNC_TABLES.map((t) => [t, 0])) as Record<
        SyncTable,
        number
      >;
      if (!supabase) return counts;

      await Promise.all(
        SYNC_TABLES.map(async (table) => {
          const { count, error } = await supabase
            .from(table)
            .select("*", { count: "exact", head: true })
            .eq("user_id", userId);
          if (error) throw classify(error);
          counts[table] = count ?? 0;
        }),
      );

      return counts;
    },
  };
}

export function getSyncBackend(userId: string | null): SyncBackend {
  if (!userId) return nullSyncBackend;
  return getSupabaseBrowserClient() ? createSupabaseSyncBackend(userId) : nullSyncBackend;
}
