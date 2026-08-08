import type { TitleSummary } from "@/lib/content/types";

import { rankCandidates, type ScoredCandidate } from "./normalize";
import type { ImportRow, MatchBucket, ResolvedRow } from "./types";

/**
 * The bucket rules (design doc §2.3). This file is the one that must not
 * erode, so the rule is stated once, here, in one function:
 *
 *   Only an external-id match, or a title+year match that is exact on both
 *   fields AND unique, imports without asking. Everything else is a human
 *   decision.
 *
 * Two things are deliberately absent and should stay absent:
 *
 *   - **A numeric confidence threshold.** "Auto-accept above 85" is a dial,
 *     and a dial gets turned down the first time someone finds the review
 *     queue long. Its failure mode is a wrong match the user never notices,
 *     which is the specific outcome this whole feature is built to avoid —
 *     an unmatched row is visibly unmatched; a wrongly-matched row looks
 *     exactly like a correct one.
 *   - **A popularity tiebreak on an otherwise exact tie.** If two candidates
 *     both match title and year exactly, that is a remake or a re-release,
 *     and it is genuinely ambiguous no matter how much more popular one of
 *     them is.
 */

/**
 * Rows this importer still cannot write.
 *
 * Episode rows WITH coordinates are supported since design doc §12 — they
 * merge into `watchedEpisodes` and log per-episode watch events.
 *
 * Episode rows WITHOUT coordinates are not, and the distinction is a fact
 * about the sources rather than a limitation we chose: Trakt supplies
 * `season_number`/`episode_number`, while IMDb names an episode and gives
 * none — its `Const` for a `tvEpisode` row is the EPISODE's own IMDb id, so
 * resolving it needs TMDB's `tv_episode_results` (design doc §9). Those rows
 * are surfaced in the preview rather than dropped, so the user can see they
 * were in the file.
 */
export function isUnsupportedRow(row: ImportRow): boolean {
  return row.mediaTypeHint === "episode" && (row.season === null || row.episode === null);
}

/** Local alias, kept so the call sites below read unchanged. */
const isUnsupported = isUnsupportedRow;

/**
 * Whether a scored candidate is an exact agreement on both title and year.
 *
 * A missing year on either side is NOT agreement. That matters: a row with no
 * year and a candidate whose title matches exactly would otherwise sail into
 * `confident` on the strength of the title alone, which is precisely how
 * "Dune" gets silently matched to the wrong one of two films.
 */
function agreesExactly(candidate: ScoredCandidate): boolean {
  return (
    candidate.signals.titleIdentical &&
    candidate.signals.yearDelta === 0 &&
    !candidate.signals.typeConflicts
  );
}

/**
 * Classifies an already-ranked candidate list.
 *
 * `exact` is never produced here — it is assigned by the resolver when an
 * external id resolved unambiguously, and such a row never reaches Tier 2 at
 * all. This function only ever decides between `confident`, `ambiguous` and
 * `unmatched`.
 */
export function classifyRanked(row: ImportRow, ranked: readonly ScoredCandidate[]): MatchBucket {
  if (isUnsupported(row)) return "unsupported";
  if (ranked.length === 0) return "unmatched";

  const [top, second] = ranked;
  if (!agreesExactly(top)) return "ambiguous";

  // Uniqueness. A second candidate that ALSO agrees exactly means a remake or
  // a re-release, and no signal we have can choose between them honestly.
  if (second && agreesExactly(second)) return "ambiguous";

  return "confident";
}

/**
 * The full Tier 2 path: rank, classify, and pre-select a choice only for a
 * bucket that auto-imports.
 *
 * `chosen` is left null for `ambiguous`, which is what makes the review queue
 * necessary rather than advisory — there is no fallback value sitting there
 * waiting to be committed if the user walks away.
 */
export function resolveByTitle(
  row: ImportRow,
  candidates: readonly TitleSummary[],
): ResolvedRow {
  const ranked = rankCandidates(row, candidates);
  const bucket = classifyRanked(row, ranked);
  return {
    row,
    bucket,
    candidates: bucket === "unsupported" ? [] : ranked,
    chosen: bucket === "confident" ? ranked[0].summary : null,
    skipped: false,
  };
}

/**
 * Tier 1: an external id resolved to exactly one title.
 *
 * The caller is responsible for the "exactly one" part — TMDB's `/find`
 * returns five separate result arrays, and a row that somehow populates more
 * than one of them is ambiguous like anything else, not a match to whichever
 * array we happened to read first.
 */
export function resolveByExternalId(row: ImportRow, title: TitleSummary): ResolvedRow {
  return {
    row,
    bucket: isUnsupported(row) ? "unsupported" : "exact",
    candidates: [
      {
        summary: title,
        score: 100,
        reason: `matched by IMDb id ${row.imdbId}`,
      },
    ],
    chosen: isUnsupported(row) ? null : title,
    skipped: false,
  };
}

/** A row that produced no candidates at all. Separate from `ambiguous`
 *  because the review queue treats them differently: this one opens with a
 *  manual search box rather than a list to choose from. */
export function unmatchedRow(row: ImportRow): ResolvedRow {
  return {
    row,
    bucket: isUnsupported(row) ? "unsupported" : "unmatched",
    candidates: [],
    chosen: null,
    skipped: false,
  };
}
