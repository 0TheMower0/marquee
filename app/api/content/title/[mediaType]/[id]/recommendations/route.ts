import { CACHE_SECONDS, handleRouteError, jsonOk } from "@/lib/api/respond";
import { parseId, parseMediaType } from "@/lib/api/validate";
import { getContentProvider } from "@/lib/content";

/** GET /api/content/title/movie|tv/:id/recommendations */
export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/content/title/[mediaType]/[id]/recommendations">,
) {
  try {
    const raw = await ctx.params;
    const mediaType = parseMediaType(raw.mediaType);
    const id = parseId(raw.id);

    const items = await getContentProvider().getRecommendations(id, mediaType);
    return jsonOk(items, CACHE_SECONDS.related);
  } catch (error) {
    return handleRouteError(error, "getRecommendations");
  }
}
