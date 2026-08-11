import type { MediaType } from "@/lib/content/types";
import { isTitleSummary } from "@/lib/content/validate";
import type { HomeConfig } from "@/lib/home";
import type { RatingEntry } from "@/lib/ratings/types";
import { normalizeRanges } from "@/lib/tracking/ranges";
import type { TrackingEntry, TrackingStatus, WatchedEpisodes } from "@/lib/tracking/types";
import type { DayKey, WatchEvent, WatchLogDay } from "@/lib/watchlog/types";

import { preAccountEventId } from "./uuid";
import type {
  BadgeEarnedRow,
  HomeConfigRow,
  RatingNoteRow,
  RatingRow,
  TrackedTitleRow,
  WatchEventRow,
  WatchedEpisodeRow,
  XpStateRow,
} from "./types";
import {
  episodesToRows,
  homeConfigToRow,
  maxStatus,
  parseTitleKey,
  ratingToNoteRow,
  ratingToScoreRow,
  rowToHomeConfig,
  rowToWatchEvent,
  rowsToWatchedEpisodes,
  titleRowKey,
  trackedTitleToRow,
} from "./wire";

/**
 * The first-login merge.
 *
 * ============================================================================
 * WHY THIS FILE IS PURE, AND WHY THAT MATTERS MORE HERE THAN ANYWHERE ELSE
 * ============================================================================
 * `buildMergePlan` performs no storage access and no network calls. It takes
 * two snapshots and returns a plan: what to push, what local state should
 * become, and a summary of what it did. Every rule below is therefore testable
 * against plain objects — overlapping episode ranges, a title tracked
 * differently on each side, ratings that disagree, badges earned only locally
 * — without a database, a browser, or a mocked client.
 *
 * That is deliberate. This is the one operation in the app that can destroy
 * years of a user's history, and "we tested it against a real database once"
 * is not a standard that survives a refactor.
 *
 * ============================================================================
 * UNION AND MAX, NOT LAST-WRITE-WINS — AND WHY THAT IS NOT INCONSISTENT
 * ============================================================================
 * Steady-state sync (§4) uses per-record LWW. This merge does not, and design
 * doc §6.3 explains the split as one principle applied twice:
 *
 *   - The merge unions **two histories that were never connected**. Nothing on
 *     either side is stale, because neither side ever knew about the other, so
 *     "later wins" has no meaning. Union and max are correct.
 *   - Steady-state sync reconciles **two views of one shared history**, where
 *     a later edit genuinely supersedes an earlier one. LWW is correct there.
 *
 * ============================================================================
 * NO LOCAL DATA IS DELETED, AT ANY POINT
 * ============================================================================
 * Every rule below is additive or max-selecting. There is no branch that
 * removes a local title, episode, rating, note, badge, or log event. The worst
 * outcome this file can produce is a duplicate or a resurrection, which is
 * exactly the guarantee the brief asks for.
 */

/* ---------------------------------------------------------------------------
 * Snapshots
 * ------------------------------------------------------------------------ */

export interface LocalSnapshot {
  /** Keyed `${mediaType}:${id}`, as `trackingStore` stores them. */
  tracking: Record<string, TrackingEntry>;
  ratings: Record<string, RatingEntry>;
  watchLog: Record<DayKey, WatchLogDay>;
  badges: Record<string, { earnedAt: Date }>;
  highestLevelSeen: number;
  /** Null when nothing has ever been saved locally — genuinely absent, not
   *  "the default", so the merge can tell "never touched" apart from "set to
   *  what the default happens to be". */
  homeConfig: HomeConfig | null;
}

export interface RemoteSnapshot {
  trackedTitles: TrackedTitleRow[];
  watchedEpisodes: WatchedEpisodeRow[];
  ratings: RatingRow[];
  ratingNotes: RatingNoteRow[];
  watchEvents: WatchEventRow[];
  badges: BadgeEarnedRow[];
  xp: XpStateRow | null;
  homeConfig: HomeConfigRow | null;
}

