import type { NextRequest } from "next/server";

import { CACHE_SECONDS, handleRouteError, jsonOk } from "@/lib/api/respond";
import { parseId, parseMediaType, parseRegion } from "@/lib/api/validate";
import { getContentProvider } from "@/lib/content";

/**
 * GET /api/content/title/movie|tv/:id/watch-providers?region=US
 *
 * Reminder for whoever renders this: TMDB sources watch provider data from
 * JustWatch, and their terms require a visible "Powered by JustWatch" credit
 * wherever it is displayed — separate from the TMDB attribution in the footer.
 * See CLAUDE.md, Legal / attribution.
 */
export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/content/title/[mediaType]/[id]/watch-providers">,
) {
  try {
    const raw = await ctx.params;
    const mediaType = parseMediaType(raw.mediaType);
    const id = parseId(raw.id);
    const region = parseRegion(request.nextUrl.searchParams.get("region"));

    // `undefined` lets the provider apply its own default rather than this
    // route hardcoding a second, competing one.
    const providers = await getContentProvider().getWatchProviders(
      id,
      mediaType,
      region,
    );
    return jsonOk(providers, CACHE_SECONDS.watchProviders);
  } catch (error) {
    return handleRouteError(error, "getWatchProviders");
  }
}
