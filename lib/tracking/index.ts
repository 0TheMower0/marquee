/**
 * Public surface of the tracking layer. Components import from here, never
 * from the individual modules — mirrors the convention in lib/content and
 * lib/storage.
 */
export { TrackingProvider, useTracking } from "./context";
export {
  deriveStatus,
  getTitleProgress,
  isEpisodeWatched,
  markEpisode,
  markSeason,
  markWatchedUpTo,
  nextUnwatchedEpisode,
  reconcileCoarseWatched,
  totalEpisodeCount,
  unmarkEpisode,
  unmarkSeason,
  watchedEpisodeCount,
} from "./progress";
export type { EpisodeRef, TitleProgress } from "./progress";
export {
  addRange,
  countRanges,
  normalizeRanges,
  rangesContain,
  removeRange,
} from "./ranges";
export { normalizeWatchedEpisodes, trackingStore } from "./store";
export { entryKey, toTrackingSummary } from "./types";
export type {
  EpisodeRange,
  MovieTrackingEntry,
  SeasonEpisodeCounts,
  TrackingEntry,
  TrackingStatus,
  TvTrackingEntry,
  WatchedEpisodes,
} from "./types";
