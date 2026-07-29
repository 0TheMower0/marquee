/**
 * Public surface of the tracking layer. Components import from here, never
 * from the individual modules — mirrors the convention in lib/content and
 * lib/storage.
 */
export { TrackingProvider, useTracking } from "./context";
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
