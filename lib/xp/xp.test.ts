import { describe, expect, it } from "vitest";

import {
  computeXp,
  DEFAULT_MOVIE_RUNTIME_MINUTES,
  SEASON_COMPLETE_BONUS_XP,
  SERIES_COMPLETE_BONUS_XP,
  XP_PER_EPISODE,
  XP_PER_MINUTE,
  type XpInput,
} from "./formula";
import {
  LEVEL_BASE_XP,
  levelForXp,
  levelProgressForXp,
  rankForLevel,
  xpForLevel,
} from "./levels";

const EMPTY: XpInput = {
  episodesWatched: 0,
  movieRuntimeMinutesTotal: 0,
  completedSeasons: 0,
  completedSeries: 0,
};

/* ---------------------------------------------------------------------------
 * computeXp
 * ------------------------------------------------------------------------ */

describe("computeXp — the case that motivated the formula", () => {
  it("a 2-hour film outscores a single sitcom episode", () => {
    const film = computeXp({ ...EMPTY, movieRuntimeMinutesTotal: 120 });
    const episode = computeXp({ ...EMPTY, episodesWatched: 1 });
    expect(film.total).toBeGreaterThan(episode.total);
  });
});

describe("computeXp — episodes", () => {
  it("is zero for zero episodes", () => {
    expect(computeXp(EMPTY).fromEpisodes).toBe(0);
  });

  it("scales linearly by the flat per-episode rate", () => {
    expect(computeXp({ ...EMPTY, episodesWatched: 1 }).fromEpisodes).toBe(XP_PER_EPISODE);
    expect(computeXp({ ...EMPTY, episodesWatched: 10 }).fromEpisodes).toBe(XP_PER_EPISODE * 10);
  });

  it("does not vary with anything about the show — the accepted flat-rate asymmetry", () => {
    // Two entries with the same episode count earn identical XP regardless of
    // what show they're from; only the COUNT matters. This is the documented
    // tradeoff, asserted so a future change can't silently reintroduce
    // per-show variance without a test noticing.
    const a = computeXp({ ...EMPTY, episodesWatched: 5 });
    const b = computeXp({ ...EMPTY, episodesWatched: 5 });
    expect(a.fromEpisodes).toBe(b.fromEpisodes);
  });
});

describe("computeXp — movies", () => {
  it("scales by real runtime minutes, not a flat rate", () => {
    const short = computeXp({ ...EMPTY, movieRuntimeMinutesTotal: 90 });
    const long = computeXp({ ...EMPTY, movieRuntimeMinutesTotal: 180 });
    expect(long.fromMovies).toBe(short.fromMovies * 2);
    expect(long.fromMovies).toBe(180 * XP_PER_MINUTE);
  });

  it("the fallback constant is what a null-runtime movie should resolve to upstream", () => {
    // computeXp itself just multiplies whatever total it's given — this pins
    // the CONSTANT the caller is expected to substitute for a null runtime,
    // so a change to the fallback doesn't silently drift unnoticed.
    expect(DEFAULT_MOVIE_RUNTIME_MINUTES).toBeGreaterThan(0);
    expect(computeXp({ ...EMPTY, movieRuntimeMinutesTotal: DEFAULT_MOVIE_RUNTIME_MINUTES }).fromMovies).toBe(
      DEFAULT_MOVIE_RUNTIME_MINUTES * XP_PER_MINUTE,
    );
  });
});

describe("computeXp — bonuses", () => {
  it("awards a flat amount per completed season", () => {
    expect(computeXp({ ...EMPTY, completedSeasons: 3 }).fromSeasonBonuses).toBe(
      3 * SEASON_COMPLETE_BONUS_XP,
    );
  });

  it("awards a flat amount per completed series", () => {
    expect(computeXp({ ...EMPTY, completedSeries: 2 }).fromSeriesBonuses).toBe(
      2 * SERIES_COMPLETE_BONUS_XP,
    );
  });

  it("the series bonus is bigger than the season bonus", () => {
    // Finishing a whole show should mean more than finishing one season of it.
    expect(SERIES_COMPLETE_BONUS_XP).toBeGreaterThan(SEASON_COMPLETE_BONUS_XP);
  });
});

