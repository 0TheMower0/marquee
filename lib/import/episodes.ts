import { addRange } from "@/lib/tracking/ranges";
import type { TrackingStatus, WatchedEpisodes } from "@/lib/tracking/types";

/**
 * Merging imported episode progress into what the user already has.
 *
 * Pure — no storage, no provider, no dates. This is the file that decides
 * whether an import can ever take episode progress away, so it is kept
 * testable against plain objects for the same reason `lib/sync/merge.ts` is.
 */

export interface ImportedEpisode {
  season: number;
  episode: number;
}

/**
 * A show the user has marked watched at the TITLE level: `status: "watched"`
 * with no per-episode detail at all.
 *
 * ============================================================================
 * THE ONE CASE WHERE A UNION WOULD DEMOTE
 * ============================================================================
 * Union is monotonic, so merging imported episodes into existing ranges can
 * only ever raise the watched count — everywhere except here.
 *
 * A coarse `watched` is the user asserting they have seen **the whole show**.
 * An import claiming 40 specific episodes is LESS information than that, not
 * more: if the show has 62, merging silently discards 22 the user had already
 * claimed. Ranges grow, apparent progress falls. A demotion wearing the
 * costume of an addition.
 *
 * So these shows are left alone — see `shouldMergeRanges`. Nothing is lost
 * that was not already implied, and the moment the user next edits one episode
 * by hand `reconcileCoarseWatched` expands the coarse claim into real ranges
 * at the point of use, exactly as it does today.
 */
export function isCoarseWatched(
  status: TrackingStatus,
  watchedEpisodes: WatchedEpisodes,
): boolean {
  return status === "watched" && Object.keys(watchedEpisodes).length === 0;
}

/**
 * Whether imported episode ranges may be merged into this entry at all.
 *
 * Note what this does NOT gate: watch EVENTS. The log is append-only and
 * cannot demote anything, so a coarse-watched show still receives every date
 * the import supplies. The split follows the line this codebase already draws
 * — progress answers *how much*, the log answers *when* — and it means the
 * part an import uniquely contributes still lands even here.
 */
export function shouldMergeRanges(
  status: TrackingStatus,
  watchedEpisodes: WatchedEpisodes,
): boolean {
  return !isCoarseWatched(status, watchedEpisodes);
}

/**
 * Union imported episodes into existing progress, per season.
 *
 * Built from `addRange`, never `removeRange` — an import has no reason to ever
 * call the latter, and not importing it is a cheap way to make that
 * structural rather than a rule someone has to remember. `addRange`
 * normalizes, so the canonical invariant (sorted, non-overlapping,
 * non-adjacent) holds on the way out regardless of what order episodes
 * arrived in.
 *
 * Returns the input unchanged (by value) when nothing was added, so a caller
 * can skip a pointless write by comparing counts.
 */
export function mergeImportedEpisodes(
  existing: WatchedEpisodes,
  imported: readonly ImportedEpisode[],
): WatchedEpisodes {
  if (imported.length === 0) return existing;

  const merged: WatchedEpisodes = { ...existing };

  for (const { season, episode } of imported) {
    // Season 0 (specials) is allowed through: unlike the "mark season
    // watched" UI, an import is transcribing something the user explicitly
    // recorded elsewhere rather than inferring it. Completion math already
    // excludes season 0 on its own.
    if (!Number.isInteger(season) || !Number.isInteger(episode)) continue;
    if (season < 0 || episode < 1) continue;

    merged[season] = addRange(merged[season] ?? [], [episode, episode]);
  }

  return merged;
}

/** Total episodes across every season. Used to decide whether a merge
 *  actually changed anything, and to report honest counts in the preview. */
export function countEpisodes(watched: WatchedEpisodes): number {
  let total = 0;
  for (const ranges of Object.values(watched)) {
    for (const [start, end] of ranges) total += end - start + 1;
  }
  return total;
}
