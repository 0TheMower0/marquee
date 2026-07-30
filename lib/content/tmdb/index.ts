import "server-only";

import { ContentError } from "../errors";
import type {
  ContentProvider,
  SearchTitlesOptions,
  TrendingOptions,
} from "../provider";
import type { MediaType, PagedResult, TitleSummary } from "../types";
import { fetchOmdbRatings } from "../omdb/client";
import { tmdbFetch } from "./client";
import {
  extractImdbId,
  toEpisodes,
  toSeasons,
  toTitle,
  toTitleSummaries,
  toWatchProviders,
  type TmdbPagedResponse,
  type TmdbSeasonDetail,
  type TmdbTitleDetail,
  type TmdbWatchProviderResponse,
} from "./normalize";

/**
 * Cache lifetimes, tuned to how fast each kind of data actually changes.
 * Trending genuinely moves day to day; a film's runtime and cast do not.
 * Keeping these generous is also what keeps us comfortably inside TMDB's
 * free-tier expectations.
 */
const REVALIDATE = {
  search: 300, // 5 minutes
  trending: 3_600, // 1 hour
  detail: 86_400, // 24 hours
  related: 86_400, // 24 hours
  watchProviders: 43_200, // 12 hours — availability shifts, but not hourly
} as const;

const DEFAULT_REGION = "US";

function emptyPage<T>(): PagedResult<T> {
  return { items: [], page: 1, totalPages: 1, totalResults: 0 };
}

/**
 * One request serves both `getTitle` and `getExternalRatings`.
 *
 * `credits` backs cast/crew; `external_ids` is the only way to get a TV show's
 * IMDb id (see `extractImdbId`). TMDB bills `append_to_response` as a single
 * call regardless of how many sub-resources it names, so adding external_ids
 * costs nothing.
 *
 * Both callers MUST go through this helper. Next's data cache is keyed by the
 * full URL, so if `getExternalRatings` built its own URL with a different
 * `append_to_response` string it would miss `getTitle`'s cached entry and
 * double our TMDB call volume for every detail page view. Sharing one function
 * makes that impossible to get subtly wrong.
 */
function fetchTitleDetail(id: string, mediaType: MediaType): Promise<TmdbTitleDetail> {
  return tmdbFetch<TmdbTitleDetail>(`/${mediaType}/${encodeURIComponent(id)}`, {
    searchParams: { append_to_response: "credits,external_ids" },
    revalidateSeconds: REVALIDATE.detail,
  });
}

function toPagedSummaries(
  raw: TmdbPagedResponse,
  fallbackMediaType?: MediaType,
): PagedResult<TitleSummary> {
  const items = toTitleSummaries(raw.results, fallbackMediaType);
  return {
    items,
    page: raw.page ?? 1,
    totalPages: raw.total_pages ?? 1,
    // NOTE: TMDB's total_results counts person results too, which we filter
    // out. On /search/multi the total can therefore exceed the number of
    // cards actually rendered. Reporting TMDB's number keeps pagination
    // arithmetic correct, which matters more than a perfectly accurate count.
    totalResults: raw.total_results ?? items.length,
  };
}