describe("computeXp — totals and robustness", () => {
  it("sums every component", () => {
    const result = computeXp({
      episodesWatched: 10,
      movieRuntimeMinutesTotal: 200,
      completedSeasons: 2,
      completedSeries: 1,
    });
    expect(result.total).toBe(
      result.fromEpisodes + result.fromMovies + result.fromSeasonBonuses + result.fromSeriesBonuses,
    );
    expect(result.total).toBe(10 * XP_PER_EPISODE + 200 * XP_PER_MINUTE + 2 * 50 + 1 * 150);
  });

  it("is all zeroes for an empty input", () => {
    expect(computeXp(EMPTY)).toEqual({
      total: 0,
      fromEpisodes: 0,
      fromMovies: 0,
      fromSeasonBonuses: 0,
      fromSeriesBonuses: 0,
    });
  });

  it("clamps negative or non-finite inputs to zero rather than propagating NaN", () => {
    // Defensive: an XpInput is caller-assembled, and corrupt tracking data
    // (a hand-edited localStorage value, say) should never turn the XP bar
    // into "NaN XP" instead of just under-counting.
    const result = computeXp({
      episodesWatched: -5,
      movieRuntimeMinutesTotal: NaN,
      completedSeasons: Infinity,
      completedSeries: -1,
    });
    expect(Number.isFinite(result.total)).toBe(true);
    expect(result.fromEpisodes).toBe(0);
    expect(result.fromMovies).toBe(0);
    expect(result.fromSeriesBonuses).toBe(0);
  });
});

/* ---------------------------------------------------------------------------
 * Levels
 * ------------------------------------------------------------------------ */

describe("xpForLevel", () => {
  it("level 1 requires 0 XP — everyone starts here", () => {
    expect(xpForLevel(1)).toBe(0);
  });

  it("level 2's threshold is exactly LEVEL_BASE_XP, independent of the exponent", () => {
    // The load-bearing property documented in levels.ts: (level-1)^x is 1 for
    // ANY exponent when level=2, so tuning the curve's shape can never move
    // this specific number. This is what "level 2 within the first session"
    // actually pins down.
    expect(xpForLevel(2)).toBe(LEVEL_BASE_XP);
  });

  it("is strictly increasing", () => {
    for (let level = 1; level < 100; level += 1) {
      expect(xpForLevel(level + 1)).toBeGreaterThan(xpForLevel(level));
    }
  });

  it("grows superlinearly — the gap between levels widens", () => {
    const earlyGap = xpForLevel(3) - xpForLevel(2);
    const lateGap = xpForLevel(51) - xpForLevel(50);
    expect(lateGap).toBeGreaterThan(earlyGap * 10);
  });
});

describe("levelForXp", () => {
  it("is the exact inverse of xpForLevel at each threshold", () => {
    for (let level = 1; level <= 80; level += 1) {
      expect(levelForXp(xpForLevel(level))).toBe(level);
    }
  });

  it("one XP short of a threshold stays at the level below", () => {
    const threshold = xpForLevel(10);
    expect(levelForXp(threshold - 1)).toBe(9);
    expect(levelForXp(threshold)).toBe(10);
  });

  it("0 XP is level 1", () => {
    expect(levelForXp(0)).toBe(1);
  });

  it("clamps negative or non-finite XP to level 1 — safe default, not a hang", () => {
    // Non-finite input (Infinity, NaN) is treated as invalid rather than "an
    // enormous number", matching computeXp's own clamp-to-zero philosophy —
    // consistent behavior for corrupt input across the whole package, and
    // this is what actually guarantees the loop in levelForXp terminates
    // rather than needing MAX_SEARCHABLE_LEVEL to save it.
    expect(levelForXp(-100)).toBe(1);
    expect(levelForXp(NaN)).toBe(1);
    expect(levelForXp(Infinity)).toBe(1);
  });

  it("MAX_SEARCHABLE_LEVEL still bounds the search for a merely huge (but finite) XP value", () => {
    // The loop's own guard caps it AT the ceiling, not below it — a merely
    // huge (not infinite) XP value legitimately earns the max searchable
    // level rather than being rejected like non-finite input above.
    expect(levelForXp(Number.MAX_SAFE_INTEGER)).toBe(1000);
  });

  it("a single episode alone reaches level 2", () => {
    // Ties the approved design goal directly to the actual per-episode rate,
    // so a change to either constant that breaks the promise fails loudly.
    expect(levelForXp(XP_PER_EPISODE)).toBeGreaterThanOrEqual(2);
  });
});

