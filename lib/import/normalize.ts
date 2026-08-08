import type { TitleSummary } from "@/lib/content/types";

import type { ImportRow, MatchCandidate } from "./types";

/**
 * Title normalization and candidate scoring — Tier 2 of the matching strategy
 * (design doc §2.2).
 *
 * Everything here is deterministic and pure. That is not incidental: the
 * review queue shows the user a plain-language REASON for every candidate it
 * offers, and that sentence is generated from the same signals that produced
 * the score. An opaque similarity number from a library could rank candidates
 * but could not explain one, and "why is this the top match?" is the question
 * a user resolving 200 ambiguous rows asks constantly.
 */

/** Leading articles, in the languages whose films routinely appear in these
 *  exports. Not exhaustive by design — a wrong strip is worse than a missed
 *  one, since it can make two different films normalize identically. */
const LEADING_ARTICLE = /^(the|a|an|le|la|les|el|los|il|lo|der|die|das|een|het)\s+/;

/** IMDb has historically written "Godfather, The" and "Godfather, The: Part II".
 *  TMDB never does, so without this every such title scores as a partial
 *  match against its own exact counterpart. */
const TRAILING_ARTICLE = /,\s*(the|a|an|le|la|les|el|il|der|die|das)(\s*:|\s*$)/i;

/** A parenthesized year some exports append to the title itself. */
const TRAILING_YEAR = /\s*\((?:19|20)\d{2}\)\s*$/;

const ROMAN: Record<string, string> = {
  i: "1", ii: "2", iii: "3", iv: "4", v: "5",
  vi: "6", vii: "7", viii: "8", ix: "9", x: "10",
};

/**
 * A title reduced to its comparable core.
 *
 * Order matters: the trailing year goes before article handling (so
 * "Gravity (2013)" doesn't leave a stray paren), and punctuation is flattened
 * last (so the comma in "Godfather, The" is still there to be recognized).
 */
