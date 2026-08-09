import type { Episode } from "@/lib/content/types";
import {
  reconcileCoarseWatched,
  nextUnwatchedEpisode,
  type SeasonEpisodeCounts,
  type TrackingEntry,
  type TvTrackingEntry,
} from "@/lib/tracking";
import { dayDifference } from "@/lib/watchlog/types";

/**
 * The new-episode feed (Phase 7) — a calendar-style view of what's coming up
 * (or has just landed and gone unwatched) across every show being tracked.
 *
 * Deliberately NOT a reimplementation of the Up Next ranking engine
 * (lib/tracking/upnext.ts) — it's the SAME underlying question ("what's the
 * next unwatched episode for this show, and has it aired?"), asked over a
 * wider set of shows and grouped by date instead of scored for relevance. So
 * this reuses `reconcileCoarseWatched` + `nextUnwatchedEpisode` directly
 * rather than duplicating them, the same two functions Up Next's own
 * `selectUpNextCandidates` calls.
 *
 * Everything here is pure: no storage, no fetching, no React — same split as
 * upnext.ts. The orchestration hook (components/schedule/use-schedule.ts)
 * owns fetching `SeasonEpisodeCounts` and each candidate's target season's
 * `Episode[]`, and passes them in already resolved.
 */

export interface ScheduleCandidate {
  entry: TvTrackingEntry;
  seasonNumber: number;
  episodeNumber: number;
}

/**
 * Shows worth checking for new episodes: anything actively "watching" OR
 * already "watched". Widened by exactly one status beyond Up Next's own
 * `selectUpNextCandidates`, which stops at "watching" ("continue", not
 * "discover") — the feed's single most valuable state, a title marked fully
 * "watched" that has SINCE aired a episode nobody told it about, only exists
 * for shows Up Next has already stopped looking at.
 *
 * `"watchlist"` is excluded: nothing has been started, so there is no
 * "haven't watched it yet" tension to surface, and fetching season data for
 * an entire watchlist (which can be large and is often aspirational rather
 * than active) would widen the fetch-cost problem for a state that has
 * nothing urgent to report.
 *
 * A show with no entry in `seasonsByShowId` (fetch pending or failed) is
 * skipped rather than blocking the rest of the feed — same graceful
 * degradation `selectUpNextCandidates` uses.
 */
export function selectScheduleCandidates(
  entries: Record<string, TrackingEntry>,
  seasonsByShowId: Record<string, SeasonEpisodeCounts>,
): ScheduleCandidate[] {
  const candidates: ScheduleCandidate[] = [];

  for (const entry of Object.values(entries)) {
    if (entry.mediaType !== "tv") continue;
    if (entry.status !== "watching" && entry.status !== "watched") continue;

    const seasons = seasonsByShowId[entry.id];
    if (!seasons) continue;

    const watched = reconcileCoarseWatched(entry, seasons);
    const next = nextUnwatchedEpisode(watched, seasons);
    // null means fully caught up on everything TMDB currently lists for this
    // show — which is exactly "between seasons with nothing dated yet" or
    // "ended and fully watched". Both are handled by producing nothing,
    // rather than a separate "nothing new" entry that would just be noise in
    // a feed whose whole point is surfacing what's actionable.
    if (!next) continue;

    candidates.push({ entry, seasonNumber: next.seasonNumber, episodeNumber: next.episodeNumber });
  }

  return candidates;
}

/**
 * `"ready"` covers anything aired already — including an unknown air date,
 * which counts as actionable now rather than blocking the feed on data TMDB
 * never supplied (matches `isFutureAirDate`'s own null handling). It is
 * DELIBERATELY not split further into a literal "today" bucket: this
 * project's one existing convention for calendar dates
 * (`isFutureAirDate`, lib/utils/dates.ts) already treats a same-day air date
 * as "already aired, watch it now" — introducing a second, competing
 * definition of "today" here would be exactly the kind of inconsistency
 * CLAUDE.md warns against elsewhere (see the `localDayKey` vs
 * `toISOString().slice(0, 10)` note in lib/watchlog). A same-day episode is
 * the single most valuable thing this feed can show, so it belongs in the
 * headline bucket, not filed one tier down as merely "today's upcoming".
 */
export type ScheduleBucket = "ready" | "this-week" | "later";

