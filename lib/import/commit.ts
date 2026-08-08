import type { TitleSummary } from "@/lib/content/types";
import { ratingsStore } from "@/lib/ratings/store";
import type { RatingEntry } from "@/lib/ratings/types";
import { announceLocalChange } from "@/lib/sync/engine";
import {
  recordEpisodeChanges,
  recordRatingWrite,
  recordTitleWrite,
  recordWatchEvents,
} from "@/lib/sync/record";
import { trackingStore } from "@/lib/tracking/store";
import {
  entryKey,
  type TrackingEntry,
  type TrackingStatus,
  type WatchedEpisodes,
} from "@/lib/tracking/types";
import { watchLogStore } from "@/lib/watchlog/store";
import { WATCH_KIND, type DayKey, type WatchEvent } from "@/lib/watchlog/types";

import {
  countEpisodes,
  mergeImportedEpisodes,
  shouldMergeRanges,
  type ImportedEpisode,
} from "./episodes";
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

/** What `commitRow` actually wrote. Every key here must be declared in
 *  `commit-sync.test.ts`'s `SYNC_TABLES_BY_WRITE_KIND` — a test asserts that
 *  completeness, so adding a field here fails until its outbox table is
 *  written down. */
export interface CommitWrites {
  title: boolean;
  event: boolean;
  rating: boolean;
  episodes: boolean;
}

/** The episode a row identifies, if any. Both coordinates or neither, and
 *  only meaningful for a TV title. */
function episodeCoordinates(resolved: ResolvedRow): ImportedEpisode | null {
  const { row, chosen } = resolved;
  if (!chosen || chosen.mediaType !== "tv") return null;
  if (row.season === null || row.episode === null) return null;
  return { season: row.season, episode: row.episode };
}

function toTrackingEntry(
  existing: TrackingEntry | null,
  summary: TitleSummary,
  status: TrackingStatus,
  now: Date,
  watchedEpisodes?: WatchedEpisodes,
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
    // Defaults to whatever was already there. A caller that did not compute a
    // merge must never blank this — overwriting real episode ranges with an
    // empty object destroys the data hardest for a user to reconstruct.
    watchedEpisodes:
      watchedEpisodes ??
      (existing && existing.mediaType === "tv" ? existing.watchedEpisodes : {}),
    knownEpisodeCount:
      existing && existing.mediaType === "tv" ? existing.knownEpisodeCount : null,
  };
}

/** The watch moment a row contributes, if any. `minute` rides along with the
 *  day so the two always describe the same instant — a source that gave only
 *  a date yields a null minute rather than a fabricated midnight. */
