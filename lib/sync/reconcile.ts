import type { RatingEntry } from "@/lib/ratings/types";
import { addRange, normalizeRanges, removeRange } from "@/lib/tracking/ranges";
import type { EpisodeRange, TrackingEntry, WatchedEpisodes } from "@/lib/tracking/types";

import type {
  RatingNoteRow,
  RatingRow,
  TrackedTitleRow,
  WatchedEpisodeRow,
} from "./types";
import { episodeRowKey, rowToTrackedTitle } from "./wire";

/**
 * Applying pulled server rows to local state — **steady-state**, not the
 * first-login merge.
 *
 * The rule here is per-record last-write-wins on `client_updated_at`, per
 * design doc §4.2, and it is deliberately different from `merge.ts`'s union-
 * and-max. §6.3 gives the reason: the merge joins two histories that never
 * knew about each other, where "later" is meaningless; this reconciles two
 * views of one shared history, where a later edit genuinely supersedes an
 * earlier one.
 *
 * Pure. Every decision is a function of (local value, server row, pending
 * write), so the ordering rules can be tested without a database.
 *
 * ============================================================================
 * THE PENDING-WRITE GUARD, AND WHY IT IS NOT OPTIONAL
 * ============================================================================
 * Every function here takes the `client_updated_at` of any *un-pushed* local
 * write for the same record. If that is at least as new as the server row, the
 * server row is ignored.
 *
 * Without it, this sequence loses a write with no conflict involved at all:
 * mark an episode offline (outbox holds it), reconnect, a pull lands before
 * the push flushes, the server's older state overwrites local, and the user's
 * mark vanishes from the screen while still sitting in the outbox — where it
 * will later be pushed, making it reappear. Guarding on the outbox makes the
 * pull idempotent with respect to work we have not sent yet.
 *
 * `>=` rather than `>` is deliberate: when a pending write and a server row
 * carry the same timestamp, the pending one is almost always the echo of our
 * own earlier push, and preferring local avoids a pointless rewrite.
 */

/* ---------------------------------------------------------------------------
 * tracked_titles
 * ------------------------------------------------------------------------ */

export type TitleAction =
  | { action: "keep" }
  | { action: "write"; entry: TrackingEntry }
  | { action: "delete" };

export function reconcileTitle(
  local: TrackingEntry | undefined,
  row: TrackedTitleRow,
  pending: Date | null,
): TitleAction {
  const remoteAt = new Date(row.client_updated_at).getTime();

  if (pending && pending.getTime() >= remoteAt) return { action: "keep" };

  if (row.deleted_at) {
    // A tombstone only removes something that is actually here. Returning
    // "delete" for a title we never had would be a wasted write, and worse, it
    // would make a full re-pull churn the store on every tombstone the account
    // has ever accumulated.
    return local ? { action: "delete" } : { action: "keep" };
  }

  if (!local) return { action: "write", entry: rowToTrackedTitle(row) };
  if (remoteAt <= local.updatedAt.getTime()) return { action: "keep" };

  // Episodes live in their own table and are reconciled separately, so a title
  // update must not clobber them with the empty object `rowToTrackedTitle`
  // produces. Carrying them across is what keeps a status change on another
  // device from wiping this device's episode progress.
  const incoming = rowToTrackedTitle(row);
  if (incoming.mediaType === "tv" && local.mediaType === "tv") {
    return {
      action: "write",
      entry: { ...incoming, watchedEpisodes: local.watchedEpisodes },
    };
  }
  return { action: "write", entry: incoming };
}

/* ---------------------------------------------------------------------------
 * watched_episodes
 * ------------------------------------------------------------------------ */

