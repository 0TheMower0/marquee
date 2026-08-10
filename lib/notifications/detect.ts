import type { Episode, Title } from "@/lib/content/types";
import { isFutureAirDate } from "@/lib/utils/dates";

/**
 * Deciding what changed about a SHOW — pure, no storage, no network.
 *
 * ============================================================================
 * EVERY EVENT HERE IS A WORLD FACT. NONE MAY DEPEND ON A USER.
 * ============================================================================
 * This module takes a `Title` and a previous snapshot. It has no access to
 * watch progress, follow lists, or user ids, and that is structural rather
 * than incidental — design doc §1.1's rule ("if removing all watch data would
 * remove the notification, it was a behaviour ping") is satisfied here by
 * construction, because there is no watch data in scope to remove.
 *
 * Suppression, which DOES consult watch state, happens later and separately
 * (`lib/notifications/server/store.ts`). Keeping the two apart is what stops a
 * future edit from quietly making a behaviour signal into a trigger: this file
 * cannot express one.
 */

export type NotificationEventKind = "episode_aired" | "season_announced";

/** The notifier's memory of what the provider last said about a show. */
export interface ShowSnapshot {
  showId: string;
  /** "s5e16" of the most recently AIRED episode, or null. */
  lastEpisodeKey: string | null;
  latestSeason: number | null;
  seasonsCount: number | null;
}

export interface NotificationPayload {
  title: string;
  body: string;
  /** Deep link into the app. Relative; the worker resolves it against origin. */
  url: string;
}

export interface DetectedEvent {
  showId: string;
  kind: NotificationEventKind;
  /** Dedup identity within (user, show). "s5e16" or "season:6". */
  eventKey: string;
  payload: NotificationPayload;
}

export interface DetectionResult {
  events: DetectedEvent[];
  snapshot: ShowSnapshot;
}

export function episodeKey(episode: Pick<Episode, "seasonNumber" | "episodeNumber">): string {
  return `s${episode.seasonNumber}e${episode.episodeNumber}`;
}

/**
 * Diffs a freshly-fetched title against the previous snapshot.
 *
 * **A null `previous` emits NOTHING.** The first time a show is seen, its
 * snapshot is recorded and no events are produced — a baseline is not a
 * change. Without this, the very first run after deploying would notify every
 * user about every show they follow, all at once. Same discipline as the watch
 * log's no-backfill rule and the badge ledger's silent first evaluation.
 *
 * At most ONE event per kind, ever — see `collapse` below.
 */
export function detectEvents(title: Title, previous: ShowSnapshot | null): DetectionResult {
  const snapshot = snapshotOf(title);
  if (!previous) return { events: [], snapshot };

  const events: DetectedEvent[] = [];

  const aired = airedEpisodeEvent(title, previous);
  if (aired) events.push(aired);

  const season = seasonAnnouncedEvent(title, previous);
  if (season) events.push(season);

  return { events, snapshot };
}

export function snapshotOf(title: Title): ShowSnapshot {
  const last = title.lastEpisodeToAir;
  return {
    showId: title.id,
    // Guarded even though the provider should not report an unaired episode
    // here: if it ever did, recording it would permanently suppress the real
    // notification when that episode actually airs, since the key would
    // already match. Cheap insurance against an upstream inconsistency.
    lastEpisodeKey: last && !isFutureAirDate(last.airDate) ? episodeKey(last) : null,
    latestSeason: title.seasonCount,
    seasonsCount: title.seasonCount,
  };
}

/**
 * ONE event for "new episodes aired", never one per episode.
 *
 * This is the collapse rule (design doc §2.1 rule 3), and it lives here rather
 * than in the sender because this is the only layer that can see all of a
 * show's change at once. A full-season drop — eight episodes appearing between
 * two runs — must arrive as a single "8 new episodes" notification. Eight
 * separate pushes is precisely the noise that gets notifications disabled.
 */
function airedEpisodeEvent(title: Title, previous: ShowSnapshot): DetectedEvent | null {
  const last = title.lastEpisodeToAir;
  if (!last) return null;
  if (isFutureAirDate(last.airDate)) return null;

  const key = episodeKey(last);
  if (key === previous.lastEpisodeKey) return null;

  const count = newEpisodeCount(previous.lastEpisodeKey, last);
  const label =
    count > 1
      ? `${count} new episodes`
      : `S${last.seasonNumber} · E${last.episodeNumber}${last.name ? ` — ${last.name}` : ""}`;

  return {
    showId: title.id,
    kind: "episode_aired",
    // The NEWEST episode is the dedup key. Deliberately not a synthetic
    // "range" key: if the same episode is somehow detected twice, the unique
    // constraint must recognise it, and a range key would differ depending on
    // where the previous run happened to stop.
    eventKey: key,
    payload: {
      title: title.name,
      body: count > 1 ? `${label} are out.` : `${label} is out.`,
      url: `/title/tv/${title.id}`,
    },
  };
}

/**
 * How many episodes appeared since the last snapshot, when that is knowable.
 *
 * Only computed within a SINGLE season — across a season boundary it would
 * need each intervening season's episode count, which is another fetch per
 * show for a number used in one line of copy. Falls back to 1, which
 * understates rather than overstates: claiming "12 new episodes" when 3 aired
 * is a worse failure than saying "new episode" when 12 did.
 */
function newEpisodeCount(previousKey: string | null, latest: Episode): number {
  if (!previousKey) return 1;
  const match = /^s(\d+)e(\d+)$/.exec(previousKey);
  if (!match) return 1;

  const previousSeason = Number(match[1]);
  const previousEpisode = Number(match[2]);
  if (previousSeason !== latest.seasonNumber) return 1;

  const delta = latest.episodeNumber - previousEpisode;
  return delta > 1 ? delta : 1;
}

/**
 * A season that did not exist before now does.
 *
 * "Announced" is inherently a CHANGE with no timestamp anywhere in the
 * provider's response — `number_of_seasons` going 2 -> 3 is only visible by
 * comparison. That is the entire reason `show_snapshots` exists as a table
 * rather than the detector working purely from air dates.
 */
function seasonAnnouncedEvent(title: Title, previous: ShowSnapshot): DetectedEvent | null {
  const current = title.seasonCount;
  if (current === null) return null;
  // A null previous count means we had no reading, not that it was zero —
  // treating it as zero would announce every season of a show whose snapshot
  // predates this field.
  if (previous.seasonsCount === null) return null;
  if (current <= previous.seasonsCount) return null;

  return {
    showId: title.id,
    kind: "season_announced",
    eventKey: `season:${current}`,
    payload: {
      title: title.name,
      body: `Season ${current} has been announced.`,
      url: `/title/tv/${title.id}`,
    },
  };
}
