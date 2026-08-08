import { describe, expect, it } from "vitest";

import type { WatchedEpisodes } from "@/lib/tracking/types";

import { instantToLocalMoment, toDayKey } from "./dates";
import {
  countEpisodes,
  isCoarseWatched,
  mergeImportedEpisodes,
  shouldMergeRanges,
  type ImportedEpisode,
} from "./episodes";

function eps(...pairs: [number, number][]): ImportedEpisode[] {
  return pairs.map(([season, episode]) => ({ season, episode }));
}

describe("mergeImportedEpisodes — union, never subtraction", () => {
  it("adds episodes to an empty map", () => {
    expect(mergeImportedEpisodes({}, eps([1, 1], [1, 2], [1, 3]))).toEqual({ 1: [[1, 3]] });
  });

  it("collapses adjacent episodes into one range", () => {
    // The canonical invariant: [[1,2],[3,3]] is never stored.
    const merged = mergeImportedEpisodes({ 1: [[1, 2]] }, eps([1, 3]));
    expect(merged).toEqual({ 1: [[1, 3]] });
  });

  it("is order-independent", () => {
    const forward = mergeImportedEpisodes({}, eps([1, 1], [1, 2], [1, 3]));
    const shuffled = mergeImportedEpisodes({}, eps([1, 3], [1, 1], [1, 2]));
    expect(shuffled).toEqual(forward);
  });

  it("NEVER removes an existing episode", () => {
    // The whole guarantee, at episode granularity.
    const existing: WatchedEpisodes = { 1: [[1, 10]], 2: [[1, 5]] };
    const merged = mergeImportedEpisodes(existing, eps([1, 3]));
    expect(countEpisodes(merged)).toBeGreaterThanOrEqual(countEpisodes(existing));
    expect(merged[2]).toEqual([[1, 5]]);
  });

  it("is monotonic for any input", () => {
    const existing: WatchedEpisodes = { 1: [[2, 4]], 3: [[1, 1]] };
    for (const imported of [eps([1, 1]), eps([1, 9]), eps([2, 1]), eps([3, 1]), []]) {
      expect(countEpisodes(mergeImportedEpisodes(existing, imported))).toBeGreaterThanOrEqual(
        countEpisodes(existing),
      );
    }
  });

  it("leaves a gap rather than filling it", () => {
    // Importing E5 must not imply E1-E4. Only what the source asserted.
    expect(mergeImportedEpisodes({ 1: [[1, 2]] }, eps([1, 5]))).toEqual({
      1: [
        [1, 2],
        [5, 5],
      ],
    });
  });

  it("keeps seasons independent", () => {
    expect(mergeImportedEpisodes({ 1: [[1, 2]] }, eps([2, 1]))).toEqual({
      1: [[1, 2]],
      2: [[1, 1]],
    });
  });

  it("accepts season 0 specials", () => {
    // An import transcribes what the user recorded elsewhere; unlike the
    // "mark season watched" UI it is not inferring anything.
    expect(mergeImportedEpisodes({}, eps([0, 2]))).toEqual({ 0: [[2, 2]] });
  });

  it("ignores nonsense coordinates instead of corrupting a range", () => {
    const merged = mergeImportedEpisodes({ 1: [[1, 2]] }, [
      { season: -1, episode: 3 },
      { season: 1, episode: 0 },
      { season: 1.5, episode: 3 },
      { season: 1, episode: Number.NaN },
    ]);
    expect(merged).toEqual({ 1: [[1, 2]] });
  });

  it("returns the input untouched when there is nothing to import", () => {
    const existing: WatchedEpisodes = { 1: [[1, 2]] };
    expect(mergeImportedEpisodes(existing, [])).toBe(existing);
  });
});

describe("the coarse-watched exception", () => {
  it("recognizes a title-level watched show", () => {
    expect(isCoarseWatched("watched", {})).toBe(true);
  });

  it("does not mistake other states for it", () => {
    expect(isCoarseWatched("watched", { 1: [[1, 1]] })).toBe(false);
    expect(isCoarseWatched("watching", {})).toBe(false);
    expect(isCoarseWatched("watchlist", {})).toBe(false);
  });

  it("blocks the range merge for exactly that case", () => {
    // A coarse `watched` asserts the WHOLE show. Merging 40 imported episodes
    // into a 62-episode show would silently discard 22 the user already
    // claimed — ranges up, apparent progress down.
    expect(shouldMergeRanges("watched", {})).toBe(false);
    expect(shouldMergeRanges("watched", { 1: [[1, 1]] })).toBe(true);
    expect(shouldMergeRanges("watching", {})).toBe(true);
  });
});

describe("countEpisodes", () => {
  it("counts inclusive ranges across seasons", () => {
    expect(countEpisodes({ 1: [[1, 3]], 2: [[1, 1], [5, 6]] })).toBe(6);
  });

  it("is zero for no progress", () => {
    expect(countEpisodes({})).toBe(0);
  });
});

describe("instantToLocalMoment vs toDayKey — each is wrong where the other belongs", () => {
  it("converts a real timestamp to a local day and minute", () => {
    const moment = instantToLocalMoment("2019-03-14T20:15:00");
    // Parsed without a zone designator, so this is local wall-clock time and
    // the assertion holds regardless of the host's timezone.
    expect(moment?.day).toBe("2019-03-14");
    expect(moment?.minute).toBe(20 * 60 + 15);
  });

  it("REJECTS a bare calendar date rather than misreading it", () => {
    // `new Date("2019-03-14")` is UTC midnight, which reads back as 13 March
    // anywhere west of Greenwich. Rejecting makes the misuse impossible
    // instead of merely documented.
    expect(instantToLocalMoment("2019-03-14")).toBeNull();
  });

  it("toDayKey rejects nothing about a timestamp, which is why it must not see one", () => {
    // It happily takes the leading date portion — the UTC day. Pinned so the
    // hazard is visible in the suite rather than only in a comment.
    expect(toDayKey("2019-03-14T23:30:00Z")).toBe("2019-03-14");
  });

  it("derives day and minute from ONE parse, so they cannot disagree", () => {
    const moment = instantToLocalMoment("2019-12-31T23:59:00");
    expect(moment?.day).toBe("2019-12-31");
    expect(moment?.minute).toBe(23 * 60 + 59);
  });

  it("returns null for junk rather than an invalid date", () => {
    expect(instantToLocalMoment("not a date")).toBeNull();
    expect(instantToLocalMoment("2019-13-45T99:99:00")).toBeNull();
    expect(instantToLocalMoment(null)).toBeNull();
    expect(instantToLocalMoment("")).toBeNull();
  });

  it("accepts a space separator as well as T", () => {
    expect(instantToLocalMoment("2019-03-14 08:05:00")?.minute).toBe(8 * 60 + 5);
  });
});