export interface ScheduleItem extends ScheduleCandidate {
  episode: Episode;
  bucket: ScheduleBucket;
}

/** Rolling 7-day window from tomorrow, not a calendar-week (Sun/Mon start),
 *  to sidestep locale ambiguity entirely — "this week" means "within the next
 *  7 days", which needs no definition of which day a week starts on. */
const THIS_WEEK_DAYS = 7;

/**
 * `isFutureAirDate` (lib/utils/dates.ts) always reads the real system clock,
 * with no way to pin "today" for a test — fine for a plain then/else, but
 * this function needs a THIRD outcome (this-week vs later) that has to agree
 * with the same "today" on pain of a same-day episode landing in "ready" by
 * one check and "this-week" by the other. So this reimplements the identical
 * comparison via `dayDifference` against an explicit `today`, rather than
 * calling `isFutureAirDate` for the ready/not-ready split and risking the two
 * disagreeing. `daysUntil <= 0` is exactly `isFutureAirDate`'s own rule —
 * today or earlier counts as already aired.
 */
function bucketFor(airDate: string | null, today: string): ScheduleBucket {
  if (!airDate) return "ready"; // unknown — matches isFutureAirDate's null handling
  const daysUntil = dayDifference(today, airDate.slice(0, 10));
  if (daysUntil <= 0) return "ready";
  return daysUntil <= THIS_WEEK_DAYS ? "this-week" : "later";
}

/** UTC "today", matching `isFutureAirDate`'s own convention for comparing
 *  against a calendar-date (not-an-instant) air date — see the note there.
 *  Deliberately NOT `localDayKey()` (lib/watchlog/types.ts): that is the
 *  correct "today" for a watch EVENT, which is anchored to where the user
 *  physically was, but an air date is TMDB's own UTC-dated schedule and
 *  should be compared against the same reference `isFutureAirDate` uses,
 *  or a same-day episode could bucket differently depending on which check
 *  ran. */
function todayForAirDates(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * One candidate becomes one item only once its target episode's real data is
 * in hand — a candidate whose fetch hasn't settled yet is dropped rather than
 * guessed at, matching `rankUpNext`'s own "caller must wait for every
 * episode fetch to settle" contract (upnext.ts). The caller is expected to
 * hold off calling this until every candidate's stage-2 fetch has resolved,
 * or an item would visibly jump buckets the moment real data arrives.
 */
export function buildScheduleItems(
  candidates: readonly ScheduleCandidate[],
  episodesByShowId: Record<string, Episode[] | null>,
  today: string = todayForAirDates(),
): ScheduleItem[] {
  const items: ScheduleItem[] = [];

  for (const candidate of candidates) {
    const episodes = episodesByShowId[candidate.entry.id];
    const episode = episodes?.find(
      (e) => e.seasonNumber === candidate.seasonNumber && e.episodeNumber === candidate.episodeNumber,
    );
    if (!episode) continue;

    items.push({ ...candidate, episode, bucket: bucketFor(episode.airDate, today) });
  }

  return items;
}

export interface ScheduleFeed {
  /** Aired (including today, including an unknown air date) and unwatched —
   *  the headline section. Most recently aired first. */
  ready: ScheduleItem[];
  /** Future, within THIS_WEEK_DAYS. Soonest first. */
  thisWeek: ScheduleItem[];
  /** Future, beyond that. Soonest first. */
  later: ScheduleItem[];
}

/** Splits and sorts. A missing/unknown air date sorts last within `ready`
 *  (empty string collates before any real date) — there's nothing to rank it
 *  against, so it falls to the bottom rather than jumping to the top. */
export function groupSchedule(items: readonly ScheduleItem[]): ScheduleFeed {
  const ready: ScheduleItem[] = [];
  const thisWeek: ScheduleItem[] = [];
  const later: ScheduleItem[] = [];

  for (const item of items) {
    if (item.bucket === "ready") ready.push(item);
    else if (item.bucket === "this-week") thisWeek.push(item);
    else later.push(item);
  }

  ready.sort((a, b) => (b.episode.airDate ?? "").localeCompare(a.episode.airDate ?? ""));
  thisWeek.sort((a, b) => (a.episode.airDate ?? "").localeCompare(b.episode.airDate ?? ""));
  later.sort((a, b) => (a.episode.airDate ?? "").localeCompare(b.episode.airDate ?? ""));

  return { ready, thisWeek, later };
}
