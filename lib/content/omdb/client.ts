import "server-only";

import { ContentError } from "../errors";
import type { ExternalRating } from "../types";
import { toExternalRatings, type OmdbResponse } from "./normalize";

/**
 * OMDb — the second upstream credential, held to exactly the same rules as
 * TMDB (see CLAUDE.md, "Secret handling"):
 *
 *   1. `OMDB_API_KEY`, never prefixed `NEXT_PUBLIC_`.
 *   2. This module is `server-only`, so an accidental client import is a
 *      BUILD error rather than a runtime credential leak.
 *   3. All OMDb traffic originates server-side; the browser reaches it only
 *      through `app/api/content/title/[mediaType]/[id]/ratings`.
 *
 * One difference from TMDB worth stating: OMDb sends the key as a QUERY
 * PARAMETER (`?apikey=`). That is the only authentication it supports — there
 * is no header form — so the "never as a query param" rule written for TMDB
 * cannot apply here. The mitigation is that this URL is only ever constructed
 * server-side and never logged; `logSafeUrl()` below exists so an error path
 * can't accidentally print it.
 */

const OMDB_API_BASE = "https://www.omdbapi.com/";

/** OMDb is a small, usually-fast API and it is a SECONDARY source — the page
 *  renders fine without it. A shorter ceiling than TMDB's 8s is right: waiting
 *  longer for optional data is worse than not having it. */
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * Seven days.
 *
 * The free tier allows **1,000 requests/day** and ratings barely move — an
 * IMDb score shifts in the third decimal over a week for anything but a brand
 * new release. Combined with the CDN `s-maxage` on the route handler, this is
 * what keeps a personal deployment far inside the quota. Do not shorten it
 * without a reason; the quota is the binding constraint here, not freshness.
 */
export const OMDB_REVALIDATE_SECONDS = 60 * 60 * 24 * 7;

/** Distinguishes "no key configured" (fine — zero-config is a guarantee of
 *  this project) from "key configured but rejected" (worth surfacing). */
export function hasOmdbKey(): boolean {
  return !!process.env.OMDB_API_KEY?.trim();
}

/** Never interpolate the key into anything that might be logged. */
function logSafeUrl(imdbId: string): string {
  return `${OMDB_API_BASE}?i=${imdbId}&apikey=[redacted]`;
}

/**
 * OMDb reports failure in the response BODY, and returns 401 for BOTH an
 * invalid key and an exhausted quota — so the status code alone cannot tell
 * them apart. The `Error` string is the only signal that distinguishes
 * "you're rate limited" from "your key is wrong", and those map to different
 * `ContentErrorKind`s with different UI treatment.
 *
 * Verified against the live API:
 *   no key      -> 401 {"Response":"False","Error":"No API key provided."}
 *   bad key     -> 401 {"Response":"False","Error":"Invalid API key!"}
 *   over quota  -> 401 {"Response":"False","Error":"Request limit reached!"}
 */
function kindFromOmdbError(message: string | undefined): "rate_limited" | "unauthorized" {
  return /limit/i.test(message ?? "") ? "rate_limited" : "unauthorized";
}

/**
 * Fetches ratings for one IMDb id.
 *
 * Returns [] — rather than throwing — when OMDb has no record of the title,
 * because that is an ordinary outcome for obscure or very new titles and the
 * page is expected to carry on with TMDB's own score.
 *
 * Throws `ContentError` for genuine failures (bad key, quota, network) so the
 * route handler can log them and the caller can decide. The detail page
 * chooses to swallow those too — a secondary source must never take down a
 * page — but that is the CALLER's decision to make, not this function's to
 * hide.
 */
export async function fetchOmdbRatings(imdbId: string): Promise<ExternalRating[]> {
  const key = process.env.OMDB_API_KEY?.trim();
  if (!key) {
    // Not an error: the app is designed to run with no credentials at all.
    return [];
  }

  const url = new URL(OMDB_API_BASE);
  url.searchParams.set("i", imdbId);
  url.searchParams.set("apikey", key);
  // Short plot keeps the payload small; we only ever read the rating fields.
  url.searchParams.set("plot", "short");

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      next: { revalidate: OMDB_REVALIDATE_SECONDS },
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "TimeoutError") {
      throw new ContentError(
        "network",
        `OMDb request timed out after ${REQUEST_TIMEOUT_MS}ms (${logSafeUrl(imdbId)}).`,
        { cause },
      );
    }
    throw new ContentError("network", `Could not reach OMDb (${logSafeUrl(imdbId)}).`, {
      cause,
    });
  }

  let body: OmdbResponse;
  try {
    body = (await response.json()) as OmdbResponse;
  } catch (cause) {
    throw new ContentError(
      "unknown",
      `OMDb returned a malformed JSON body for ${imdbId}.`,
      { cause },
    );
  }

  // Status is checked AFTER parsing, because the body is the authoritative
  // signal and it is present even on a 401.
  if (!response.ok) {
    throw new ContentError(
      kindFromOmdbError(body.Error),
      `OMDb responded ${response.status} for ${imdbId}: ${body.Error ?? "no detail"}`,
    );
  }

  return toExternalRatings(body);
}
