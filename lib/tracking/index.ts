/**
 * Public surface of the tracking layer. Components import from here, never
 * from the individual modules — mirrors the convention in lib/content and
 * lib/storage.
 */
export { TrackingProvider, useTracking } from "./context";
export { trackingStore } from "./store";
export { entryKey, toTrackingSummary } from "./types";
export type { TrackingEntry, TrackingStatus } from "./types";
