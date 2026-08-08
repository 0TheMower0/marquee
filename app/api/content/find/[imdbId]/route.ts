import { CACHE_SECONDS, enforceRateLimit, handleRouteError, jsonOk } from "@/lib/api/respond";
import { parseImdbId } from "@/lib/api/validate";
import { getContentProvider } from "@/lib/content";
import { RATE_LIMITS } from "@/lib/ratelimit";

/**
 * GET /api/content/find/:imdbId
 *
 * Single external-id lookup, under the ordinary `read` limit. Phase 7's bulk
 * importer deliberately does NOT come through here — it uses the batched
 * `/api/import/resolve` endpoint, because a per-row request would exhaust the
 * per-IP limit inside the first minute of a three-thousand-row file. This
 * serves one-off lookups and completes the `ContentProvider` contract for
 * `httpProvider`.
 *
 * Cached with `detail`'s long lifetime, not `search`'s short one: an
 * IMDb-to-TMDB id pairing is a fact about two catalogues rather than a value
 * that drifts.
 */
export async function GET(
  request: Request,
  ctx: RouteContext<"/api/content/find/[imdbId]">,
) {
  const limited = await enforceRateLimit(request, RATE_LIMITS.read);
  if (limited) return limited;

  try {
    const raw = await ctx.params;
    const imdbId = parseImdbId(raw.imdbId);

    const titles = await getContentProvider().findByExternalId(imdbId);
    return jsonOk(titles, CACHE_SECONDS.detail);
  } catch (error) {
    return handleRouteError(error, "findByExternalId");
  }
}
