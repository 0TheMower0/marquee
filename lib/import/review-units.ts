import { dedupKey } from "./resolve";
import type { ResolvedRow } from "./types";

/**
 * Grouping rows into review decisions.
 *
 * ============================================================================
 * A REVIEW UNIT IS A DEDUP GROUP. THERE IS NO EPISODE SPECIAL CASE.
 * ============================================================================
 * `resolveRows` already groups rows by `dedupKey` and gives every row in a
 * group the SAME match outcome — same candidates, same bucket. So rows that
 * resolved together are, by construction, exactly the rows a single decision
 * covers. Reusing that key rather than inventing a second grouping rule means
 * the queue cannot disagree with the resolver about what belongs together.
 *
 * It also makes the shape uniform rather than episode-specific:
 *
 *   a film matched once          -> a unit of 1
 *   a film rewatched three times -> a unit of 3   (one decision, three rows)
 *   a show's 62 episodes         -> a unit of 62  (one decision, 62 rows)
 *
 * **Fewer decisions, not a faster interface.** The queue still shows one unit
 * at a time and still asks for one deliberate answer. Grouping 3,000 episodes
 * into 14 show decisions removes 2,986 decisions that were never real —
 * picking the show IS the whole question, and season and episode numbers
 * carry over mechanically once it is answered. It must not become a licence
 * to render a table.
 *
 * ⚠️ **This puts a requirement on any parser that emits episode rows**: an
 * episode row's `title`, `year` and `imdbId` must describe the SHOW, with the
 * episode identified only by `season`/`episode`. A parser that put an
 * episode's own id or name there would give every episode a distinct dedup
 * key, and a 62-episode show would arrive as 62 separate review decisions —
 * the exact outcome this exists to prevent.
 */

export interface ReviewUnit {
  /** The shared dedup key. Stable across re-parses of the same file. */
  key: string;
  /** Indices into the ORIGINAL resolved array. A decision applies to every
   *  one of them, which is what makes this one decision rather than N. */
  indices: number[];
  /** Any row in the group — they share title, year, candidates and bucket.
   *  The first is used so line numbers read in file order. */
  representative: ResolvedRow;
  rowCount: number;
  /** Rows in this group carrying episode coordinates. Zero for a film. */
  episodeCount: number;
  /** Distinct seasons those episodes span. */
  seasonCount: number;
  /** Earliest and latest watch date across the group, for the "you watched
   *  these between X and Y" line that makes a 62-row unit legible. */
  earliestDate: string | null;
  latestDate: string | null;
  firstLine: number;
  lastLine: number;
}

/** A row still awaiting a human answer. Matches the queue's own definition:
 *  ambiguous or unmatched, not skipped, nothing chosen. */
export function needsReview(resolved: ResolvedRow): boolean {
  return (
    (resolved.bucket === "ambiguous" || resolved.bucket === "unmatched") &&
    !resolved.skipped &&
    resolved.chosen === null
  );
}

function summarize(key: string, indices: number[], rows: readonly ResolvedRow[]): ReviewUnit {
  const group = indices.map((index) => rows[index]);
  const seasons = new Set<number>();
  const dates: string[] = [];
  let episodeCount = 0;

  for (const { row } of group) {
    if (row.season !== null && row.episode !== null) {
      episodeCount += 1;
      seasons.add(row.season);
    }
    if (row.watchedOn) dates.push(row.watchedOn);
  }

  dates.sort();

  return {
    key,
    indices,
    representative: group[0],
    rowCount: group.length,
    episodeCount,
    seasonCount: seasons.size,
    earliestDate: dates[0] ?? null,
    latestDate: dates.length > 0 ? dates[dates.length - 1] : null,
    firstLine: Math.min(...group.map((r) => r.row.sourceLine)),
    lastLine: Math.max(...group.map((r) => r.row.sourceLine)),
  };
}

/**
 * Every unit that will ever need reviewing, in file order.
 *
 * Built from ALL rows that need review — not recomputed as decisions land,
 * because a queue that reshuffles under the user's cursor mid-review is
 * unusable. The caller filters for what is still pending; the ordering here
 * stays fixed.
 */
export function buildReviewUnits(rows: readonly ResolvedRow[]): ReviewUnit[] {
  const groups = new Map<string, number[]>();

  rows.forEach((resolved, index) => {
    if (!needsReview(resolved)) return;
    const key = dedupKey(resolved.row);
    const existing = groups.get(key);
    if (existing) existing.push(index);
    else groups.set(key, [index]);
  });

  return [...groups.entries()].map(([key, indices]) => summarize(key, indices, rows));
}

/**
 * Easiest first — the highest-scoring top candidate leads.
 *
 * Momentum early, and the genuinely hard units cluster at the end where a user
 * can stop and leave them pending. Ties keep file order, so the sort is
 * deterministic across runs.
 */
export function sortUnitsEasiestFirst(units: readonly ReviewUnit[]): ReviewUnit[] {
  return [...units]
    .map((unit, position) => ({ unit, position }))
    .sort(
      (a, b) =>
        (b.unit.representative.candidates[0]?.score ?? -1) -
          (a.unit.representative.candidates[0]?.score ?? -1) ||
        a.position - b.position,
    )
    .map(({ unit }) => unit);
}

/** Whether a unit still needs an answer, checked against CURRENT rows. A unit
 *  is resolved the moment its representative is, because a decision applies to
 *  every index at once. */
export function isUnitPending(unit: ReviewUnit, rows: readonly ResolvedRow[]): boolean {
  return needsReview(rows[unit.indices[0]]);
}