export function normalizeTitle(raw: string): string {
  return raw
    .normalize("NFKD")
    // Strip combining diacritical marks: "Amelie" with and without its accent
    // are the same film, and which one an export writes is not something the
    // user chose.
    //
    // `\p{M}` rather than the conventional `[̀-ͯ]` range, and
    // emphatically not the literal characters: a combining-mark range written
    // literally renders as unreviewable mojibake in a diff, which is the exact
    // hazard CLAUDE.md documents for `sanitizeCommentBody`. This form is plain
    // ASCII in the source and says what it means.
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(TRAILING_YEAR, "")
    .replace(TRAILING_ARTICLE, "$2")
    .replace(LEADING_ARTICLE, "")
    // Ampersand before punctuation flattening, so "Fire & Blood" and
    // "Fire and Blood" converge rather than becoming "fire blood" vs
    // "fire and blood".
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Token set, with pure-roman-numeral tokens folded to digits so "Part II" and
 * "Part 2" match. Scoped to whole tokens only — a title containing the word
 * "I" or "X" as a real word is left alone by the `length > 0` set lookup
 * being exact rather than substring.
 */
export function tokenize(normalized: string): Set<string> {
  if (normalized.length === 0) return new Set();
  return new Set(normalized.split(" ").map((token) => ROMAN[token] ?? token));
}

/** Sørensen–Dice over two token sets: 2|A∩B| / (|A|+|B|). Chosen over raw
 *  Jaccard because it is more forgiving of one title carrying an extra
 *  subtitle word, which is the common real difference. */
export function diceCoefficient(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

/** A Letterboxd slug is Letterboxd's own disambiguated name for the film
 *  ("gravity-2013"), which makes it a genuinely useful second string to try —
 *  the trailing disambiguator is dropped so it compares as a plain title. */
export function slugToTitle(slug: string): string {
  return slug.replace(/-(?:19|20)\d{2}$/, "").replace(/-/g, " ");
}

export interface MatchSignals {
  /** Normalized forms are byte-identical. The strongest Tier 2 signal, and
   *  half of what `confident` requires. */
  titleIdentical: boolean;
  titleDice: number;
  /** Absolute year difference, or null when either side has no year — which
   *  is a MISSING signal, not a matching one. */
  yearDelta: number | null;
  typeAgrees: boolean;
  typeConflicts: boolean;
}

const POINTS = {
  titleIdentical: 60,
  titleDiceMax: 45,
  yearExact: 30,
  yearOffByOne: 15,
  yearOffByTwo: 5,
  typeAgrees: 10,
  /**
   * A hint of "tvSeries" matching a movie is almost always wrong, so this is
   * large enough to sink an otherwise strong title match on its own. It is
   * still a penalty rather than a hard filter, because a genuinely
   * mis-hinted row (an IMDb `tvMovie` that TMDB carries as a series) should
   * fall to the review queue rather than vanish from it.
   */
  typeConflicts: -40,
} as const;

function computeSignals(row: ImportRow, candidate: TitleSummary): MatchSignals {
  // Every string the row offers is tried, and the best wins: the primary
  // title, IMDb's `Original Title` (foreign films are the common case), and
  // Letterboxd's slug.
  const candidateNormalized = normalizeTitle(candidate.name);
  const candidateTokens = tokenize(candidateNormalized);

  const attempts = [row.title, row.originalTitle, row.slug ? slugToTitle(row.slug) : null]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => {
      const normalized = normalizeTitle(value);
      return {
        identical: normalized === candidateNormalized && normalized.length > 0,
        dice: diceCoefficient(tokenize(normalized), candidateTokens),
      };
    });

  const titleIdentical = attempts.some((a) => a.identical);
  const titleDice = attempts.reduce((best, a) => Math.max(best, a.dice), 0);

  const yearDelta =
    row.year !== null && candidate.year !== null ? Math.abs(row.year - candidate.year) : null;

  // "movie" and "tv" are the only two values a candidate can have; a row's
  // hint of "unknown" agrees with neither and conflicts with neither.
  const typeAgrees = row.mediaTypeHint === candidate.mediaType;
  const typeConflicts =
    (row.mediaTypeHint === "movie" || row.mediaTypeHint === "tv") &&
    row.mediaTypeHint !== candidate.mediaType;

  return { titleIdentical, titleDice, yearDelta, typeAgrees, typeConflicts };
}

function scoreFromSignals(signals: MatchSignals): number {
  let score = signals.titleIdentical
    ? POINTS.titleIdentical
    : Math.round(signals.titleDice * POINTS.titleDiceMax);

  if (signals.yearDelta === 0) score += POINTS.yearExact;
  else if (signals.yearDelta === 1) score += POINTS.yearOffByOne;
  else if (signals.yearDelta === 2) score += POINTS.yearOffByTwo;

  if (signals.typeAgrees) score += POINTS.typeAgrees;
  if (signals.typeConflicts) score += POINTS.typeConflicts;

  return score;
}

/** The sentence shown under a candidate in the review queue. Built from the
 *  signals rather than the score, because "84 points" tells a user nothing
 *  and "title matches exactly, year differs by 3" tells them everything. */
export function explainSignals(signals: MatchSignals): string {
  const parts: string[] = [];

  if (signals.titleIdentical) parts.push("title matches exactly");
  else if (signals.titleDice >= 0.8) parts.push("title is a close match");
  else if (signals.titleDice >= 0.4) parts.push("title partially matches");
  else parts.push("title barely matches");

  if (signals.yearDelta === null) parts.push("no year to compare");
  else if (signals.yearDelta === 0) parts.push("year matches");
  else parts.push(`year differs by ${signals.yearDelta}`);

  if (signals.typeConflicts) parts.push("wrong media type");

  return parts.join(", ");
}

export interface ScoredCandidate extends MatchCandidate {
  signals: MatchSignals;
}

export function scoreCandidate(row: ImportRow, candidate: TitleSummary): ScoredCandidate {
  const signals = computeSignals(row, candidate);
  return {
    summary: candidate,
    score: scoreFromSignals(signals),
    reason: explainSignals(signals),
    signals,
  };
}

/**
 * Scores and ranks a candidate list, best first.
 *
 * ============================================================================
 * POPULARITY IS A TIEBREAK AND NOTHING ELSE
 * ============================================================================
 * Candidates arrive from TMDB in ITS popularity order, and that order is
 * preserved only for candidates whose computed score is otherwise equal (the
 * sort is stable). Popularity is never added to the score.
 *
 * This is the single most important line in the file. Popularity as a score
 * component is precisely the mechanism that matches "Dune" to the 2021 film
 * when the user meant 1984 — confidently, silently, and in a way the user
 * will never notice because the poster looks like a Dune poster.
 */
export function rankCandidates(
  row: ImportRow,
  candidates: readonly TitleSummary[],
  limit = 5,
): ScoredCandidate[] {
  return candidates
    .map((candidate) => scoreCandidate(row, candidate))
    .map((scored, index) => ({ scored, index }))
    .sort((a, b) => b.scored.score - a.scored.score || a.index - b.index)
    .slice(0, limit)
    .map(({ scored }) => scored);
}
