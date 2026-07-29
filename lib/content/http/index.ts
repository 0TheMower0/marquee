// NOTE: deliberately NO `import "server-only"`.
//
// Every other module under lib/content/ is server-only by design. This one is
// the single sanctioned exception: it is the implementation Client Components
// are *meant* to import. It reaches the same data by fetching our own
// `app/api/content/*` routes, so no credential, no TMDB URL and no provider
// code is ever bundled for the browser.
//
// It must therefore never import `getContentProvider`, `tmdbProvider`, or
// anything under `lib/content/tmdb/`. Doing so would drag server-only code
// into the client graph and break the build — which is the guard working.

import { ContentError } from "../errors";
import type {
  ContentProvider,
  SearchTitlesOptions,
  TrendingOptions,
} from "../provider";
import type {
  Episode,
  MediaType,
  PagedResult,
  Season,
  Title,
  TitleSummary,
  WatchProvider,
} from "../types";
import { isContentErrorKind, kindFromStatus, type ApiErrorBody } from "./wire";

const BASE_PATH = "/api/content";

/**
 * Same reasoning as `tmdbFetch`'s timeout: a hung connection that never
 * settles is worse than a failed one, because the UI has no way to recover.
 * The Next fetch-memoization tradeoff documented in CLAUDE.md does not apply
 * here — this runs in the browser, where that cache doesn't exist.
 */
const TIMEOUT_MS = 10_000;

type QueryValue = string | number | boolean | undefined;

function buildUrl(path: string, params?: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    // Undefined means "not specified" — it must be omitted entirely rather
    // than sent as the string "undefined", which would fail validation.
    if (value !== undefined) search.set(key, String(value));
  }
  const qs = search.toString();
  return `${BASE_PATH}${path}${qs ? `?${qs}` : ""}`;
}

/**
 * Turn a non-OK response back into a `ContentError` carrying the original
 * `kind`.
 *
 * The body is authoritative when it is our envelope, because the route handler
 * knows precisely what failed. Status code is only the fallback, for responses
 * that never reached the handler at all (CDN error page, proxy timeout).
 */
async function toContentError(response: Response): Promise<ContentError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  const envelope = body as ApiErrorBody | null;
  const kind = isContentErrorKind(envelope?.error?.kind)
    ? envelope.error.kind
    : kindFromStatus(response.status);

  const message =
    typeof envelope?.error?.message === "string"
      ? envelope.error.message
      : `Request failed with status ${response.status}`;

  return new ContentError(kind, message);
}

async function apiFetch<T>(
  path: string,
  params?: Record<string, QueryValue>,
  externalSignal?: AbortSignal,
): Promise<T> {
  let response: Response;

  // Combined so either source can abort: the caller's own cancellation (the
  // Search page aborting a stale request) or our internal ceiling on a hung
  // connection. AbortSignal.any is the same platform-API vintage as
  // AbortSignal.timeout, already relied on above.
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, AbortSignal.timeout(TIMEOUT_MS)])
    : AbortSignal.timeout(TIMEOUT_MS);

  try {
    response = await fetch(buildUrl(path, params), {
      headers: { accept: "application/json" },
      signal,
    });
  } catch (cause) {
    // An externally aborted request (the caller cancelled it) is not a
    // content failure — rethrow as-is so the caller's own cancellation
    // detection (a request-id guard) can recognize and silently discard it,
    // rather than dressing it up as a ContentError('network') the UI would
    // have to explain to the user.
    if (externalSignal?.aborted) throw cause;
    // Never reached our server: offline, DNS failure, or the timeout above.
    throw new ContentError(
      "network",
      "Could not reach the Marquee API.",
      { cause },
    );
  }

  if (!response.ok) throw await toContentError(response);

  try {
    return (await response.json()) as T;
  } catch (cause) {
    throw new ContentError(
      "unknown",
      "The Marquee API returned a malformed response.",
      { cause },
    );
  }
}

/**
 * The same `ContentProvider` contract as mockProvider and tmdbProvider, over
 * HTTP. A Client Component using this and a Server Component using
 * `getContentProvider()` render from identical data.
 */
export const httpProvider: ContentProvider = {
  async searchTitles(query: string, options: SearchTitlesOptions = {}) {
    // Short-circuit before the network, matching mockProvider and
    // tmdbProvider — both return an empty page for a blank query. The route
    // does the same thing, so this is purely saving a pointless round trip.
    if (!query.trim()) {
      return { items: [], page: 1, totalPages: 1, totalResults: 0 };
    }

    return apiFetch<PagedResult<TitleSummary>>(
      "/search",
      {
        query: query.trim(),
        mediaType: options.mediaType,
        page: options.page,
      },
      options.signal,
    );
  },

  async getTrending(
    mediaType: MediaType | "all",
    options: TrendingOptions = {},
  ) {
    return apiFetch<PagedResult<TitleSummary>>("/trending", {
      mediaType,
      page: options.page,
    });
  },

  async getTitle(id: string, mediaType: MediaType) {
    return apiFetch<Title>(
      `/title/${mediaType}/${encodeURIComponent(id)}`,
    );
  },

  async getSeasons(showId: string) {
    return apiFetch<Season[]>(`/tv/${encodeURIComponent(showId)}/seasons`);
  },

  async getSeasonEpisodes(showId: string, seasonNumber: number) {
    return apiFetch<Episode[]>(
      `/tv/${encodeURIComponent(showId)}/seasons/${seasonNumber}`,
    );
  },

  async getSimilar(id: string, mediaType: MediaType) {
    return apiFetch<TitleSummary[]>(
      `/title/${mediaType}/${encodeURIComponent(id)}/similar`,
    );
  },

  async getRecommendations(id: string, mediaType: MediaType) {
    return apiFetch<TitleSummary[]>(
      `/title/${mediaType}/${encodeURIComponent(id)}/recommendations`,
    );
  },

  async getWatchProviders(id: string, mediaType: MediaType, region?: string) {
    return apiFetch<WatchProvider[]>(
      `/title/${mediaType}/${encodeURIComponent(id)}/watch-providers`,
      { region },
    );
  },
};
