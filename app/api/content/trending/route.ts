import type { NextRequest } from "next/server";

import { CACHE_SECONDS, enforceRateLimit, handleRouteError, jsonOk } from "@/lib/api/respond";
import { parseMediaTypeOrAll, parsePage } from "@/lib/api/validate";
import { getContentProvider } from "@/lib/content";
import { RATE_LIMITS } from "@/lib/ratelimit";

/** GET /api/content/trending?mediaType=all|movie|tv&page=1 */
export async function GET(request: NextRequest) {
  const limited = await enforceRateLimit(request, RATE_LIMITS.read);
  if (limited) return limited;

  try {
    const params = request.nextUrl.searchParams;
    const mediaType = parseMediaTypeOrAll(params.get("mediaType"));
    const page = parsePage(params.get("page"));

    const result = await getContentProvider().getTrending(mediaType, { page });
    return jsonOk(result, CACHE_SECONDS.trending);
  } catch (error) {
    return handleRouteError(error, "getTrending");
  }
}
