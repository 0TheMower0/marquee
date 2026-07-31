import { CACHE_SECONDS, enforceRateLimit, handleRouteError, jsonOk } from "@/lib/api/respond";
import { parseId, parseMediaType } from "@/lib/api/validate";
import { getContentProvider } from "@/lib/content";
import { RATE_LIMITS } from "@/lib/ratelimit";

/** GET /api/content/title/movie|tv/:id */
export async function GET(
  request: Request,
  ctx: RouteContext<"/api/content/title/[mediaType]/[id]">,
) {
  const limited = await enforceRateLimit(request, RATE_LIMITS.read);
  if (limited) return limited;

  try {
    // Next 16: route context params is a Promise, same as page params.
    const raw = await ctx.params;
    const mediaType = parseMediaType(raw.mediaType);
    const id = parseId(raw.id);

    const title = await getContentProvider().getTitle(id, mediaType);
    return jsonOk(title, CACHE_SECONDS.detail);
  } catch (error) {
    return handleRouteError(error, "getTitle");
  }
}
