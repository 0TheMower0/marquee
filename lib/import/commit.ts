import type { TitleSummary } from "@/lib/content/types";
import { ratingsStore } from "@/lib/ratings/store";
import type { RatingEntry } from "@/lib/ratings/types";
import { announceLocalChange } from "@/lib/sync/engine";
import {
  recordRatingWrite,
  recordTitleWrite,
  recordWatchEvents,
} from "@/lib/sync/record";
import { trackingStore } from "@/lib/tracking/store";
import { entryKey, type TrackingEntry, type TrackingStatus } from "@/lib/tracking/types";
import { watchLogStore } from "@/lib/watchlog/store";
import { WATCH_KIND, type DayKey, type WatchEvent } from "@/lib/watchlog/types";

import type { ImportRow, ResolvedRow } from "./types";

/**
 * Writing a resolved import into local storage.
 *
 * ============================================================================
 * WHY THIS IS A CURSOR WALK AND NOT A TRANSACTION
 * ============================================================================
 * localStorage has no transactions — the same fact that forced per-record
 * lazy migrations in `lib/storage` rather than a whole-namespace upgrade
 * pass. So there is no "apply 3,000 rows atomically" available at any price.
 *
 * Instead rows commit one at a time and a cursor advances after each one
 * succeeds. Interrupted at row 900, a resumed commit starts at 900. The state
 * that survives is always a real prefix of the intended result, never a
 * half-written record, because each individual store write is itself atomic.
 *
 * ============================================================================
 * ADDITIVE ONLY. NOTHING HERE REMOVES OR DOWNGRADES.
 * ============================================================================
 * The rules are the first-login merge's (design doc §4, and the same
 * union/max semantics `lib/sync/merge.ts` uses), for the same reason: an
 * import joins two histories that never knew about each other, so "later"
 * is meaningless and only "more" is safe.
 *
 *   status   max progress — an existing `watched` is NEVER demoted to an
 *            imported `watchlist`
 *   score    local wins unless the user explicitly chose "prefer imported"
 *   note     never touched
 *   events   appended, deduplicated by deterministic id
 *
 * The worst outcome this can produce is a duplicate or a resurrection. It
 * cannot lose anything the user already had.
 *
 * ============================================================================
 * EVERY LOCAL WRITE HERE MUST ALSO GO THROUGH lib/sync/record.ts
 * ============================================================================
 * Shipped without this and found afterwards, by noticing there was no outbox
 * at all while cleaning up test data: an import wrote straight to
 * `trackingStore` / `ratingsStore` / `watchLogStore` and never reached the
 * sync seam, so for a signed-in user a three-thousand-row import landed on
 * ONE device and silently never appeared on any other.
 *
 * That is the failure mode `record.ts`'s own header warns about from the
 * other direction: every mutation in this app passes through a small number
 * of choke points, and an operation added later is covered automatically
 * *because* it goes through the funnel. This module bypassed the funnels and
 * therefore got none of it.
 *
 * Nothing complained, because nothing could: the local write succeeded, the
 * UI was correct, and the tests used an in-memory driver with no sync layer
 * mounted. `commit-sync.test.ts` now installs a real sync user and asserts on
 * the real outbox contents, so a future write added here without a recorder
 * fails a test instead of quietly not syncing.
 */

/** Progress order. A commit may only move a title UP this ladder. */
const STATUS_RANK: Record<TrackingStatus, number> = {
  watchlist: 0,
  watching: 1,
  watched: 2,
};

/** What a row asserts about status. `rating-only` implies watched — you do
 *  not rate a film you have not seen — which is why it is not its own rank. */
function intendedStatus(row: ImportRow): TrackingStatus {
  return row.intent === "watchlist" ? "watchlist" : "watched";
}

export interface CommitOptions {
  /** When a title already carries a local score, overwrite it with the
   *  imported one. Off by default: the local value is the one the user
   *  entered in this app, deliberately, and silently replacing it with a
   *  five-year-old IMDb rating is a loss they did not ask for. */
  preferImportedScores?: boolean;
  /**
   * Treat an IMDb `Date Rated` as an approximate watch date.
   *
   * Off by default, and the default matters: IMDb records no watch dates at
   * all, so turning this on manufactures a viewing history that will drive
   * streaks and Year in Review. That is the exact fabrication the watch log's
   * no-backfill rule exists to refuse, so it is only ever done when the user
   * asks for it in as many words.
   */
  useRatingDateAsWatchDate?: boolean;
}

export interface CommitProgress {
  /** Index into the ORIGINAL resolved list — safe to persist and resume
   *  from, because that list is stable once resolution finishes. */
  cursor: number;
  titlesWritten: number;
  eventsWritten: number;
  ratingsWritten: number;
}

/** Rows that will actually be written: decided, chosen, not skipped. An
 *  undecided row is deliberately NOT committed — walking away from the review
 *  queue must never import a guess. */
export function committableRows(resolved: readonly ResolvedRow[]): ResolvedRow[] {
  return resolved.filter((r) => !r.skipped && r.chosen !== null);
}

