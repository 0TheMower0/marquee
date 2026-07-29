import type { EpisodeRange } from "./types";

/**
 * Pure primitives for the inclusive-range encoding described in ./types.ts.
 *
 * Everything here is total and side-effect free: no storage, no dates, no
 * knowledge of what a "season" or an "entry" is. That is the point — the
 * encoding can be reasoned about and tested on its own, and the tracking
 * operations built on top (Step 1, still to come) only ever have to think
 * about *which* ranges to add or remove, never about how they're stored.
 *
 * THE INVARIANT every function here preserves and every reader may assume:
 * ranges are sorted by start, non-overlapping, and non-adjacent. `[[1,3],[4,6]]`
 * is not a legal stored value; it collapses to `[[1,6]]`. Adjacency merging is
 * what keeps a fully-watched 24-episode season at exactly one range instead of
 * degrading into 24 as episodes get marked one at a time.
 */

/**
 * Sort, merge, and discard malformed entries. Also the sanitizer for data
 * coming back off disk, which may have been hand-edited or written by a
 * future version — anything that isn't a well-formed `[start, end]` pair with
 * `start <= end` is dropped rather than trusted.
 */
export function normalizeRanges(ranges: readonly EpisodeRange[]): EpisodeRange[] {
  const valid = ranges
    .filter(
      (range): range is EpisodeRange =>
        Array.isArray(range) &&
        range.length === 2 &&
        Number.isInteger(range[0]) &&
        Number.isInteger(range[1]) &&
        range[0] >= 0 &&
        range[0] <= range[1],
    )
    // Copied rather than reused: the merge loop below mutates the accumulator's
    // tuples, and mutating the caller's arrays would be a nasty surprise.
    .map((range): EpisodeRange => [range[0], range[1]])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const merged: EpisodeRange[] = [];
  for (const [start, end] of valid) {
    const last = merged[merged.length - 1];
    // `start <= last[1] + 1` merges overlapping AND adjacent runs. Using
    // `<= last[1]` instead would leave [[1,3],[4,6]] uncollapsed.
    if (last && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

export function addRange(
  ranges: readonly EpisodeRange[],
  range: EpisodeRange,
): EpisodeRange[] {
  return normalizeRanges([...ranges, range]);
}

/**
 * Subtract a range. Splitting is the interesting case: removing `[5,5]` from
 * `[[1,10]]` yields `[[1,4],[6,10]]` — unmarking one episode in the middle of
 * a watched season legitimately increases the range count, which is why the
 * encoding's worst case is bounded but not trivial.
 */
export function removeRange(
  ranges: readonly EpisodeRange[],
  [removeStart, removeEnd]: EpisodeRange,
): EpisodeRange[] {
  if (removeStart > removeEnd) return normalizeRanges(ranges);

  const kept: EpisodeRange[] = [];
  for (const [start, end] of ranges) {
    if (end < removeStart || start > removeEnd) {
      kept.push([start, end]); // untouched
      continue;
    }
    if (start < removeStart) kept.push([start, removeStart - 1]); // left remnant
    if (end > removeEnd) kept.push([removeEnd + 1, end]); // right remnant
  }
  return normalizeRanges(kept);
}

export function rangesContain(
  ranges: readonly EpisodeRange[],
  episodeNumber: number,
): boolean {
  return ranges.some(
    ([start, end]) => episodeNumber >= start && episodeNumber <= end,
  );
}

/** How many episode numbers these ranges cover in total. */
export function countRanges(ranges: readonly EpisodeRange[]): number {
  return ranges.reduce((total, [start, end]) => total + (end - start + 1), 0);
}

/**
 * Expand to explicit episode numbers. Intended for tests and for small,
 * bounded uses (one season at a time) — never call this across a whole show
 * to answer a question that `countRanges` or `rangesContain` already answers
 * without allocating.
 */
export function expandRanges(ranges: readonly EpisodeRange[]): number[] {
  const out: number[] = [];
  for (const [start, end] of ranges) {
    for (let n = start; n <= end; n += 1) out.push(n);
  }
  return out;
}