export function emptyRemoteSnapshot(): RemoteSnapshot {
  return {
    trackedTitles: [],
    watchedEpisodes: [],
    ratings: [],
    ratingNotes: [],
    watchEvents: [],
    badges: [],
    xp: null,
    homeConfig: null,
  };
}

/* ---------------------------------------------------------------------------
 * Summary — design doc §6.4
 * ------------------------------------------------------------------------ */

export interface StatusDifference {
  key: string;
  title: string;
  mediaType: MediaType;
  titleId: string;
  local: TrackingStatus;
  remote: TrackingStatus;
  result: TrackingStatus;
}

export interface NoteConcatenation {
  key: string;
  title: string;
  mediaType: MediaType;
  titleId: string;
}

export interface ScoreDifference {
  key: string;
  title: string;
  local: number | null;
  remote: number | null;
  result: number | null;
}

export interface MergeSummary {
  /** Wall-clock completion, for the re-openable Profile entry. */
  completedAt: Date;
  counts: {
    titlesUploaded: number;
    titlesReceived: number;
    episodesMerged: number;
    ratingsMerged: number;
    notesMerged: number;
    watchLogDays: number;
    watchLogEvents: number;
    badgesMerged: number;
  };
  /**
   * Every title whose status differed between the two sides. Usually empty,
   * never long — and it is exactly where a max-progress resurrection shows up.
   * §6.3 accepts resurrections *because* this list makes them something the
   * user was told about rather than something they stumble on.
   */
  statusDifferences: StatusDifference[];
  /** Every title whose notes were concatenated, so an ugly merge is findable
   *  immediately rather than discovered months later. */
  noteConcatenations: NoteConcatenation[];
  /** Ratings where both sides had a score and they disagreed. The only rule in
   *  the merge that can drop a value, so it is reported. */
  scoreDifferences: ScoreDifference[];
  /** Key of the pre-merge backup, so the summary can point at it. */
  backupKey: string | null;
}

export interface MergePlan {
  push: {
    tracked_titles: TrackedTitleRow[];
    watched_episodes: WatchedEpisodeRow[];
    ratings: RatingRow[];
    rating_notes: RatingNoteRow[];
    watch_events: WatchEventRow[];
    badges_earned: BadgeEarnedRow[];
    xp_state: XpStateRow[];
    home_config: HomeConfigRow[];
  };
  /** The full local state after the merge. Written wholesale, not diffed. */
  local: {
    tracking: Record<string, TrackingEntry>;
    ratings: Record<string, RatingEntry>;
    watchLog: Record<DayKey, WatchLogDay>;
    badges: Record<string, { earnedAt: Date }>;
    highestLevelSeen: number;
    /** Null when NEITHER side had ever saved one — writing the default here
     *  would fabricate an edit that never happened. See the merge rule below. */
    homeConfig: HomeConfig | null;
  };
  summary: MergeSummary;
}

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------ */

/**
 * The display name for the merge summary.
 *
 * The field is `name`, NOT `title` — `TitleSummary` in lib/content/types.ts
 * calls it `name`. An earlier draft read `.title`, which type-checked (the
 * server row's `summary` is `unknown`) and silently made every entry in the
 * user-visible merge summary fall back to a raw provider id. Caught only by
 * building a real `TitleSummary` in the tests instead of a loose object
 * literal.
 */
