import { CACHE_SECONDS, enforceRateLimit, handleRouteError, jsonOk } from "@/lib/api/respond";
import { parseId, parseSeasonNumber } from "@/lib/api/validate";
import { getContentProvider } from "@/lib/content";
import { RATE_LIMITS } from "@/lib/ratelimit";

/** GET /api/content/tv/:showId/seasons/:seasonNumber */
export async function GET(
  request: Request,
  ctx: RouteContext<"/api/content/tv/[showId]/seasons/[seasonNumber]">,
) {
  const limited = await enforceRateLimit(request, RATE_LIMITS.read);
  if (limited) return limited;

  try {
    const raw = await ctx.params;
    const showId = parseId(raw.showId);
    const seasonNumber = parseSeasonNumber(raw.seasonNumber);

    const episodes = await getContentProvider().getSeasonEpisodes(
      showId,
      seasonNumber,
    );
    return jsonOk(episodes, CACHE_SECONDS.detail);
  } catch (error) {
    return handleRouteError(error, "getSeasonEpisodes");
  }
}