function toTrackingEntry(
  existing: TrackingEntry | null,
  summary: TitleSummary,
  status: TrackingStatus,
  now: Date,
): TrackingEntry {
  const base = {
    id: summary.id,
    status,
    addedAt: existing?.addedAt ?? now,
    updatedAt: now,
    // An existing snapshot is kept rather than replaced: it was taken from a
    // full `Title` fetch, while an imported one is reconstructed from a
    // search result and can be thinner.
    summary: existing?.summary ?? summary,
  };

  if (summary.mediaType === "movie") {
    return {
      ...base,
      mediaType: "movie",
      runtimeMinutes:
        existing && existing.mediaType === "movie" ? existing.runtimeMinutes : null,
    };
  }

  return {
    ...base,
    mediaType: "tv",
    // Episode progress is never touched by an import: this step imports
    // title-level status only, and overwriting a user's real episode ranges
    // with an empty object would destroy exactly the data that is hardest to
    // reconstruct.
    watchedEpisodes: existing && existing.mediaType === "tv" ? existing.watchedEpisodes : {},
    knownEpisodeCount:
      existing && existing.mediaType === "tv" ? existing.knownEpisodeCount : null,
  };
}

/** The watch date a row contributes, if any. */
function watchDateFor(row: ImportRow, options: CommitOptions): DayKey | null {
  if (row.watchedOn) return row.watchedOn;
  if (options.useRatingDateAsWatchDate && row.ratedOn) return row.ratedOn;
  return null;
}

/**
 * The event a row contributes to the watch log.
 *
 * `m` (minute of day) is deliberately omitted — `lib/watchlog/types.ts`
 * already documents that field as "omitted when genuinely unknown, which is
 * what a Phase 7 CSV import would produce". No source carries a watch TIME,
 * and inventing one would put fabricated data into Year in Review's
 * hour-of-day buckets.
 *
 * `b` (bulk) is also omitted, and that is the honest call rather than an
 * oversight: a Letterboxd diary row IS one real viewing on one real date.
 * Flagging a decade of genuine viewing history as bulk would understate it
 * exactly where it matters most.
 */
function toWatchEvent(summary: TitleSummary, id: string | null): WatchEvent {
  const event: WatchEvent = {
    k: summary.mediaType === "movie" ? WATCH_KIND.MOVIE : WATCH_KIND.TITLE,
    t: `${summary.mediaType}:${summary.id}`,
  };
  // Omitted entirely rather than set to null when signed out — `isWatchEvent`
  // rejects a present-but-empty id, and an absent one is the established
  // pre-account shape the first-login merge already knows how to assign.
  if (id) event.id = id;
  return event;
}

/**
 * Commits one row. Exported so the caller can drive the cursor, persist it,
 * and yield to the event loop between rows — a 3,000-row synchronous loop
 * would block the worker thread it runs on.
 */
export async function commitRow(
  resolved: ResolvedRow,
  eventId: string | null,
  options: CommitOptions,
  now: Date = new Date(),
): Promise<{ title: boolean; event: boolean; rating: boolean }> {
  const summary = resolved.chosen;
  if (!summary || resolved.skipped) return { title: false, event: false, rating: false };

  const { row } = resolved;
  const key = entryKey(summary.mediaType, summary.id);

  /* --- status ---------------------------------------------------------- */
  const existing = await trackingStore.get(key);
  const wanted = intendedStatus(row);
  // Max progress. This single comparison is what guarantees an import can
  // never demote something the user already watched.
  const status =
    existing && STATUS_RANK[existing.status] >= STATUS_RANK[wanted] ? existing.status : wanted;

  let titleWritten = false;
  if (!existing || status !== existing.status) {
    const entry = toTrackingEntry(existing, summary, status, now);
    await trackingStore.set(key, entry);
    // Queued AFTER the local write succeeds — `lib/sync/record.ts`'s standing
    // rule: never upload what did not persist, or the next pull reinstalls a
    // change the user never actually made. No-ops when signed out.
    await recordTitleWrite(entry);
    titleWritten = true;
  }

  /* --- rating ---------------------------------------------------------- */
  let ratingWritten = false;
  if (row.score !== null) {
    const existingRating = await ratingsStore.get(key);
    const hasLocalScore = existingRating?.score != null;

    if (!hasLocalScore || options.preferImportedScores) {
      const entry: RatingEntry = {
        id: summary.id,
        mediaType: summary.mediaType,
        score: row.score,
        // Notes are never touched — they are the user's own words and no
        // import has anything to say about them.
        note: existingRating?.note ?? "",
        updatedAt: now,
      };
      await ratingsStore.set(key, entry);
      await recordRatingWrite(entry);
      ratingWritten = true;
    }
  }

  /* --- watch event ----------------------------------------------------- */
  let eventWritten = false;
  const day = watchDateFor(row, options);
  if (day) {
    const existingDay = (await watchLogStore.get(day)) ?? [];

    // Signed in, the deterministic id makes re-running the same file a no-op
    // rather than a second copy of the user's history — and makes the SAME
    // file imported on a second device dedupe server-side too.
    //
    // Signed out there is no id to dedupe on (see `importEventId` for why
    // inventing one would be dishonest), so the guard against re-import is
    // the import job record instead: the same file is recognized and refused
    // before commit ever starts.
    const alreadyPresent = eventId !== null && existingDay.some((e) => e.id === eventId);

    if (!alreadyPresent) {
      const event = toWatchEvent(summary, eventId);
      await watchLogStore.set(day, [...existingDay, event]);
      // `dayKey` passed through verbatim, never re-derived — the row must
      // carry the date the film was actually watched, not today.
      // `recordWatchEvents` skips id-less events, which is exactly the
      // signed-out case where there is nothing to sync anyway.
      await recordWatchEvents(day, [event]);
      eventWritten = true;
    }
  }

  return { title: titleWritten, event: eventWritten, rating: ratingWritten };
}

/** Called once after a commit finishes, so other tabs re-read storage. The
 *  committing tab's own React contexts do NOT observe this yet (see the
 *  multi-tab note in CLAUDE.md), which is why the import UI navigates with a
 *  full document load rather than a client-side push. */
export function finishCommit(): void {
  announceLocalChange();
}
