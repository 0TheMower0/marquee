import { removeRange } from "@/lib/tracking/ranges";
import type { EpisodeRange, WatchedEpisodes } from "@/lib/tracking/types";

/**
 * What episodes did this mutation newly mark as watched?
 *
 * This is the whole wiring strategy for the log, and it is why there is no
 * per-operation logging code. `applyEpisodeMutation` in
 * lib/tracking/context.tsx is already the single funnel every episode
 * operation passes through — `markEpisode`, `markSeason`, `markSeasonUpTo`,
 * `markWatchedUpTo` — and it holds both the before and after `WatchedEpisodes`.
 * Diffing those two covers every operation uniformly, including ones added
 * later, and cannot drift out of sync with them.
 *
 * Un-marking produces an empty result and therefore logs nothing, which is
 * exactly right for an append-only history: the log records that you marked
 * something watched on a day, and later changing your mind does not un-happen
 * that. (Nothing is corrupted by this, because totals are computed from
 * tracking state, not from log length — see the note in ./index.ts.)
 *
 * Deliberately imports the deep modules (`tracking/ranges`, `tracking/types`)
 * rather than the `lib/tracking` barrel: the barrel pulls in `context.tsx`,
 * which imports this package, and that would be a cycle.
 */

/** Subtract every range in `subtrahend` from `minuend`. `removeRange` handles
 *  one at a time and preserves the sorted/merged invariant, so folding is
 *  safe. */
function subtractAll(
  minuend: readonly EpisodeRange[],
  subtrahend: readonly EpisodeRange[],
): EpisodeRange[] {
  return subtrahend.reduce<EpisodeRange[]>(
    (remaining, range) => removeRange(remaining, range),
    [...minuend],
  );
}

export interface AddedEpisode {
  seasonNumber: number;
  episodeNumber: number;
}

/**
 * Episodes present in `after` but not `before`, expanded to explicit
 * coordinates and sorted by season then episode.
 *
 * Expansion is bounded in practice — a single mutation adds at most one
 * show's worth of episodes, and the common case is one. `markWatchedUpTo` on
 * a very long show is the realistic ceiling (a few hundred), which is fine to
 * materialize once at write time.
 */
export function addedEpisodes(
  before: WatchedEpisodes,
  after: WatchedEpisodes,
): AddedEpisode[] {
  const added: AddedEpisode[] = [];

  for (const [seasonKey, afterRanges] of Object.entries(after)) {
    const seasonNumber = Number(seasonKey);
    if (!Number.isInteger(seasonNumber)) continue;

    const beforeRanges = before[seasonNumber] ?? [];
    for (const [start, end] of subtractAll(afterRanges, beforeRanges)) {
      for (let episodeNumber = start; episodeNumber <= end; episodeNumber += 1) {
        added.push({ seasonNumber, episodeNumber });
      }
    }
  }

  return added.sort(
    (a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber,
  );
}
