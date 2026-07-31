/**
 * Public surface of the stats layer. Components import from here, never
 * from the individual modules — mirrors every other lib/ package.
 */
export {
  computeAllTimeCounts,
  computeDecadeCounts,
  computeGenreCounts,
  computeHeatmap,
  computeRatingComparison,
  computeRatingDistribution,
  computeThisYearCounts,
  computeTopShows,
  computeWatchTime,
} from "./aggregate";
export type {
  DecadeCount,
  GenreCount,
  HeatmapDay,
  PeriodCounts,
  RatingBucket,
  RatingComparison,
  StatsSummary,
  TopShow,
  WatchTimeSummary,
} from "./types";
