import type { MediaType } from "@/lib/content/types";
import { isTitleSummary } from "@/lib/content/validate";
// Sub-path, not the @/lib/home barrel — matching every other cross-domain
// import in this file (tracking/ratings/watchlog all import their /types
// sub-path too), and for a load-bearing reason here specifically: the
// barrel re-exports lib/home/store.ts, which imports recordHomeConfig from
// @/lib/sync/record, which imports THIS file. Importing the barrel here
// would close that cycle for real; /types has no path back into lib/sync at
// all, so there is no cycle to reason about in the first place.
import { isHomeConfig, type HomeConfig } from "@/lib/home/types";
import { normalizeRanges } from "@/lib/tracking/ranges";
import type {
  EpisodeRange,
  TrackingEntry,
  TrackingStatus,
  WatchedEpisodes,
} from "@/lib/tracking/types";
import type { RatingEntry } from "@/lib/ratings/types";
import { WATCH_KIND, type WatchEvent } from "@/lib/watchlog/types";

import type {
  HomeConfigRow,
  RatingNoteRow,
  RatingRow,
  TrackedTitleRow,
  WatchEventRow,
  WatchedEpisodeRow,
} from "./types";

/**
 * Translation between local storage shapes and server rows. **Pure** — no
 * network, no storage, no React — which is what lets the riskiest conversion
 * in the whole feature be tested against plain values.
 *
 * ============================================================================
 * THE ASYMMETRIES THIS FILE OWNS, AND WHY THEY LIVE HERE ALONE
 * ============================================================================
 * Two local representations do not survive into Postgres unchanged, both by
 * design, and this is the *only* module that knows about either:
 *
 *   1. `WatchedEpisodes` (ranges) <-> one row per watched episode. Design doc
 *      §2.1 is entirely about why. The short version: as rows, "phone marks
 *      S3E4, laptop marks S3E5" is two inserts into two primary keys and there
 *      is no conflict at all, where a JSON blob of ranges would make it a
 *      whole-blob LWW that silently eats one device's episode.
 *   2. One `RatingEntry` (score AND note) <-> two rows, `ratings` and
 *      `rating_notes`. Design doc §7: the tables are separate so a future
 *      sharing feature *physically cannot* leak a private note, rather than
 *      relying on someone remembering to omit a column.
 *
 * Both round-trip losslessly, and the range invariant is restored by
 * construction on the way back — `rowsToWatchedEpisodes` ends in
 * `normalizeRanges`, so even a corrupt or overlapping server state cannot
 * produce a non-canonical local value.
 */

/* ---------------------------------------------------------------------------
 * Keys
 *
 * The outbox is keyed by natural key so writes to the same record coalesce
 * (design doc §5). These build those keys, and they must match the server's
 * primary keys exactly or a "coalesced" write would collide with an unrelated
 * record.
 * ------------------------------------------------------------------------ */

export function titleRowKey(mediaType: MediaType, titleId: string): string {
  return `${mediaType}:${titleId}`;
}

export function episodeRowKey(
  mediaType: MediaType,
  titleId: string,
  seasonNumber: number,
  episodeNumber: number,
): string {
  return `${mediaType}:${titleId}:${seasonNumber}:${episodeNumber}`;
}

/** Splits `${mediaType}:${id}` back apart. The id may itself contain colons
 *  (mock ids are slugs, but nothing forbids it), so this splits on the FIRST
 *  colon only rather than using `split(":")`. */
export function parseTitleKey(key: string): { mediaType: MediaType; titleId: string } | null {
  const separator = key.indexOf(":");
  if (separator <= 0) return null;
  const mediaType = key.slice(0, separator);
  if (mediaType !== "movie" && mediaType !== "tv") return null;
  return { mediaType, titleId: key.slice(separator + 1) };
}

/* ---------------------------------------------------------------------------
 * tracked_titles
 * ------------------------------------------------------------------------ */