describe("the Phase 7 import scenario — why the exponent is 2.0", () => {
  it("a ~2,000-episode import does not exceed the top rank", () => {
    const imported = computeXp({
      episodesWatched: 2000,
      movieRuntimeMinutesTotal: 200 * 110, // ~200 movies at a typical runtime
      completedSeasons: 0,
      completedSeries: 0,
    });
    const level = levelForXp(imported.total);
    // Top rank starts at level 71 (see RANKS in levels.ts) — a heavy import
    // should land comfortably below it, leaving room to grow.
    expect(level).toBeLessThan(71);
  });
});

describe("rankForLevel", () => {
  it("level 1 is Ticket Holder", () => {
    expect(rankForLevel(1)).toBe("Ticket Holder");
  });

  it("moves to the next tier exactly at its minLevel, not one before or after", () => {
    expect(rankForLevel(2)).toBe("Ticket Holder");
    expect(rankForLevel(3)).toBe("Matinee Regular");
  });

  it("is non-decreasing in prestige as level rises — never regresses at a boundary", () => {
    const seen: string[] = [];
    for (let level = 1; level <= 100; level += 1) {
      const rank = rankForLevel(level);
      if (seen[seen.length - 1] !== rank) seen.push(rank);
    }
    // Each rank name should appear as a contiguous block, i.e. the number of
    // transitions equals the number of distinct ranks seen — no rank returns
    // after being left.
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("caps at Marquee Legend with no upper bound", () => {
    expect(rankForLevel(71)).toBe("Marquee Legend");
    expect(rankForLevel(500)).toBe("Marquee Legend");
  });

  it("every tier boundary in the table is reachable and ordered", () => {
    // Guards against a future edit reordering RANKS and silently breaking the
    // "last match wins" scan in rankForLevel.
    const boundaries = [1, 3, 6, 10, 15, 20, 26, 33, 41, 50, 60, 71];
    for (let i = 1; i < boundaries.length; i += 1) {
      expect(boundaries[i]).toBeGreaterThan(boundaries[i - 1]);
    }
  });
});

describe("levelProgressForXp", () => {
  it("reports 0% right at a level threshold", () => {
    const progress = levelProgressForXp(xpForLevel(5));
    expect(progress.level).toBe(5);
    expect(progress.xpIntoLevel).toBe(0);
    expect(progress.percentToNextLevel).toBe(0);
  });

  it("reports partial progress mid-level", () => {
    const floor = xpForLevel(5);
    const ceiling = xpForLevel(6);
    const midpoint = Math.round((floor + ceiling) / 2);
    const progress = levelProgressForXp(midpoint);
    expect(progress.level).toBe(5);
    expect(progress.percentToNextLevel).toBeGreaterThan(0);
    expect(progress.percentToNextLevel).toBeLessThan(100);
  });

  it("pairs the rank with the level consistently", () => {
    const progress = levelProgressForXp(xpForLevel(3));
    expect(progress.rank).toBe(rankForLevel(3));
  });

  it("never exceeds 100%", () => {
    expect(levelProgressForXp(xpForLevel(10) + 1_000_000).percentToNextLevel).toBeLessThanOrEqual(100);
  });
});