function titleOf(summary: unknown, fallback: string): string {
  if (typeof summary === "object" && summary !== null) {
    const candidate = (summary as { name?: unknown }).name;
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return fallback;
}

function earlier(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

function later(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

/**
 * The marker separating two independently-authored notes.
 *
 * Dated so the affected notes are greppable, and phrased as prose rather than
 * a machine token because the user is the one who has to read and clean it.
 */
export function noteMergeMarker(when: Date): string {
  const day = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}-${String(when.getDate()).padStart(2, "0")}`;
  return `\n\n--- merged from another device, ${day} ---\n\n`;
}

/**
 * Union of local ranges and live remote episodes for one title.
 *
 * Remote **tombstones are ignored here**, which is what makes the merge
 * structurally incapable of losing an episode (§6.3). The honest consequence,
 * stated rather than hidden: if another device un-marked an episode more
 * recently than this device's last touch, the union re-uploads it, the
 * server's LWW rejects the resurrection as older, and the next pull removes it
 * locally again. That converges to the later intent, which is correct — the
 * merge simply declines to be the step that throws data away.
 */
function unionEpisodes(
  local: WatchedEpisodes,
  remoteRows: readonly WatchedEpisodeRow[],
): WatchedEpisodes {
  const remote = rowsToWatchedEpisodes(remoteRows);
  const seasons = new Set([
    ...Object.keys(local).map(Number),
    ...Object.keys(remote).map(Number),
  ]);

  const out: WatchedEpisodes = {};
  for (const season of seasons) {
    if (!Number.isInteger(season) || season < 0) continue;
    // Concatenating then normalizing is what handles overlapping and adjacent
    // ranges from the two sides — `[[1,5]]` local and `[[3,8]]` remote become
    // `[[1,8]]`, not two overlapping runs. normalizeRanges owns that; this
    // must never try to merge ranges by hand.
    const combined = normalizeRanges([...(local[season] ?? []), ...(remote[season] ?? [])]);
    if (combined.length > 0) out[season] = combined;
  }
  return out;
}

function countEpisodes(watched: WatchedEpisodes): number {
  let total = 0;
  for (const ranges of Object.values(watched)) {
    for (const [start, end] of ranges) total += end - start + 1;
  }
  return total;
}

/* ---------------------------------------------------------------------------
 * The merge
 * ------------------------------------------------------------------------ */

export async function buildMergePlan(
  userId: string,
  local: LocalSnapshot,
  remote: RemoteSnapshot,
  options: { now?: Date; backupKey?: string | null } = {},
): Promise<MergePlan> {
  const now = options.now ?? new Date();

  const summary: MergeSummary = {
    completedAt: now,
    counts: {
      titlesUploaded: 0,
      titlesReceived: 0,
      episodesMerged: 0,
      ratingsMerged: 0,
      notesMerged: 0,
      watchLogDays: 0,
      watchLogEvents: 0,
      badgesMerged: 0,
    },
    statusDifferences: [],
    noteConcatenations: [],
    scoreDifferences: [],
    backupKey: options.backupKey ?? null,
  };

  /* ----- tracked_titles + watched_episodes ------------------------------- */

  const remoteTitles = new Map<string, TrackedTitleRow>();
  for (const row of remote.trackedTitles) {
    remoteTitles.set(titleRowKey(row.media_type, row.title_id), row);
  }

  const remoteEpisodesByTitle = new Map<string, WatchedEpisodeRow[]>();
  for (const row of remote.watchedEpisodes) {
    const key = titleRowKey(row.media_type, row.title_id);
    const list = remoteEpisodesByTitle.get(key);
    if (list) list.push(row);
    else remoteEpisodesByTitle.set(key, [row]);
  }

  const mergedTracking: Record<string, TrackingEntry> = {};
  const pushTitles: TrackedTitleRow[] = [];
  const pushEpisodes: WatchedEpisodeRow[] = [];

  const allTitleKeys = new Set([
    ...Object.keys(local.tracking),
    ...remoteTitles.keys(),
  ]);

  for (const key of allTitleKeys) {
    const localEntry = local.tracking[key];
    const remoteRow = remoteTitles.get(key);
    const remoteEpisodeRows = remoteEpisodesByTitle.get(key) ?? [];

    // ---- local only: pure upload -------------------------------------
    if (localEntry && !remoteRow) {
      mergedTracking[key] = localEntry;
      pushTitles.push(trackedTitleToRow(userId, localEntry));
      summary.counts.titlesUploaded += 1;

      if (localEntry.mediaType === "tv") {
        const rows = episodesToRows(
          userId,
          localEntry.id,
          localEntry.watchedEpisodes,
          localEntry.updatedAt,
        );
        pushEpisodes.push(...rows);
        summary.counts.episodesMerged += rows.length;
      }
      continue;
    }

    // ---- remote only: pure download ----------------------------------
    if (!localEntry && remoteRow) {
      // A remote tombstone with no local counterpart is genuinely deleted;
      // materializing it locally would resurrect something the user removed on
      // another device, which is not what "never lose data" asks for — the
      // title is still recoverable from the backup and from the server row.
      if (remoteRow.deleted_at) continue;

      const received = remoteRowToEntry(remoteRow, remoteEpisodeRows);
      // An unusable summary is skipped rather than counted — reporting it as
      // "received" would put a number in the merge summary that the user
      // cannot find anywhere in their library.
      if (!received) continue;
      mergedTracking[key] = received;
      summary.counts.titlesReceived += 1;
      continue;
    }

    if (!localEntry || !remoteRow) continue;

    // ---- both sides: max-progress ------------------------------------
    const resultStatus = maxStatus(localEntry.status, remoteRow.status);

    if (localEntry.status !== remoteRow.status) {
      const parsed = parseTitleKey(key);
      summary.statusDifferences.push({
        key,
        title: titleOf(localEntry.summary, localEntry.id),
        mediaType: parsed?.mediaType ?? localEntry.mediaType,
        titleId: localEntry.id,
        local: localEntry.status,
        remote: remoteRow.status,
        result: resultStatus,
      });
    }

    const addedAt = earlier(localEntry.addedAt, new Date(remoteRow.added_at));
    const updatedAt = later(localEntry.updatedAt, new Date(remoteRow.client_updated_at));

    let merged: TrackingEntry;
    if (localEntry.mediaType === "tv") {
      const episodes = unionEpisodes(localEntry.watchedEpisodes, remoteEpisodeRows);
      merged = {
        ...localEntry,
        status: resultStatus,
        addedAt,
        updatedAt,
        watchedEpisodes: episodes,
        // Prefer non-null on the XP-only scalars: both sides may have an
        // honest gap, and one side knowing the answer is strictly better than
        // neither. Never overwrite a known value with null.
        knownEpisodeCount: localEntry.knownEpisodeCount ?? remoteRow.known_episode_count,
      };
      const rows = episodesToRows(userId, localEntry.id, episodes, updatedAt);
      pushEpisodes.push(...rows);
      summary.counts.episodesMerged += countEpisodes(episodes);
    } else {
      merged = {
        ...localEntry,
        status: resultStatus,
        addedAt,
        updatedAt,
        runtimeMinutes: localEntry.runtimeMinutes ?? remoteRow.runtime_minutes,
      };
    }

    mergedTracking[key] = merged;
    pushTitles.push(trackedTitleToRow(userId, merged));
    summary.counts.titlesUploaded += 1;
  }

  /* ----- ratings and notes ---------------------------------------------- */

  const remoteScores = new Map<string, RatingRow>();
  for (const row of remote.ratings) {
    remoteScores.set(titleRowKey(row.media_type, row.title_id), row);
  }
  const remoteNotes = new Map<string, RatingNoteRow>();
  for (const row of remote.ratingNotes) {
    remoteNotes.set(titleRowKey(row.media_type, row.title_id), row);
  }

  const mergedRatings: Record<string, RatingEntry> = {};
  const pushScores: RatingRow[] = [];
  const pushNotes: RatingNoteRow[] = [];

  const allRatingKeys = new Set([
    ...Object.keys(local.ratings),
    ...remoteScores.keys(),
    ...remoteNotes.keys(),
  ]);

  for (const key of allRatingKeys) {
    const localEntry = local.ratings[key];
    const remoteScore = remoteScores.get(key);
    const remoteNote = remoteNotes.get(key);
    const parsed = parseTitleKey(key);
    if (!parsed) continue;

    const remoteScoreValue =
      remoteScore && !remoteScore.deleted_at ? remoteScore.score : null;
    const remoteNoteValue = remoteNote && !remoteNote.deleted_at ? remoteNote.note : "";
    const remoteUpdatedAt = later(
      new Date(remoteScore?.client_updated_at ?? 0),
      new Date(remoteNote?.client_updated_at ?? 0),
    );

    if (!localEntry) {
      if (remoteScoreValue === null && remoteNoteValue.trim().length === 0) continue;
      mergedRatings[key] = {
        id: parsed.titleId,
        mediaType: parsed.mediaType,
        score: remoteScoreValue,
        note: remoteNoteValue,
        updatedAt: remoteUpdatedAt,
      };
      continue;
    }

    // Score: later `client_updated_at` wins. This is the one rule in the merge
    // that can drop a value, so it is reported in the summary. A null on one
    // side never beats a real score — "not rated" is the absence of an
    // opinion, not a later opinion.
    let score = localEntry.score;
    if (remoteScoreValue !== null && localEntry.score !== null) {
      const remoteWins =
        new Date(remoteScore!.client_updated_at).getTime() > localEntry.updatedAt.getTime();
      score = remoteWins ? remoteScoreValue : localEntry.score;
      if (remoteScoreValue !== localEntry.score) {
        summary.scoreDifferences.push({
          key,
          title: titleOf(local.tracking[key]?.summary, parsed.titleId),
          local: localEntry.score,
          remote: remoteScoreValue,
          result: score,
        });
      }
    } else if (remoteScoreValue !== null) {
      score = remoteScoreValue;
    }

    // Notes: CONCATENATE when both are non-empty and different. Two notes
    // written before either device knew about the other were authored
    // independently — neither supersedes the other, so concatenation is the
    // semantically correct merge of two separate pieces of writing. (Contrast
    // steady-state, where an edit is *intended* to replace, and concatenating
    // would accumulate every draft the user ever typed.)
    let note = localEntry.note;
    const localHasNote = localEntry.note.trim().length > 0;
    const remoteHasNote = remoteNoteValue.trim().length > 0;

    if (localHasNote && remoteHasNote && localEntry.note.trim() !== remoteNoteValue.trim()) {
      note = `${localEntry.note}${noteMergeMarker(now)}${remoteNoteValue}`;
      summary.noteConcatenations.push({
        key,
        title: titleOf(local.tracking[key]?.summary, parsed.titleId),
        mediaType: parsed.mediaType,
        titleId: parsed.titleId,
      });
    } else if (!localHasNote && remoteHasNote) {
      note = remoteNoteValue;
    }

    const mergedEntry: RatingEntry = {
      id: parsed.titleId,
      mediaType: parsed.mediaType,
      score,
      note,
      updatedAt: later(localEntry.updatedAt, remoteUpdatedAt),
    };
    mergedRatings[key] = mergedEntry;

    pushScores.push(ratingToScoreRow(userId, mergedEntry));
    pushNotes.push(ratingToNoteRow(userId, mergedEntry));
    summary.counts.ratingsMerged += 1;
    if (note.trim().length > 0) summary.counts.notesMerged += 1;
  }

  // NOTE: there is deliberately no second pass for "local-only ratings".
  // `allRatingKeys` already includes every local key, so a local-only rating
  // takes the both-sides branch above with both remote values absent — which
  // produces exactly the right upload. An earlier draft added a trailing
  // upload loop as well and pushed every local-only rating TWICE; harmless
  // against an idempotent upsert, but it inflated `ratingsMerged` in the
  // summary, which is the number the user is shown.

  /* ----- watch_events: union by UUID ------------------------------------ */

  const mergedLog: Record<DayKey, WatchLogDay> = {};
  const pushEvents: WatchEventRow[] = [];
  const remoteEventIds = new Set(remote.watchEvents.map((row) => row.id));

  for (const [dayKey, events] of Object.entries(local.watchLog)) {
    const dayEvents: WatchEvent[] = [];

    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      // Events recorded while signed in already carry a v4. Pre-account events
      // get a DETERMINISTIC v5 from (userId, dayKey, index) — recomputed
      // identically on every attempt, which is what makes a retried merge a
      // no-op instead of a second copy of the user's history. See
      // lib/sync/uuid.ts.
      const id = event.id ?? (await preAccountEventId(userId, dayKey, index));

      // ====================================================================
      // THE DERIVED ID IS WRITTEN BACK ONTO THE LOCAL EVENT
      // ====================================================================
      // Not cosmetic — without it the merge DUPLICATES the entire watch log on
      // its second run, which a replay test caught. The union step below
      // matches local against remote by `id`; a local event that never records
      // the id it was pushed under looks like a different event from the row
      // it created, so the row gets appended alongside it and the day now has
      // two copies of one mark. `hasRepeatedMark` would then report rewatches
      // that never happened.
      //
      // Writing it back is also strictly more robust than not: once every
      // event carries an id, nothing downstream depends on array indices
      // staying stable, so the one fragile assumption behind the v5 derivation
      // stops mattering after the first merge. Re-deriving is idempotent, so a
      // write-back that fails partway simply produces the same ids next time.
      dayEvents.push(event.id ? event : { ...event, id });

      if (!remoteEventIds.has(id)) {
        pushEvents.push(watchEventRowFor(id, userId, dayKey, event));
        summary.counts.watchLogEvents += 1;
      }
    }

    mergedLog[dayKey] = dayEvents;
  }

  // Remote events for days this device has never seen, plus remote events on
  // days it has. Union by id, so a day present on both sides ends up with the
  // events from both.
  for (const row of remote.watchEvents) {
    const day = row.day_key;
    const existing = mergedLog[day] ?? local.watchLog[day] ?? [];
    const alreadyPresent = existing.some((event) => event.id === row.id);
    if (alreadyPresent) continue;
    mergedLog[day] = [...existing, rowToWatchEvent(row)];
  }
  summary.counts.watchLogDays = Object.keys(mergedLog).length;

  /* ----- badges: union, earliest earned_at wins -------------------------- */

  const mergedBadges: Record<string, { earnedAt: Date }> = {};
  const pushBadges: BadgeEarnedRow[] = [];

  const remoteBadges = new Map(remote.badges.map((row) => [row.badge_id, row]));
  const allBadgeIds = new Set([...Object.keys(local.badges), ...remoteBadges.keys()]);

  for (const badgeId of allBadgeIds) {
    const localRecord = local.badges[badgeId];
    const remoteRow = remoteBadges.get(badgeId);

    // LEAST(earned_at). Monotonic and lossless: a badge is earned once, and
    // the earliest moment either device saw it is the true one.
    const earnedAt =
      localRecord && remoteRow
        ? earlier(localRecord.earnedAt, new Date(remoteRow.earned_at))
        : localRecord
          ? localRecord.earnedAt
          : new Date(remoteRow!.earned_at);

    mergedBadges[badgeId] = { earnedAt };
    pushBadges.push({ user_id: userId, badge_id: badgeId, earned_at: earnedAt.toISOString() });
    summary.counts.badgesMerged += 1;
  }

  /* ----- xp_state: GREATEST --------------------------------------------- */

  const highestLevelSeen = Math.max(
    local.highestLevelSeen,
    remote.xp?.highest_level_seen ?? 1,
  );

  /* ----- home_config: newer client_updated_at wins, WHOLESALE ------------
   *
   * No union — see the migration's header comment for why an arbitrary
   * preference blob has no honest merge. "Newer wins" needs both sides to
   * have SOMETHING to compare; if only one side has ever saved a config, that
   * side wins outright regardless of timestamp, because the other side has
   * nothing to compare against — not "loses the comparison", genuinely
   * absent from it.
   *
   * The merged value is always the one pushed back, even when remote already
   * held the newer copy — same idempotent-push shape `xp_state` already uses
   * above. Pushing the same value back with its own timestamp is a no-op the
   * LWW trigger accepts harmlessly (equal is not less-than), and it is what
   * keeps this rule this simple: no branch that conditionally skips a push.
   */
  const remoteHomeConfig = remote.homeConfig ? rowToHomeConfig(remote.homeConfig) : null;
  const homeConfig = pickNewerHomeConfig(local.homeConfig, remoteHomeConfig);
  const pushHomeConfig = homeConfig ? [homeConfigToRow(userId, homeConfig)] : [];

  return {
    push: {
      tracked_titles: pushTitles,
      watched_episodes: pushEpisodes,
      ratings: pushScores,
      rating_notes: pushNotes,
      watch_events: pushEvents,
      badges_earned: pushBadges,
      xp_state: [{ user_id: userId, highest_level_seen: highestLevelSeen }],
      home_config: pushHomeConfig,
    },
    local: {
      tracking: mergedTracking,
      ratings: mergedRatings,
      watchLog: mergedLog,
      badges: mergedBadges,
      highestLevelSeen,
      homeConfig,
    },
    summary,
  };
}

/** Null beats nothing, not the other way round — an untouched side has no
 *  timestamp to lose a comparison with. Ties favour `local` deliberately:
 *  arbitrary, but deterministic, and this rule only ever ties in a test. */
function pickNewerHomeConfig(local: HomeConfig | null, remote: HomeConfig | null): HomeConfig | null {
  if (!local) return remote;
  if (!remote) return local;
  return remote.updatedAt.getTime() > local.updatedAt.getTime() ? remote : local;
}

/**
 * Returns `null` when the row's `summary` is not a usable `TitleSummary`.
 *
 * The third write path for a server-supplied summary, alongside
 * `rowToTrackedTitle` (steady-state pull) and `isTrackingEntry` (local read).
 * All three need the check for the same reason: `summary` is a `jsonb` column
 * typed `unknown`, and an entry whose `placeholder` is missing crashes every
 * page that renders a poster. Skipping is safe HERE specifically because this
 * branch only runs for a title the local device does not have — so there is
 * nothing to lose by not materializing it, and the row stays on the server to
 * be picked up once whatever wrote it is fixed.
 */
function remoteRowToEntry(
  row: TrackedTitleRow,
  episodeRows: readonly WatchedEpisodeRow[],
): TrackingEntry | null {
  if (!isTitleSummary(row.summary)) return null;

  const base = {
    id: row.title_id,
    status: row.status,
    addedAt: new Date(row.added_at),
    updatedAt: new Date(row.client_updated_at),
    summary: row.summary,
  };

  if (row.media_type === "movie") {
    return { ...base, mediaType: "movie", runtimeMinutes: row.runtime_minutes } as TrackingEntry;
  }
  return {
    ...base,
    mediaType: "tv",
    knownEpisodeCount: row.known_episode_count,
    watchedEpisodes: rowsToWatchedEpisodes(episodeRows),
  } as TrackingEntry;
}

/** Local `WatchEvent` -> row, resolving `${mediaType}:${id}` back apart. Kept
 *  here rather than in wire.ts only because it needs the already-resolved id. */
function watchEventRowFor(
  id: string,
  userId: string,
  dayKey: DayKey,
  event: WatchEvent,
): WatchEventRow {
  const parsed = parseTitleKey(event.t);
  const kind =
    event.k === "e" ? "episode" : event.k === "m" ? "movie" : "title";
  return {
    id,
    user_id: userId,
    day_key: dayKey,
    kind,
    media_type: parsed?.mediaType ?? "tv",
    title_id: parsed?.titleId ?? event.t,
    season_number: event.s ?? null,
    episode_number: event.e ?? null,
    minute_of_day: event.m ?? null,
    bulk: event.b === 1,
  };
}