export function trackedTitleToRow(
  userId: string,
  entry: TrackingEntry,
  options: { deleted?: boolean } = {},
): TrackedTitleRow {
  return {
    user_id: userId,
    media_type: entry.mediaType,
    title_id: entry.id,
    status: entry.status,
    summary: entry.summary,
    runtime_minutes: entry.mediaType === "movie" ? entry.runtimeMinutes : null,
    known_episode_count: entry.mediaType === "tv" ? entry.knownEpisodeCount : null,
    added_at: entry.addedAt.toISOString(),
    // `updatedAt` on the local entry IS "when the user acted" — it is set by
    // the tracking context at mutation time, never by a server. That is
    // exactly what `client_updated_at` means (design doc §4.3), so this is a
    // rename rather than a reinterpretation.
    client_updated_at: entry.updatedAt.toISOString(),
    deleted_at: options.deleted ? new Date().toISOString() : null,
  };
}

/**
 * Server row -> local entry, or `null` if the row's `summary` is not a usable
 * `TitleSummary`.
 *
 * ============================================================================
 * WHY THIS RETURNS NULL RATHER THAN TRUSTING THE STORE'S OWN VALIDATOR
 * ============================================================================
 * This used to pass `summary` through as-is, on the stated reasoning that
 * `isTrackingEntry` in the store "already runs on every read and treats a bad
 * shape as an unreadable record rather than a crash". The intent was right and
 * the implementation was not: that validator checked only that `summary` was a
 * non-null object, so a snapshot missing `placeholder` sailed through, got
 * written to local storage, and crashed every page rendering a poster.
 *
 * `isTrackingEntry` is fixed now, which closes the READ path. This closes the
 * WRITE path, and both are worth having for different reasons: the store's
 * validator protects against whatever is already on disk, while this stops a
 * malformed server row from ever being persisted in the first place — so the
 * bad row is never written, never re-read, and never has to be recovered from.
 *
 * `summary` is `unknown` on the row type by construction (it is a `jsonb`
 * column, writable by any client version), which is exactly why it needs a
 * runtime check rather than a cast. Same shape as `rowToHomeConfig`, which
 * already returns `null` for a config blob it cannot vouch for.
 */
export function rowToTrackedTitle(row: TrackedTitleRow): TrackingEntry | null {
  if (!isTitleSummary(row.summary)) return null;
  return buildTrackedTitle(row);
}

function buildTrackedTitle(row: TrackedTitleRow): TrackingEntry {
  const base = {
    id: row.title_id,
    status: row.status,
    addedAt: new Date(row.added_at),
    updatedAt: new Date(row.client_updated_at),
    summary: row.summary,
  };

  if (row.media_type === "movie") {
    return {
      ...base,
      mediaType: "movie",
      runtimeMinutes: row.runtime_minutes,
    } as TrackingEntry;
  }

  return {
    ...base,
    mediaType: "tv",
    knownEpisodeCount: row.known_episode_count,
    // Episodes arrive from their own table and are merged in separately.
    // Defaulting to `{}` here rather than leaving it undefined keeps the
    // record valid on its own, so a title row that lands before its episode
    // rows is readable rather than rejected by `isTrackingEntry`.
    watchedEpisodes: {},
  } as TrackingEntry;
}

/* ---------------------------------------------------------------------------
 * watched_episodes — the explode/collapse
 * ------------------------------------------------------------------------ */

/** Ranges -> one row per episode. */
export function episodesToRows(
  userId: string,
  titleId: string,
  watched: WatchedEpisodes,
  clientUpdatedAt: Date,
): WatchedEpisodeRow[] {
  const rows: WatchedEpisodeRow[] = [];
  const iso = clientUpdatedAt.toISOString();

  for (const [seasonKey, ranges] of Object.entries(watched)) {
    const seasonNumber = Number(seasonKey);
    if (!Number.isInteger(seasonNumber) || seasonNumber < 0) continue;

    for (const [start, end] of ranges) {
      for (let episodeNumber = start; episodeNumber <= end; episodeNumber += 1) {
        rows.push({
          user_id: userId,
          media_type: "tv",
          title_id: titleId,
          season_number: seasonNumber,
          episode_number: episodeNumber,
          client_updated_at: iso,
          deleted_at: null,
        });
      }
    }
  }
  return rows;
}