export const tmdbProvider: ContentProvider = {
  async searchTitles(query, options: SearchTitlesOptions = {}) {
    const trimmed = query.trim();
    // TMDB rejects a blank query outright. Returning an empty page matches
    // mockProvider's behaviour so the two stay interchangeable.
    if (!trimmed) return emptyPage<TitleSummary>();

    // NOTE: options.signal is intentionally not honored here. tmdbFetch's
    // signal is its own request timeout, and combining an external one would
    // also need the incoming request's signal forwarded through
    // app/api/content/search/route.ts — real plumbing that belongs to the
    // client-data-seam layer (Phase 2 Step 1), not this feature. See the doc
    // on SearchTitlesOptions.signal in provider.ts. In practice this is
    // harmless: the Search page's own request-id guard discards a stale
    // TMDB-mode response regardless of whether the underlying request was
    // ever actually cancelled.

    const path =
      options.mediaType === "movie"
        ? "/search/movie"
        : options.mediaType === "tv"
          ? "/search/tv"
          : "/search/multi";

    const raw = await tmdbFetch<TmdbPagedResponse>(path, {
      searchParams: {
        query: trimmed,
        page: options.page ?? 1,
        include_adult: false,
      },
      revalidateSeconds: REVALIDATE.search,
    });

    // /search/movie and /search/tv omit media_type on each result, so the
    // requested type is supplied as the fallback.
    return toPagedSummaries(raw, options.mediaType);
  },

  async getTrending(mediaType, options: TrendingOptions = {}) {
    const scope = mediaType === "all" ? "all" : mediaType;
    const raw = await tmdbFetch<TmdbPagedResponse>(`/trending/${scope}/week`, {
      searchParams: { page: options.page ?? 1 },
      revalidateSeconds: REVALIDATE.trending,
    });
    return toPagedSummaries(
      raw,
      mediaType === "all" ? undefined : mediaType,
    );
  },

  async getTitle(id, mediaType) {
    const raw = await fetchTitleDetail(id, mediaType);

    const title = toTitle(raw, mediaType);
    if (!title) {
      // TMDB answered 200 but the payload had no usable id or name. Rare, but
      // returning a half-built Title would push the failure into the UI.
      throw new ContentError(
        "unknown",
        `TMDB returned an unusable record for ${mediaType} "${id}".`,
      );
    }
    return title;
  },

  async getSeasons(showId) {
    // A movie id here 404s at TMDB and surfaces as not_found, matching
    // mockProvider's explicit guard.
    const raw = await tmdbFetch<TmdbTitleDetail>(
      `/tv/${encodeURIComponent(showId)}`,
      { revalidateSeconds: REVALIDATE.detail },
    );
    // Includes season 0 ("Specials") when a show has one. That is real data
    // and Phase 3 progress tracking should account for it; mockProvider simply
    // has no specials to report.
    return toSeasons(raw.seasons);
  },

  async getSeasonEpisodes(showId, seasonNumber) {
    const raw = await tmdbFetch<TmdbSeasonDetail>(
      `/tv/${encodeURIComponent(showId)}/season/${seasonNumber}`,
      { revalidateSeconds: REVALIDATE.detail },
    );
    return toEpisodes(raw.episodes, showId, seasonNumber);
  },

  async getSimilar(id, mediaType) {
    const raw = await tmdbFetch<TmdbPagedResponse>(
      `/${mediaType}/${encodeURIComponent(id)}/similar`,
      { revalidateSeconds: REVALIDATE.related },
    );
    return toTitleSummaries(raw.results, mediaType);
  },

  async getRecommendations(id, mediaType) {
    const raw = await tmdbFetch<TmdbPagedResponse>(
      `/${mediaType}/${encodeURIComponent(id)}/recommendations`,
      { revalidateSeconds: REVALIDATE.related },
    );
    // /recommendations can mix movies and shows, so each result's own
    // media_type wins; the requested type is only the fallback.
    return toTitleSummaries(raw.results, mediaType);
  },

  async getExternalRatings(id, mediaType) {
    // Resolves through the SAME cached request `getTitle` already made for
    // this page — see fetchTitleDetail. In practice this costs zero extra
    // TMDB calls on a detail page view.
    const raw = await fetchTitleDetail(id, mediaType);
    const imdbId = extractImdbId(raw);

    // No IMDb id means there is nothing to ask OMDb about. Common enough for
    // obscure titles; the page carries on with TMDB's own score.
    if (!imdbId) return [];

    return fetchOmdbRatings(imdbId);
  },

  async getWatchProviders(id, mediaType, region = DEFAULT_REGION) {
    const raw = await tmdbFetch<TmdbWatchProviderResponse>(
      `/${mediaType}/${encodeURIComponent(id)}/watch/providers`,
      { revalidateSeconds: REVALIDATE.watchProviders },
    );
    return toWatchProviders(raw, region.toUpperCase());
  },
};
