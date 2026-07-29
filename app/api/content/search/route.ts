import type { NextRequest } from "next/server";

import { CACHE_SECONDS, handleRouteError, jsonOk } from "@/lib/api/respond";
import { parseMediaType, parsePage, parseQuery } from "@/lib/api/validate";
import { getContentProvider } from "@/lib/content";
import type { MediaType, PagedResult, TitleSummary } from "@/lib/content/types";

/** GET /api/content/search?query=...&mediaType=movie|tv&page=1 */
export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const query = parseQuery(params.get("query"));
    const page = parsePage(params.get("page"));

    // Unlike trending, an absent mediaType here means "search everything",
    // which the provider expresses as `undefined`, not "all".
    const rawMediaType = params.get("mediaType");
    const mediaType: MediaType | undefined =
      rawMediaType === null || rawMediaType === ""
        ? undefined
        : parseMediaType(rawMediaType);

    // A blank query short-circuits rather than 400s — both other providers
    // return an empty page for it, and this transport must not be the odd one
    // out. See the note in lib/api/validate.ts.
    if (!query) {
      const empty: PagedResult<TitleSummary> = {
        items: [],
        page: 1,
        totalPages: 1,
        totalResults: 0,
      };
      return jsonOk(empty, CACHE_SECONDS.search);
    }

    const result = await getContentProvider().searchTitles(query, {
      mediaType,
      page,
    });
    return jsonOk(result, CACHE_SECONDS.search);
  } catch (error) {
    return handleRouteError(error, "searchTitles");
  }
}
