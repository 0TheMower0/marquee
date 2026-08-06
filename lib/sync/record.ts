"use client";

import type { MediaType } from "@/lib/content/types";
import type { RatingEntry } from "@/lib/ratings/types";
import type { TrackingEntry, WatchedEpisodes } from "@/lib/tracking/types";
import { addedEpisodes } from "@/lib/watchlog/diff";
import type { DayKey, WatchEvent } from "@/lib/watchlog/types";

import { enqueue, enqueueWatchEvent } from "./outbox";
import {
  episodeRowKey,
  episodeTombstoneRow,
  episodesToRows,
  ratingToNoteRow,
  ratingToScoreRow,
  titleRowKey,
  trackedTitleToRow,
  watchEventToRow,
} from "./wire";

/**
 * The seam where a local write becomes a pending upload.
 *
 * ============================================================================
 * WHY THIS HOOKS INTO THE EXISTING FUNNELS AND ADDS NO NEW ONES
 * ============================================================================
 * Every mutation in this app already passes through a small number of choke
 * points: `setStatus` / `remove` / `applyEpisodeMutation` in
 * lib/tracking/context.tsx, `applyPatch` in lib/ratings/context.tsx, and
 * `appendWatchEvents` in lib/watchlog. That is the same property Phase 5 Step 1
 * exploited to wire the watch log with one diff instead of six call sites, and
 * it works here for the same reason: an operation added later is covered
 * automatically, because it has to go through the funnel to persist at all.
 *
 * ============================================================================
 * ORDERING: LOCAL WRITE FIRST, ALWAYS
 * ============================================================================
 * Every function here is called only AFTER the local write has succeeded —
 * never log or queue what did not persist. That is the rule the watch log
 * already follows, and it matters more here: queuing a write that failed
 * locally would upload state the user's own device does not have, and the next
 * pull would then install it, resurrecting a change the user never
 * successfully made.
 *
 * None of these throw. A failed enqueue costs one unsynced record, which the
 * next full merge or manual re-sync picks up from local state anyway.
 */

/* ---------------------------------------------------------------------------
 * The signed-in user
 *
 * Module-level mutable state, which is normally forbidden in this codebase —
 * `lib/supabase/server-client.ts` explains at length why a shared client on the
 * SERVER would leak one visitor's identity to another. This module is
 * `"use client"`: a browser process serves exactly one user, so there is no
 * cross-request bleed to have. It is set by SyncProvider on sign-in and
 * cleared on sign-out.
 * ------------------------------------------------------------------------ */

let currentUserId: string | null = null;

export function setSyncUser(userId: string | null): void {
  currentUserId = userId;
}

export function getSyncUser(): string | null {
  return currentUserId;
}

/** Every recorder short-circuits through this. Signed out — the majority of
 *  sessions — nothing here does any work at all. */
function active(): string | null {
  return currentUserId;
}

/* ---------------------------------------------------------------------------
 * Tracking
 * ------------------------------------------------------------------------ */

export async function recordTitleWrite(entry: TrackingEntry): Promise<void> {
  const userId = active();
  if (!userId) return;
  const key = titleRowKey(entry.mediaType, entry.id);
  await enqueue("tracked_titles", key, trackedTitleToRow(userId, entry), entry.updatedAt);
}

export async function recordTitleDelete(entry: TrackingEntry): Promise<void> {
  const userId = active();
  if (!userId) return;
  const key = titleRowKey(entry.mediaType, entry.id);
  const at = new Date();
  // A tombstone, not a delete request. Design doc §4.2: a hard delete does not
  // commute with a concurrent insert from another device.
  await enqueue(
    "tracked_titles",
    key,
    trackedTitleToRow(userId, { ...entry, updatedAt: at }, { deleted: true }),
    at,
  );
}

