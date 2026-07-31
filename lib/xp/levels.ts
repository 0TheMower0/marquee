/**
 * The level curve and the cinema-themed rank ladder. Pure — every function
 * here is total and side-effect free, so the curve can be retuned by editing
 * two constants with no migration and no UI change.
 *
 * ============================================================================
 * WHY THE EXPONENT IS 2.2, NOT SOMETHING ROUNDER
 * ============================================================================
 * `xpForLevel(2) = LEVEL_BASE_XP * (2-1) ^ EXPONENT = LEVEL_BASE_XP`, for ANY
 * exponent — `1 ^ x` is 1 regardless of `x`. That is deliberate and load-
 * bearing: it means the exponent can be tuned freely to reshape the LATE
 * curve without ever disturbing the level-2 threshold, which is the one
 * number "generous early... level 2 within the first session" actually pins
 * down. Level 3 barely moves either (a few dozen XP either way) — this is a
 * lever on the TAIL specifically.
 *
 * This went through two revisions before landing here, each forced by
 * pressure-testing against a bigger Phase 7 CSV-import scenario than the one
 * before it:
 *
 *   exponent 1.7 (first proposed): a modest 2,000-episode import already
 *     landed past level 100 — past the entire rank ladder on day one.
 *
 *   exponent 2.0 (shipped, briefly): fixed that specific case (2,000
 *     episodes -> level ~53), but was pressure-tested against too small a
 *     scenario. A REALISTIC heavy importer — the profile actually likely to
 *     use a CSV import feature, not a contrived extreme — is closer to
 *     3,000 episodes + 500 movies (~370,000 XP). At 2.0 that lands at level
 *     69: one level short of "Marquee Legend" (71+). Still maxes out almost
 *     immediately for the realistic case, not just an edge case.
 *
 *   exponent 2.2 (here): the same 370,000 XP scenario lands at level 47
 *     (Critic) — real headroom before Auteur/Festival Programmer/Legend.
 *     Chosen over pushing further (2.4 puts the same scenario at level 34,
 *     Archivist) because that starts undervaluing a genuinely large real
 *     library — 3,000 actually-watched episodes is a lot, and the same curve
 *     applies to an organic multi-year user, not just an importer. 2.2 is
 *     the point where import-day inflation and long-term-user reward felt
 *     balanced, not a value derived from a formula.
 *
 * See "the Phase 7 import scenario" in xp.test.ts, which pins the 370,000-XP
 * case below the top rank — retune this constant again if that ever proves
 * too easy or too hard in practice, the test will say which.
 */

export const LEVEL_BASE_XP = 80;
export const LEVEL_EXPONENT = 2.2;

/** Sanity ceiling for the search in `levelForXp` — not a gameplay cap.
 *  `xpForLevel` grows without bound, so this only guards against a
 *  corrupted/absurd XP value (e.g. Infinity) spinning forever. */
const MAX_SEARCHABLE_LEVEL = 1000;

/** Total XP required to REACH `level`. `xpForLevel(1) === 0` — everyone
 *  starts at level 1 with nothing watched yet. */
export function xpForLevel(level: number): number {
  if (level <= 1) return 0;
  return Math.round(LEVEL_BASE_XP * (level - 1) ** LEVEL_EXPONENT);
}

/** The level a given XP total currently sits at. Iterates rather than
 *  inverting the curve algebraically — level counts here are small enough
 *  (bounded by MAX_SEARCHABLE_LEVEL) that a loop is simpler and immune to the
 *  floating-point boundary bugs a closed-form inverse would need to guard
 *  against, at negligible cost. */
export function levelForXp(xp: number): number {
  const safeXp = Number.isFinite(xp) ? Math.max(0, xp) : 0;
  let level = 1;
  while (level < MAX_SEARCHABLE_LEVEL && xpForLevel(level + 1) <= safeXp) {
    level += 1;
  }
  return level;
}

export interface LevelProgress {
  level: number;
  rank: string;
  /** XP earned since reaching the current level. */
  xpIntoLevel: number;
  /** XP needed to go from the current level to the next. */
  xpForNextLevel: number;
  /** 0-100, for a progress bar. */
  percentToNextLevel: number;
}

/**
 * Cinema-themed ranks, ascending. Every tier covers a range of levels;
 * `rankForLevel` finds the highest tier whose `minLevel` the level has
 * reached. The last entry has no upper bound — "Marquee Legend" is the top
 * rank forever, however high level climbs past 71.
 *
 * The arc is deliberate: moviegoer -> film culture -> someone who runs the
 * place, landing on the app's own name at the top.
 */
const RANKS: ReadonlyArray<{ minLevel: number; name: string }> = [
  { minLevel: 1, name: "Ticket Holder" },
  { minLevel: 3, name: "Matinee Regular" },
  { minLevel: 6, name: "Aisle Seat Veteran" },
  { minLevel: 10, name: "Repertory Regular" },
  { minLevel: 15, name: "Film Buff" },
  { minLevel: 20, name: "Cinephile" },
  { minLevel: 26, name: "Projectionist" },
  { minLevel: 33, name: "Archivist" },
  { minLevel: 41, name: "Critic" },
  { minLevel: 50, name: "Auteur" },
  { minLevel: 60, name: "Festival Programmer" },
  { minLevel: 71, name: "Marquee Legend" },
];

export function rankForLevel(level: number): string {
  // RANKS is sorted ascending by minLevel, so the last match wins.
  let rank = RANKS[0].name;
  for (const tier of RANKS) {
    if (level < tier.minLevel) break;
    rank = tier.name;
  }
  return rank;
}

/** Everything a progress bar needs, in one call. */
export function levelProgressForXp(xp: number): LevelProgress {
  const level = levelForXp(xp);
  const floor = xpForLevel(level);
  const ceiling = xpForLevel(level + 1);
  const span = ceiling - floor;
  const xpIntoLevel = Math.max(0, xp - floor);

  return {
    level,
    rank: rankForLevel(level),
    xpIntoLevel,
    xpForNextLevel: span,
    // span is 0 only if MAX_SEARCHABLE_LEVEL was hit (xpForLevel(level+1)
    // clamped to the same value) — full bar rather than a division by zero.
    percentToNextLevel: span > 0 ? Math.min(100, (xpIntoLevel / span) * 100) : 100,
  };
}
