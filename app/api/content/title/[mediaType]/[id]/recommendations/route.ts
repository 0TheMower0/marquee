import { CACHE_SECONDS, enforceRateLimit, handleRouteError, jsonOk } from "@/lib/api/respond";
import { parseId, parseMediaType } from "@/lib/api/validate";
import { getContentProvider } from "@/lib/content";
import { RATE_LIMITS } from "@/lib/ratelimit";

/** GET /api/content/title/movie|tv/:id/recommendations */
export async function GET(
  request: Request,
  ctx: RouteContext<"/api/content/title/[mediaType]/[id]/recommendations">,
) {
  const limited = await enforceRateLimit(request, RATE_LIMITS.read);
  if (limited) return limited;

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
