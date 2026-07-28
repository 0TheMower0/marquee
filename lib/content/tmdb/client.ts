import "server-only";

import { ContentError, type ContentErrorKind } from "../errors";

const TMDB_API_BASE = "https://api.themoviedb.org/3";

/** TMDB is normally fast; 8s is generous. Without a ceiling a hung connection
 *  would stall a Server Component render until the platform's own timeout. */
const REQUEST_TIMEOUT_MS = 8_000;

/**
 * Default persistent-cache lifetime. Individual calls override this — see the
 * REVALIDATE constants in ./index.ts.
 */
const DEFAULT_REVALIDATE_SECONDS = 3_600;

export interface TmdbFetchOptions {
  searchParams?: Record<string, string | number | boolean | undefined>;
  revalidateSeconds?: number;
}

/**
 * Reads the token lazily, on every call, rather than once at module load.
 *
 * That matters: `getContentProvider()` is called during prerender, and a
 * module-load-time throw would fail the whole build for anyone who hasn't
 * configured a token — including someone running in mock mode who never
 * touches this code path. Failing at call time keeps the zero-config
 * guarantee intact.
 */
function readToken(): string {
  const token = process.env.TMDB_READ_ACCESS_TOKEN?.trim();

  if (!token) {
    throw new ContentError(
      "unauthorized",
      "TMDB_READ_ACCESS_TOKEN is not set. Add it to .env.local and restart the dev server (env vars are read at server start, not hot-reloaded).",
    );
  }

  // v4 Read Access Tokens are JWTs: three dot-separated base64url segments,
  // always beginning "eyJ". v3 API keys are 32 hex characters. Pasting the v3
  // key into a Bearer header produces an opaque 401 from TMDB, so catch the
  // mix-up here where we can actually explain it.
  if (/^[0-9a-f]{32}$/i.test(token)) {
    throw new ContentError(
      "unauthorized",
      'TMDB_READ_ACCESS_TOKEN looks like a v3 API key (32 hex characters). Marquee authenticates with the v4 "API Read Access Token" — the long token starting "eyJ" on https://www.themoviedb.org/settings/api.',
    );
  }

  return token;
}

function mapHttpStatus(status: number): ContentErrorKind {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  // A 5xx is TMDB being broken rather than a transport failure, but the UI
  // treatment is identical ("their end is down, try again"), so it shares the
  // `network` kind rather than earning a sixth one.
  if (status >= 500) return "network";
  return "unknown";
}

/** TMDB error bodies look like `{ status_code, status_message }`. Best-effort:
 *  never let parsing an error body throw a second, more confusing error. */
async function readStatusMessage(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    if (
      body &&
      typeof body === "object" &&
      "status_message" in body &&
      typeof (body as { status_message: unknown }).status_message === "string"
    ) {
      return (body as { status_message: string }).status_message;
    }
  } catch {
    // Body wasn't JSON. Fall through to the generic message.
  }
  return null;
}

/**
 * The single choke point for every TMDB request. Guarantees two things the
 * rest of the app depends on:
 *   1. The token is sent as a Bearer header and never as a query parameter
 *      (query strings leak into logs, proxies, and browser history).
 *   2. Nothing but a `ContentError` escapes — no raw TypeError, DOMException,
 *      or JSON parse failure reaches UI code.
 */
export async function tmdbFetch<T>(
  path: string,
  options: TmdbFetchOptions = {},
): Promise<T> {
  const token = readToken();

  const url = new URL(TMDB_API_BASE + path);
  for (const [key, value] of Object.entries(options.searchParams ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      // NOTE: passing a signal opts this request out of Next's per-render
      // fetch *memoization* (documented in
      // node_modules/next/dist/docs/01-app/03-api-reference/04-functions/fetch.md).
      // The persistent data cache below is unaffected, and that's the one that
      // actually saves API calls across requests. If duplicate same-URL fetches
      // within a single render become a problem later, wrap the provider
      // methods in React's `cache()` — that dedupes regardless of signal.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      next: {
        revalidate: options.revalidateSeconds ?? DEFAULT_REVALIDATE_SECONDS,
      },
    });
  } catch (cause) {
    // AbortSignal.timeout() rejects with a DOMException named "TimeoutError".
    if (cause instanceof DOMException && cause.name === "TimeoutError") {
      throw new ContentError(
        "network",
        `TMDB request timed out after ${REQUEST_TIMEOUT_MS}ms (${path}).`,
        { cause },
      );
    }
    throw new ContentError("network", `Could not reach TMDB (${path}).`, {
      cause,
    });
  }

  if (!response.ok) {
    const detail = await readStatusMessage(response);
    throw new ContentError(
      mapHttpStatus(response.status),
      `TMDB responded ${response.status} for ${path}${detail ? `: ${detail}` : ""}`,
    );
  }

  try {
    return (await response.json()) as T;
  } catch (cause) {
    throw new ContentError(
      "unknown",
      `TMDB returned a malformed JSON body for ${path}.`,
      { cause },
    );
  }
}