function watchMomentFor(
  row: ImportRow,
  options: CommitOptions,
): { day: DayKey; minute: number | null } | null {
  if (row.watchedOn) return { day: row.watchedOn, minute: row.watchedMinute };
  // The opt-in rating-date fallback carries no time by definition — IMDb
  // records neither a watch date nor a watch time.
  if (options.useRatingDateAsWatchDate && row.ratedOn) {
    return { day: row.ratedOn, minute: null };
  }
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
function toWatchEvent(
  summary: TitleSummary,
  id: string | null,
  episode: ImportedEpisode | null,
  minute: number | null,
): WatchEvent {
  const event: WatchEvent = episode
    ? {
        k: WATCH_KIND.EPISODE,
        t: `${summary.mediaType}:${summary.id}`,
        s: episode.season,
        e: episode.episode,
      }
    : {
        k: summary.mediaType === "movie" ? WATCH_KIND.MOVIE : WATCH_KIND.TITLE,
        t: `${summary.mediaType}:${summary.id}`,
      };

  // Omitted entirely rather than set to null when signed out — `isWatchEvent`
  // rejects a present-but-empty id, and an absent one is the established
  // pre-account shape the first-login merge already knows how to assign.
  if (id) event.id = id;

  // Present only when the SOURCE recorded a time. Letterboxd and IMDb give a
  // bare calendar date, so their events stay `m`-less exactly as
  // `lib/watchlog/types.ts` anticipated; Trakt gives an instant, so its
  // events carry a real local minute rather than a fabricated one.
  if (minute !== null) event.m = minute;

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
): Promise<CommitWrites> {
  const summary = resolved.chosen;
  if (!summary || resolved.skipped) {
    return { title: false, event: false, rating: false, episodes: false };
  }

  const { row } = resolved;
  const key = entryKey(summary.mediaType, summary.id);
  const episode = episodeCoordinates(resolved);

  /* --- status and episode progress, in ONE write ------------------------ */
  const existing = await trackingStore.get(key);

  // An episode row asserts one episode, never the whole show — so it may
  // promote a title to "watching" but must never reach "watched". Whether 62
  // imported episodes actually complete a show is a question only season
  // counts can answer, and `deriveStatus` correctly declines to guess without
  // them. Leaving it at "watching" is the honest floor; the user can mark it
  // watched, and a per-episode edit later reconciles properly.
  const wanted: TrackingStatus = episode ? "watching" : intendedStatus(row);
  // Max progress. This single comparison is what guarantees an import can
  // never demote something the user already watched.
  const status =
    existing && STATUS_RANK[existing.status] >= STATUS_RANK[wanted] ? existing.status : wanted;

  const beforeEpisodes: WatchedEpisodes =
    existing && existing.mediaType === "tv" ? existing.watchedEpisodes : {};

  // The coarse-watched exception (see `episodes.ts`): a title-level "watched"
  // asserts the WHOLE show, so merging specific episodes into it would
  // silently discard every episode the import did not mention. Skipped here,
  // while the watch EVENTS below still land — the log cannot demote anything.
  const mayMerge =
    episode !== null &&
    summary.mediaType === "tv" &&
    shouldMergeRanges(existing?.status ?? "watchlist", beforeEpisodes);

  const afterEpisodes = mayMerge
    ? mergeImportedEpisodes(beforeEpisodes, [episode])
    : beforeEpisodes;

  const episodesChanged = countEpisodes(afterEpisodes) > countEpisodes(beforeEpisodes);
  const statusChanged = !existing || status !== existing.status;

  let titleWritten = false;
  let episodesWritten = false;
  if (statusChanged || episodesChanged) {
    const entry = toTrackingEntry(existing, summary, status, now, afterEpisodes);
    await trackingStore.set(key, entry);
    // Queued AFTER the local write succeeds — `lib/sync/record.ts`'s standing
    // rule: never upload what did not persist, or the next pull reinstalls a
    // change the user never actually made. No-ops when signed out.
    await recordTitleWrite(entry);
    titleWritten = statusChanged;

    if (episodesChanged) {
      // Diffed rather than re-uploaded whole: one imported episode is one row,
      // not the show's entire history. The `removed` half of that diff is
      // always empty here, because the merge is a union.
      await recordEpisodeChanges(summary.mediaType, summary.id, beforeEpisodes, afterEpisodes, now);
      episodesWritten = true;
    }
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
  const moment = watchMomentFor(row, options);
  if (moment) {
    const { day } = moment;
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
      const event = toWatchEvent(summary, eventId, episode, moment.minute);
      await watchLogStore.set(day, [...existingDay, event]);
      // `dayKey` passed through verbatim, never re-derived — the row must
      // carry the date the film was actually watched, not today.
      // `recordWatchEvents` skips id-less events, which is exactly the
      // signed-out case where there is nothing to sync anyway.
      await recordWatchEvents(day, [event]);
      eventWritten = true;
    }
  }

  return {
    title: titleWritten,
    event: eventWritten,
    rating: ratingWritten,
    episodes: episodesWritten,
  };
}

/** Called once after a commit finishes, so other tabs re-read storage. The
 *  committing tab's own React contexts do NOT observe this yet (see the
 *  multi-tab note in CLAUDE.md), which is why the import UI navigates with a
 *  full document load rather than a client-side push. */
export function finishCommit(): void {
  announceLocalChange();
}