/**
 * Apply episode rows to a title's ranges.
 *
 * ============================================================================
 * WHY THERE IS NO PER-EPISODE LOCAL TIMESTAMP TO COMPARE AGAINST
 * ============================================================================
 * The range encoding structurally cannot hold one — that is the whole reason
 * it fits in a browser's storage budget (`lib/tracking/types.ts` measures the
 * 65x difference). So LWW here cannot be "compare this episode's local time to
 * the server's".
 *
 * It does not need to be. Any local episode state that has been pushed is
 * already on the server, and the server's own upsert resolved LWW at write
 * time — so a row coming back down IS the resolved answer, and applying it is
 * correct. The only local state the server does not yet know about is what is
 * still in the outbox, which is exactly what `pendingAt` covers.
 */
export function reconcileEpisodes(
  local: WatchedEpisodes,
  rows: readonly WatchedEpisodeRow[],
  pendingAt: (key: string) => Date | null,
): WatchedEpisodes {
  const next: WatchedEpisodes = { ...local };

  for (const row of rows) {
    const pending = pendingAt(
      episodeRowKey("tv", row.title_id, row.season_number, row.episode_number),
    );
    if (pending && pending.getTime() >= new Date(row.client_updated_at).getTime()) {
      continue;
    }

    const season = row.season_number;
    const single: EpisodeRange = [row.episode_number, row.episode_number];
    const current = next[season] ?? [];

    const updated = row.deleted_at
      ? removeRange(current, single)
      : addRange(current, single);

    // Stay sparse — a season emptied by tombstones loses its key rather than
    // persisting an empty array, matching `normalizeWatchedEpisodes`.
    if (updated.length > 0) next[season] = normalizeRanges(updated);
    else delete next[season];
  }

  return next;
}

/* ---------------------------------------------------------------------------
 * ratings + rating_notes -> one local RatingEntry
 * ------------------------------------------------------------------------ */

export type RatingAction =
  | { action: "keep" }
  | { action: "write"; entry: RatingEntry }
  | { action: "delete" };

/**
 * Two server rows fold into one local record, and each field takes LWW
 * independently.
 *
 * Per-field rather than per-record because the two halves come from two
 * tables with two independent `client_updated_at` values (design doc §7 keeps
 * `rating_notes` separate so a future sharing feature cannot leak a note).
 * Treating them as one record would let a score edited on the phone silently
 * revert a note edited on the laptop.
 */
export function reconcileRating(
  local: RatingEntry | undefined,
  scoreRow: RatingRow | undefined,
  noteRow: RatingNoteRow | undefined,
  pending: Date | null,
  identity: { mediaType: RatingEntry["mediaType"]; titleId: string },
): RatingAction {
  const scoreAt = scoreRow ? new Date(scoreRow.client_updated_at).getTime() : -Infinity;
  const noteAt = noteRow ? new Date(noteRow.client_updated_at).getTime() : -Infinity;
  const newestRemote = Math.max(scoreAt, noteAt);

  if (!Number.isFinite(newestRemote)) return { action: "keep" };
  if (pending && pending.getTime() >= newestRemote) return { action: "keep" };

  const localAt = local?.updatedAt.getTime() ?? -Infinity;

  const score =
    scoreRow && scoreAt > localAt
      ? scoreRow.deleted_at
        ? null
        : scoreRow.score
      : (local?.score ?? null);

  const note =
    noteRow && noteAt > localAt
      ? noteRow.deleted_at
        ? ""
        : noteRow.note
      : (local?.note ?? "");

  // Matches `mergeRatingPatch`: an entry with neither a score nor a note is
  // deleted rather than persisted as an empty husk.
  if (score === null && note.trim().length === 0) {
    return local ? { action: "delete" } : { action: "keep" };
  }

  // Nothing actually changed. Worth checking explicitly: because the two
  // halves are compared independently, a server row that loses BOTH
  // comparisons still reaches this point and would otherwise be written back
  // as an identical record — a storage write on every pull, and a misleading
  // "applied" count in the sync status.
  if (local && local.score === score && local.note === note) {
    return { action: "keep" };
  }

  return {
    action: "write",
    entry: {
      id: identity.titleId,
      mediaType: identity.mediaType,
      score,
      note,
      updatedAt: new Date(Math.max(newestRemote, localAt === -Infinity ? 0 : localAt)),
    },
  };
}
