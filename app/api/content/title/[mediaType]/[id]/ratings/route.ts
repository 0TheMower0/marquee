import { CACHE_SECONDS, enforceRateLimit, handleRouteError, jsonOk } from "@/lib/api/respond";
import { parseId, parseMediaType } from "@/lib/api/validate";
import { getContentProvider } from "@/lib/content";
import type { ExternalRating } from "@/lib/content/types";
import { consumeDailyBudget, OMDB_DAILY_BUDGET, RATE_LIMITS } from "@/lib/ratelimit";

/**
 * GET /api/content/title/movie|tv/:id/ratings
 *
 * External ratings (IMDb / Rotten Tomatoes / Metacritic) for one title.
 *
 * This route is the ONLY way OMDb data reaches a browser. The OMDb key is
 * read exclusively inside `lib/content/omdb/client.ts`, which is
 * `server-only`, so the credential cannot be bundled for the client even by
 * accident — same arrangement as the TMDB token.
 *
 * Cached hard (7 days at the CDN, see CACHE_SECONDS.ratings). OMDb's free
 * tier allows 1,000 requests/day and ratings barely move, so caching here is
 * a quota measure, not just a latency one.
 */
export async function GET(
  request: Request,
  ctx: RouteContext<"/api/content/title/[mediaType]/[id]/ratings">,
) {
  // Two independent defences, because they stop different attacks.
  //
  // 1. Per-IP, the tightest of the three rules: stops one caller monopolising
  //    the quota.
  const limited = await enforceRateLimit(request, RATE_LIMITS.ratings);
  if (limited) return limited;

  try {
    const raw = await ctx.params;
    const mediaType = parseMediaType(raw.mediaType);
    const id = parseId(raw.id);

    // 2. Global daily budget: stops a thousand callers taking one each, and
    //    stops a caller who forges X-Forwarded-For to get a fresh per-IP
    //    bucket per request. Neither of those is visible to the limiter above.
    //
    //    Deliberately NOT a 429. Exhausted budget degrades to "no external
    //    ratings", which is the exact state a blank OMDB_API_KEY already
    //    produces and which CLAUDE.md documents as supported rather than
    //    broken — the detail page still renders on TMDB's own score. Erroring
    //    would break a page over a secondary source being unavailable.
    if (!consumeDailyBudget("omdb", OMDB_DAILY_BUDGET)) {
      const empty: ExternalRating[] = [];
      return jsonOk(empty, CACHE_SECONDS.ratingsDegraded);
    }

    const ratings = await getContentProvider().getExternalRatings(id, mediaType);
    return jsonOk(ratings, CACHE_SECONDS.ratings);
  } catch (error) {
    return handleRouteError(error, "getExternalRatings");
  }
}
