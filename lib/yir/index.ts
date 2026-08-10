/**
 * Public surface of the Year in Review layer. Components import from here.
 *
 * Everything in this package is PURE and reads from LOCAL data only — the
 * watch log, tracking entries and rating scores, all of which already live in
 * this browser. Year in Review makes no network request and requires no
 * account, so it works offline and works signed out.
 *
 * Two things it deliberately never touches:
 *
 *   - `RatingEntry.note` — private, local-only free text. This data ends up
 *     on a shareable image.
 *   - `lib/lists` entirely. Not "filtered by visibility": the store is never
 *     read, which is a guarantee anyone can verify with grep rather than by
 *     reasoning about a filter.
 */
export { computeYir, rollingRange, CRITIC_MIN_SAMPLE, RHYTHM_MIN_SAMPLE } from "./compute";
export type { YirInput } from "./compute";
export { headlineFor, isThinYear, selectCards, showsHours } from "./cards";
export type { DeckOptions } from "./cards";
export type {
  CriticDelta,
  CriticVerdict,
  DateRange,
  DecadeReach,
  FirstWatch,
  GenreShape,
  Provenance,
  Rhythm,
  TopShow,
  YirCardId,
  YirData,
  YirTally,
} from "./types";
