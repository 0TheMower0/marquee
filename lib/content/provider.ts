import type {
  Episode,
  MediaType,
  PagedResult,
  Season,
  Title,
  TitleSummary,
  WatchProvider,
} from "./types";

export interface SearchTitlesOptions {
  mediaType?: MediaType;
  page?: number;
  /**
   * Lets a caller cancel an in-flight search. The Search page aborts the
   * previous request every time the query or filter changes, so a slow
   * early response can never overwrite a faster later one.
   *
   * A provider honoring this MAY reject with the signal's own abort reason
   * (typically a `DOMException` named `"AbortError"`) instead of a
   * `ContentError` — a deliberate, narrow exception to "every method rejects
   * with ContentError only" below. An aborted call isn't a content failure,
   * it's the caller withdrawing the request, and the caller is expected to
   * recognize and discard it (e.g. via a request-id guard) rather than
   * render it as an error.
   *
   * `mockProvider` and `httpProvider` — the two paths the Search page
   * actually exercises client-side — both honor it. `tmdbProvider` accepts
   * but does not act on it: real cancellation there would mean extending the
   * shared `tmdbFetch` helper's signal handling *and* forwarding the
   * incoming request's signal through the `/api/content/search` route
   * handler — genuine plumbing that belongs to the client-data-seam layer
   * (Phase 2 Step 1), not to the search page itself. See the note in
   * `tmdb/index.ts`.
   */
  signal?: AbortSignal;
}

export interface TrendingOptions {
  page?: number;
}

/**
 * One interface, two implementations (mockProvider, tmdbProvider). No UI code
 * may import a provider directly — always go through `getContentProvider()`
 * in lib/content/index.ts.
 *
 * Every method rejects with `ContentError` only (see errors.ts). Never let a
 * raw fetch/network error or a provider-specific exception escape this
 * boundary — normalize it to a `ContentError` before throwing.
 */
export interface ContentProvider {
  searchTitles(
    query: string,
    options?: SearchTitlesOptions,
  ): Promise<PagedResult<TitleSummary>>;

  /**
   * `mediaType: "all"` returns a mixed movie+TV feed — the shape the Home
   * page grid actually wants (competing apps mix media types on a single
   * trending rail rather than forcing a tab choice up front).
   */
  getTrending(
    mediaType: MediaType | "all",
    options?: TrendingOptions,
  ): Promise<PagedResult<TitleSummary>>;

  getTitle(id: string, mediaType: MediaType): Promise<Title>;

  /** TV only. Rejects with `not_found` if `showId` is a movie id. */
  getSeasons(showId: string): Promise<Season[]>;

  /** TV only. Rejects with `not_found` if the show or season doesn't exist. */
  getSeasonEpisodes(showId: string, seasonNumber: number): Promise<Episode[]>;

  getSimilar(id: string, mediaType: MediaType): Promise<TitleSummary[]>;

  getRecommendations(id: string, mediaType: MediaType): Promise<TitleSummary[]>;

  /**
   * `region` is an ISO 3166-1 country code (e.g. "US"). Defaults to "US" when
   * omitted — implementations should apply that default themselves rather
   * than requiring every call site to pass it.
   */
  getWatchProviders(
    id: string,
    mediaType: MediaType,
    region?: string,
  ): Promise<WatchProvider[]>;
}
