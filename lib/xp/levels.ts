/**
 * The level curve and the cinema-themed rank ladder. Pure — every function
 * here is total and side-effect free, so the curve can be retuned by editing
 * two constants with no migration and no UI change.
 *
 * ============================================================================
 * WHY THE EXPONENT IS 2.0, NOT SOMETHING ROUNDER
 * ============================================================================
 * `xpForLevel(2) = LEVEL_BASE_XP * (2-1) ^ EXPONENT = LEVEL_BASE_XP`, for ANY
 * exponent — `1 ^ x` is 1 regardless of `x`. That is deliberate and load-
 * bearing: it means the exponent can be tuned freely to reshape the LATE
 * curve without ever disturbing the level-2 threshold, which is the one
 * number "generous early... level 2 within the first session" actually pins
 * down.
 *
 * 2.0 specifically (not the 1.7 first proposed) exists because of a concrete
 * scenario: a Phase 7 CSV import could hand a long-time user thousands of
 * episodes of pre-existing history in one sitting. At 1.7, ~2,000 imported
 * episodes (~220,000 XP) landed at level ~106 — past the top of the entire
 * rank ladder on day one, which would cheapen "Marquee Legend" for both the
 * importer and anyone who reached it the slow way. At 2.0 the same import
 * lands around level 53 (Auteur) — real headroom left, while level 2 is
 * untouched and levels 3-5 barely move (a few dozen XP).
 */

export const LEVEL_BASE_XP = 80;
export const LEVEL_EXPONENT = 2.0;

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
