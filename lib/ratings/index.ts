/**
 * Public surface of the ratings layer. Components import from here, never
 * from the individual modules — mirrors the convention in lib/tracking.
 */
export { RatingsProvider, useRatings } from "./context";
export { ratingsStore } from "./store";
export { mergeRatingPatch, ratingKey } from "./types";
export type { RatingEntry } from "./types";
