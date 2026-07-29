import { CACHE_SECONDS, handleRouteError, jsonOk } from "@/lib/api/respond";
import { parseId, parseSeasonNumber } from "@/lib/api/validate";
import { getContentProvider } from "@/lib/content";

/** GET /api/content/tv/:showId/seasons/:seasonNumber */
export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/content/tv/[showId]/seasons/[seasonNumber]">,
) {
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
