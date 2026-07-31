import { CACHE_SECONDS, enforceRateLimit, handleRouteError, jsonOk } from "@/lib/api/respond";
import { parseId } from "@/lib/api/validate";
import { getContentProvider } from "@/lib/content";
import { RATE_LIMITS } from "@/lib/ratelimit";

/** GET /api/content/tv/:showId/seasons */
export async function GET(
  request: Request,
  ctx: RouteContext<"/api/content/tv/[showId]/seasons">,
) {
  const limited = await enforceRateLimit(request, RATE_LIMITS.read);
  if (limited) return limited;

  try {
    const { showId } = await ctx.params;
    const seasons = await getContentProvider().getSeasons(parseId(showId));
    return jsonOk(seasons, CACHE_SECONDS.detail);
  } catch (error) {
    return handleRouteError(error, "getSeasons");
  }
}
