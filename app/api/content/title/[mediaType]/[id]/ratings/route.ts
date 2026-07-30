import { CACHE_SECONDS, handleRouteError, jsonOk } from "@/lib/api/respond";
import { parseId, parseMediaType } from "@/lib/api/validate";
import { getContentProvider } from "@/lib/content";

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
  _request: Request,
  ctx: RouteContext<"/api/content/title/[mediaType]/[id]/ratings">,
) {
  try {
    const raw = await ctx.params;
    const mediaType = parseMediaType(raw.mediaType);
    const id = parseId(raw.id);

    const ratings = await getContentProvider().getExternalRatings(id, mediaType);
    return jsonOk(ratings, CACHE_SECONDS.ratings);
  } catch (error) {
    return handleRouteError(error, "getExternalRatings");
  }
}
