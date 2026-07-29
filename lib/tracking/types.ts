import type { MediaType, Title, TitleSummary } from "@/lib/content/types";

/**
 * Three mutually exclusive states, matching the three sections of My Library.
 * A title has ONE status at a time — "watchlist" and "watched" are not
 * independent flags, so a title cannot be simultaneously on the watchlist and
 * marked watched. Setting a new status always replaces whatever came before.
 */
export type TrackingStatus = "watchlist" | "watching" | "watched";

export interface TrackingEntry {
  id: string;
  mediaType: MediaType;
  status: TrackingStatus;
  addedAt: Date;
  updatedAt: Date;
  /**
   * A snapshot of the title at the moment it was tracked, not a live
   * reference. My Library renders directly from this — re-fetching every
   * tracked title from the provider on every Library visit would be N calls
   * for one page. Tradeoff: the poster/rating shown here can go stale if the
   * source data changes later. Acceptable for Phase 2; the title detail page
   * always shows a freshly fetched `Title` regardless of what's cached here.
   */
  summary: TitleSummary;
}

/**
 * Explicit allowlist, matching the pattern `mock/index.ts`'s `toSummary()`
 * already established for the same reason: never spread-and-omit `Title`, or
 * a field added to it later (cast, backdropUrl, ...) leaks into every stored
 * snapshot without anyone deciding it should.
 */
export function toTrackingSummary(title: Title): TitleSummary {
  return {
    id: title.id,
    mediaType: title.mediaType,
    name: title.name,
    year: title.year,
    overview: title.overview,
    genres: title.genres,
    posterUrl: title.posterUrl,
    placeholder: title.placeholder,
    rating: title.rating,
  };
}

export function entryKey(mediaType: MediaType, id: string): string {
  return `${mediaType}:${id}`;
}
