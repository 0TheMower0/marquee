import { RUNTIME_CONFIDENCE_FLOOR } from "./compute";
import type { YirCardId, YirData } from "./types";

/**
 * Which cards this person's data can actually support.
 *
 * ============================================================================
 * SELECTED BY SUFFICIENCY, NOT A FIXED TEMPLATE
 * ============================================================================
 * The brief: "someone who watched six things should get something charming,
 * not an empty template." The answer is not a special thin-year layout — it is
 * that the deck is ASSEMBLED from whatever the data supports, so a small year
 * yields a short, complete deck rather than a full-length one full of zeroes.
 *
 * That works because of an asymmetry visible in real data: DISTRIBUTION stats
 * degrade gracefully and VOLUME stats do not. Measured on a 12-title library:
 *
 *   "watched across 6 decades, 1975 to 2024"   charming at n=12
 *   "39 things watched"                        sad at n=12
 *
 * So a thin year leans on decades, genre shape and the first watch — each of
 * which says something real about taste from almost no data — while the tally
 * card demotes itself rather than leading with a small number.
 */

export interface DeckOptions {
  /** Cards the caller wants suppressed regardless of sufficiency. */
  exclude?: readonly YirCardId[];
}

/** Below this, the tally is a footnote rather than a headline: "you watched 6
 *  things" is not a stat anyone shares. */
const THIN_YEAR_EVENTS = 15;

export function selectCards(data: YirData, options: DeckOptions = {}): YirCardId[] {
  const excluded = new Set(options.exclude ?? []);
  const cards: YirCardId[] = [];

  const add = (id: YirCardId, sufficient: boolean) => {
    if (sufficient && !excluded.has(id)) cards.push(id);
  };

  // Always present: the opener works with a date range alone, and the closer
  // is the share prompt. Between them the deck can be as short as it needs.
  add("opener", true);

  // The tally leads only when the numbers carry a headline. Below the
  // threshold it still appears — it is honest, and "6 films" is fine as a
  // supporting fact — but `isThinYear` tells the card to phrase it small.
  add("tally", data.tally.movies + data.tally.episodes > 0);

  add("decades", data.decades !== null && data.decades.count >= 2);
  add("genres", data.genres !== null);
  add("topShow", data.topShow !== null && data.topShow.episodes >= 3);
  add("rhythm", data.rhythm !== null);
  add("critics", data.critics !== null);

  add("closer", true);
  return cards;
}

/** True when the tally should be phrased as a supporting fact rather than a
 *  headline. Exposed so the card and the share image agree. */
export function isThinYear(data: YirData): boolean {
  return data.provenance.totalEvents < THIN_YEAR_EVENTS;
}

/** Whether the approximate-hours line is worth showing at all. Suppressed
 *  when almost none of it rests on a real runtime — an invented number with a
 *  confident-looking label is worse than no number. */
export function showsHours(data: YirData): boolean {
  return data.tally.approxHours > 0 && data.tally.runtimeConfidence >= RUNTIME_CONFIDENCE_FLOOR;
}

const DECADE_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight"];

/**
 * The single line that best describes this person, for the share image.
 *
 * Ordered by what people actually post: a taste verdict beats a volume stat,
 * and a persona beats a number.
 *
 * ============================================================================
 * THE THIN-YEAR RUNG IS NOT A FALLBACK — IT LEANS INTO THE THINNESS
 * ============================================================================
 * A first draft of this ladder had a hole exactly where it could least afford
 * one. Three films across 1975, 1988 and 2021 produced NO persona (three
 * genres is neither specialist nor omnivore), NO critic verdict, NO top show,
 * and fewer decades than the "decades deep" rung wanted — so the most common
 * year-one user got the blandest possible line, "A year of watching". Caught
 * by a test written for that exact case rather than in review.
 *
 * The fix is not a lower threshold. It is that a small year has its own
 * genuinely charming framing available: **the ratio**. "Three decades in
 * three films" is a better line than "3 decades deep" precisely BECAUSE the
 * count is small — it turns the thinness into the point instead of
 * apologising for it. That framing needs almost no data, which is what the
 * brief actually asked for.
 */
export function headlineFor(data: YirData): string {
  if (data.critics) {
    if (data.critics.persona === "tough") return "Tougher than the crowd";
    if (data.critics.persona === "generous") return "Easier to please than the crowd";
    return "Dead-on with the crowd";
  }

  if (data.genres?.persona === "omnivore") return "A bit of everything";
  if (data.genres?.persona === "specialist") return `A ${data.genres.topGenre} person`;

  // The thin-year rung. Only offered when the count is genuinely small, since
  // "three decades in ninety films" is not a boast.
  const titles = distinctTitleCount(data);
  if (isThinYear(data) && data.decades && data.decades.count >= 2 && titles > 0) {
    const decades = DECADE_WORDS[data.decades.count] ?? String(data.decades.count);
    const noun = titles === 1 ? "one title" : `${titles} titles`;
    return `${capitalize(decades)} decades in ${noun}`;
  }

  if (data.decades && data.decades.count >= 4) return `${data.decades.count} decades deep`;
  if (data.topShow) return `All in on ${data.topShow.name}`;
  if (data.decades) return `${data.decades.oldestYear} to ${data.decades.newestYear}`;
  return "A year of watching";
}

/** Films plus whole-shows, which is what "titles" means to a reader — an
 *  episode count would make the thin-year ratio meaningless. */
function distinctTitleCount(data: YirData): number {
  return data.tally.movies + data.tally.shows + (data.topShow ? 1 : 0);
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