export function episodeTombstoneRow(
  userId: string,
  titleId: string,
  seasonNumber: number,
  episodeNumber: number,
  clientUpdatedAt: Date,
): WatchedEpisodeRow {
  return {
    user_id: userId,
    media_type: "tv",
    title_id: titleId,
    season_number: seasonNumber,
    episode_number: episodeNumber,
    client_updated_at: clientUpdatedAt.toISOString(),
    // A tombstone, never a hard delete. Design doc §4.2: a hard delete does
    // not commute with a concurrent insert, so an offline device re-marking
    // the episode would resurrect or lose it depending purely on sync order.
    // With a tombstone the outcome is a function of when the user acted.
    deleted_at: clientUpdatedAt.toISOString(),
  };
}

/**
 * Rows -> ranges. Tombstoned rows are skipped, so a set of rows that includes
 * deletions collapses to exactly the live episodes.
 *
 * The canonical invariant (sorted, non-overlapping, non-adjacent) is
 * re-established by `normalizeRanges` rather than assumed, which is what makes
 * this safe against a server state that somehow holds overlapping or
 * out-of-order data.
 */
export function rowsToWatchedEpisodes(rows: readonly WatchedEpisodeRow[]): WatchedEpisodes {
  const bySeason = new Map<number, number[]>();

  for (const row of rows) {
    if (row.deleted_at) continue;
    const list = bySeason.get(row.season_number);
    if (list) list.push(row.episode_number);
    else bySeason.set(row.season_number, [row.episode_number]);
  }

  const out: WatchedEpisodes = {};
  for (const [seasonNumber, episodes] of bySeason) {
    const ranges = normalizeRanges(
      episodes.map((episode): EpisodeRange => [episode, episode]),
    );
    // Stay sparse — a season with nothing watched has no key at all, matching
    // `normalizeWatchedEpisodes` in lib/tracking/store.ts.
    if (ranges.length > 0) out[seasonNumber] = ranges;
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * ratings and rating_notes — one local record, two server rows
 * ------------------------------------------------------------------------ */

export function ratingToScoreRow(
  userId: string,
  entry: RatingEntry,
  options: { deleted?: boolean } = {},
): RatingRow {
  return {
    user_id: userId,
    media_type: entry.mediaType,
    title_id: entry.id,
    score: entry.score,
    client_updated_at: entry.updatedAt.toISOString(),
    deleted_at: options.deleted ? entry.updatedAt.toISOString() : null,
  };
}

export function ratingToNoteRow(
  userId: string,
  entry: RatingEntry,
  options: { deleted?: boolean } = {},
): RatingNoteRow {
  return {
    user_id: userId,
    media_type: entry.mediaType,
    title_id: entry.id,
    note: entry.note,
    client_updated_at: entry.updatedAt.toISOString(),
    // An emptied note is a tombstone rather than an empty string, so
    // "cleared on my phone" and "never written" stay distinguishable — the
    // first must beat an older non-empty note on another device, the second
    // must not.
    deleted_at: options.deleted || entry.note.trim().length === 0
      ? entry.updatedAt.toISOString()
      : null,
  };
}

/* ---------------------------------------------------------------------------
 * watch_events
 * ------------------------------------------------------------------------ */

const KIND_TO_ROW: Record<string, WatchEventRow["kind"]> = {
  [WATCH_KIND.EPISODE]: "episode",
  [WATCH_KIND.MOVIE]: "movie",
  [WATCH_KIND.TITLE]: "title",
};

const ROW_TO_KIND: Record<string, WatchEvent["k"]> = {
  episode: WATCH_KIND.EPISODE,
  movie: WATCH_KIND.MOVIE,
  title: WATCH_KIND.TITLE,
};

/**
 * `dayKey` is passed in rather than derived, and that is the single most
 * important line in this file.
 *
 * It is the LOCAL calendar day frozen when the event was recorded — the key of
 * the record this event was read out of. Design doc §2.3 forbids deriving it
 * from any instant, anywhere, because a user who watches something at 8am in
 * Tokyo and then flies to LA would have that event silently re-file to the
 * previous day and their streak history would rewrite itself because they
 * travelled.
 */
export function watchEventToRow(
  id: string,
  userId: string,
  dayKey: string,
  event: WatchEvent,
): WatchEventRow {
  const parsed = parseTitleKey(event.t);
  return {
    id,
    user_id: userId,
    day_key: dayKey,
    kind: KIND_TO_ROW[event.k],
    media_type: parsed?.mediaType ?? "tv",
    title_id: parsed?.titleId ?? event.t,
    season_number: event.s ?? null,
    episode_number: event.e ?? null,
    minute_of_day: event.m ?? null,
    bulk: event.b === 1,
  };
}

export function rowToWatchEvent(row: WatchEventRow): WatchEvent {
  const event: WatchEvent = {
    k: ROW_TO_KIND[row.kind],
    t: `${row.media_type}:${row.title_id}`,
  };
  if (row.season_number !== null) event.s = row.season_number;
  if (row.episode_number !== null) event.e = row.episode_number;
  if (row.minute_of_day !== null) event.m = row.minute_of_day;
  if (row.bulk) event.b = 1;
  // The id is carried back so a subsequent merge or push recognizes this event
  // as already-synced rather than minting a new id for it.
  event.id = row.id;
  return event;
}

/* ---------------------------------------------------------------------------
 * Status ordering — used by the first-login merge's max-progress rule
 * ------------------------------------------------------------------------ */

/** `watchlist < watching < watched`. Design doc §6.3. */
export const STATUS_RANK: Record<TrackingStatus, number> = {
  watchlist: 0,
  watching: 1,
  watched: 2,
};

export function maxStatus(a: TrackingStatus, b: TrackingStatus): TrackingStatus {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

/* ---------------------------------------------------------------------------
 * home_config
 *
 * Unlike `xp_state`/`badges_earned` (a bare integer, converted inline where
 * it's used), this gets real translation functions here — `config` is a
 * jsonb column reachable directly through PostgREST, exactly as untrusted as
 * any other server input, and `isHomeConfig` is real validation logic worth
 * centralizing and unit-testing rather than inlining at each call site.
 * ------------------------------------------------------------------------ */

export function homeConfigToRow(userId: string, config: HomeConfig): HomeConfigRow {
  // `updatedAt` is excluded from the jsonb payload deliberately — it already
  // has a first-class column (`client_updated_at`), and storing the same
  // instant twice would let the two silently disagree after a hand migration
  // of the local record.
  const { updatedAt, ...payload } = config;
  return {
    user_id: userId,
    config: payload,
    client_updated_at: updatedAt.toISOString(),
  };
}

/**
 * Returns `null` for a `config` that doesn't validate, rather than throwing.
 * A malformed row here is a corrupt or hand-edited jsonb cell reachable
 * through the public API — the same trust level as any other server
 * response — and a reader receiving `null` is expected to fall back to
 * `DEFAULT_HOME_CONFIG`, never to crash the settings page over it.
 */
export function rowToHomeConfig(row: HomeConfigRow): HomeConfig | null {
  const candidate = {
    ...(typeof row.config === "object" && row.config !== null ? row.config : {}),
    updatedAt: new Date(row.client_updated_at),
  };
  return isHomeConfig(candidate) ? candidate : null;
}
