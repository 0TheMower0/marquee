import { defineStore } from "@/lib/storage";

import type { OutboxEntry, SyncTable } from "./types";

/**
 * The offline write queue — design doc §5.
 *
 * ============================================================================
 * TWO MODES, AND THE DISTINCTION IS LOAD-BEARING
 * ============================================================================
 * - **Coalescing**, for state records (`tracked_titles`, `ratings`,
 *   `rating_notes`, `watched_episodes`). The outbox key is the record's
 *   natural key, so writing the same record again REPLACES the pending entry.
 *   Toggle a status five times offline and one row reaches the server; LWW
 *   makes the intermediate values irrelevant.
 * - **Accumulating**, for `watch_events`. The key is the event's own UUID, so
 *   nothing ever coalesces. Five marks are five rows, and collapsing them
 *   would erase real history.
 *
 * Nothing enforces the distinction with a flag — it falls out of what the
 * caller passes as `key`. That is why `enqueueWatchEvent` exists as its own
 * function: it makes the UUID-keyed case impossible to get wrong by habit.
 *
 * ============================================================================
 * FLUSH IS PER-RECORD, NEVER A GLOBAL QUEUE
 * ============================================================================
 * §5: "A permanently failing upsert for one title must not block every other
 * pending write behind it." So entries carry their own attempt count and
 * next-eligible time, and the flush loop skips the ones that are backing off
 * rather than stopping at the first failure. One poisoned record degrades to
 * one unsynced record, not a dead sync.
 */

function isOutboxEntry(data: unknown): data is OutboxEntry {
  if (typeof data !== "object" || data === null) return false;
  const entry = data as OutboxEntry;
  return (
    typeof entry.table === "string" &&
    typeof entry.key === "string" &&
    typeof entry.row === "object" &&
    entry.row !== null &&
    entry.clientUpdatedAt instanceof Date &&
    typeof entry.attempts === "number" &&
    entry.nextAttemptAt instanceof Date
  );
}

export const outboxStore = defineStore<OutboxEntry>({
  namespace: "sync-outbox",
  version: 1,
  migrations: {},
  validate: isOutboxEntry,
});

/** Storage key. `table` and `key` are joined with `|` because natural keys
 *  already contain `:` (`tv:1396:1:3`), and reusing that separator would make
 *  the pair ambiguous to split. */
export function outboxKey(table: SyncTable, key: string): string {
  return `${table}|${key}`;
}

/** How many failures before the UI calls a record stuck and shows the error
 *  state. Five attempts spans roughly ten minutes of backoff, which is long
 *  enough that a transient blip has resolved and short enough that a genuine
 *  problem is surfaced while the user is still in the session that caused it. */
export const STUCK_AFTER_ATTEMPTS = 5;

const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;

/** Exponential with a cap. Capped because an uncapped doubling reaches hours
 *  after a dozen failures, and a user who fixes the underlying problem should
 *  not have to wait out a backoff computed while it was broken. */
export function backoffMs(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS);
}

/**
 * Queue a state record. Overwrites any pending entry for the same natural key.
 *
 * Never throws. A failed outbox write must not fail the user's actual action —
 * the same rule the watch log follows ("marking something watched must not
 * fail because a history record couldn't be appended"). The cost of a dropped
 * outbox entry is one unsynced record, which the next full push after sign-in
 * or reconnect will pick up anyway, because pushes are built from local state.
 */
export async function enqueue(
  table: SyncTable,
  key: string,
  row: Record<string, unknown>,
  clientUpdatedAt: Date,
): Promise<void> {
  try {
    await outboxStore.set(outboxKey(table, key), {
      table,
      key,
      row,
      clientUpdatedAt,
      // Reset on every enqueue: a newer write is a genuinely new attempt and
      // should not inherit an older one's backoff. Otherwise a record that
      // failed five times would leave the user's next edit waiting minutes.
      attempts: 0,
      lastError: null,
      nextAttemptAt: new Date(0),
    });
  } catch (error) {
    console.warn("[sync] could not queue a write for sync.", error);
  }
}

/** Queue a watch-log event. Keyed by its UUID, so it can never coalesce with
 *  another event. */
export async function enqueueWatchEvent(
  id: string,
  row: Record<string, unknown>,
  clientUpdatedAt: Date,
): Promise<void> {
  await enqueue("watch_events", id, row, clientUpdatedAt);
}

export async function allEntries(): Promise<OutboxEntry[]> {
  const all = await outboxStore.getAll();
  return Object.values(all);
}

/** Entries eligible to send now, oldest intent first. Ordering by
 *  `clientUpdatedAt` means a burst of offline edits reaches the server in the
 *  order the user made them, which matters for the LWW comparison at the far
 *  end. */
export async function readyEntries(now = new Date()): Promise<OutboxEntry[]> {
  const entries = await allEntries();
  return entries
    .filter((entry) => entry.nextAttemptAt.getTime() <= now.getTime())
    .sort((a, b) => a.clientUpdatedAt.getTime() - b.clientUpdatedAt.getTime());
}

export async function removeEntries(entries: readonly OutboxEntry[]): Promise<void> {
  for (const entry of entries) {
    try {
      await outboxStore.remove(outboxKey(entry.table, entry.key));
    } catch (error) {
      console.warn("[sync] could not clear a synced outbox entry.", error);
    }
  }
}

export async function markFailed(
  entries: readonly OutboxEntry[],
  message: string,
  now = new Date(),
): Promise<void> {
  for (const entry of entries) {
    const attempts = entry.attempts + 1;
    try {
      await outboxStore.set(outboxKey(entry.table, entry.key), {
        ...entry,
        attempts,
        lastError: message,
        nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)),
      });
    } catch (error) {
      console.warn("[sync] could not record a sync failure.", error);
    }
  }
}

/**
 * The `client_updated_at` of a pending write for one record, or null.
 *
 * This is the pull-side guard described at the top of `reconcile.ts`: a server
 * row must never overwrite local state that is still waiting to be sent.
 */
export async function pendingTimestamps(): Promise<Map<string, Date>> {
  const entries = await allEntries();
  const map = new Map<string, Date>();
  for (const entry of entries) {
    const existing = map.get(outboxKey(entry.table, entry.key));
    if (!existing || existing.getTime() < entry.clientUpdatedAt.getTime()) {
      map.set(outboxKey(entry.table, entry.key), entry.clientUpdatedAt);
    }
  }
  return map;
}

export async function clearOutbox(): Promise<void> {
  await outboxStore.clear();
}
