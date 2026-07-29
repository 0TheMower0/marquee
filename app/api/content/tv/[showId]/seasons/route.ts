import { CACHE_SECONDS, handleRouteError, jsonOk } from "@/lib/api/respond";
import { parseId } from "@/lib/api/validate";
import { getContentProvider } from "@/lib/content";

/** GET /api/content/tv/:showId/seasons */
export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/content/tv/[showId]/seasons">,
) {
  try {
    const { showId } = await ctx.params;
    const seasons = await getContentProvider().getSeasons(parseId(showId));
    return jsonOk(seasons, CACHE_SECONDS.detail);
  } catch (error) {
    return handleRouteError(error, "getSeasons");
  }
}