/**
 * Queue exactly what changed for a title's episodes.
 *
 * Diffing rather than re-uploading the whole show is what keeps "mark one
 * episode" a one-row write instead of a 62-row one. `addedEpisodes(after,
 * before)` — arguments reversed — yields the REMOVED episodes, which become
 * tombstones. Reusing that function rather than writing an inverse keeps one
 * implementation of the range-subtraction logic.
 */
export async function recordEpisodeChanges(
  mediaType: MediaType,
  titleId: string,
  before: WatchedEpisodes,
  after: WatchedEpisodes,
  at: Date = new Date(),
): Promise<void> {
  const userId = active();
  if (!userId || mediaType !== "tv") return;

  const added = addedEpisodes(before, after);
  const removed = addedEpisodes(after, before);

  for (const { seasonNumber, episodeNumber } of added) {
    const key = episodeRowKey("tv", titleId, seasonNumber, episodeNumber);
    const [row] = episodesToRows(userId, titleId, { [seasonNumber]: [[episodeNumber, episodeNumber]] }, at);
    await enqueue("watched_episodes", key, row, at);
  }

  for (const { seasonNumber, episodeNumber } of removed) {
    const key = episodeRowKey("tv", titleId, seasonNumber, episodeNumber);
    await enqueue(
      "watched_episodes",
      key,
      episodeTombstoneRow(userId, titleId, seasonNumber, episodeNumber, at),
      at,
    );
  }
}

/* ---------------------------------------------------------------------------
 * Ratings
 * ------------------------------------------------------------------------ */

export async function recordRatingWrite(entry: RatingEntry): Promise<void> {
  const userId = active();
  if (!userId) return;
  const key = titleRowKey(entry.mediaType, entry.id);
  // Two rows from one local record — the score and the note go to separate
  // tables so a future sharing feature cannot reach the note (design doc §7).
  await enqueue("ratings", key, ratingToScoreRow(userId, entry), entry.updatedAt);
  await enqueue("rating_notes", key, ratingToNoteRow(userId, entry), entry.updatedAt);
}

export async function recordRatingDelete(
  mediaType: MediaType,
  titleId: string,
): Promise<void> {
  const userId = active();
  if (!userId) return;
  const key = titleRowKey(mediaType, titleId);
  const at = new Date();
  const empty: RatingEntry = { id: titleId, mediaType, score: null, note: "", updatedAt: at };
  await enqueue("ratings", key, ratingToScoreRow(userId, empty, { deleted: true }), at);
  await enqueue("rating_notes", key, ratingToNoteRow(userId, empty, { deleted: true }), at);
}

/* ---------------------------------------------------------------------------
 * Watch log
 * ------------------------------------------------------------------------ */

/**
 * Queue watch-log events. Each must already carry the `id` it was stored
 * under locally — see `appendWatchEvents`, which mints one at write time while
 * signed in.
 *
 * `dayKey` is passed through verbatim and never re-derived. Design doc §2.3:
 * deriving the day from an instant rewrites a user's streak history when they
 * travel.
 */
export async function recordWatchEvents(
  dayKey: DayKey,
  events: readonly WatchEvent[],
  at: Date = new Date(),
): Promise<void> {
  const userId = active();
  if (!userId) return;

  for (const event of events) {
    if (!event.id) continue;
    await enqueueWatchEvent(event.id, watchEventToRow(event.id, userId, dayKey, event), at);
  }
}

/* ---------------------------------------------------------------------------
 * Badges and XP
 * ------------------------------------------------------------------------ */

export async function recordBadgeEarned(badgeId: string, earnedAt: Date): Promise<void> {
  const userId = active();
  if (!userId) return;
  await enqueue(
    "badges_earned",
    badgeId,
    { user_id: userId, badge_id: badgeId, earned_at: earnedAt.toISOString() },
    earnedAt,
  );
}

export async function recordHighestLevel(level: number): Promise<void> {
  const userId = active();
  if (!userId) return;
  await enqueue(
    "xp_state",
    userId,
    { user_id: userId, highest_level_seen: level },
    new Date(),
  );
}
