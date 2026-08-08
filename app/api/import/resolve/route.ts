import { enforceRateLimit, handleRouteError } from "@/lib/api/respond";
import { BadRequestError } from "@/lib/api/validate";
import { getContentProvider } from "@/lib/content";
import { IMPORT_BATCH_LIMIT, isImportRow } from "@/lib/import/types";
import { resolveRows } from "@/lib/import/resolve";
import { RATE_LIMITS } from "@/lib/ratelimit";

/**
 * POST /api/import/resolve
 *
 * Matches a BATCH of parsed CSV rows to titles. The batching is the whole
 * point: resolving one row per request would trip our own per-IP `search`
 * limit thirty rows into a three-thousand-row file, long before TMDB noticed
 * anything. See `RATE_LIMITS.importResolve`.
 *
 * ============================================================================
 * WHY A POST, AND WHY IT IS `no-store`
 * ============================================================================
 * Every other content route is a cacheable GET. This one cannot be: the input
 * is a list of up to 25 rows, which does not fit in a URL, and no two users'
 * batches are alike, so a CDN entry would never be hit anyway. The upstream
 * caching that actually matters still happens a layer down — `findByExternalId`
 * and `searchTitles` both go through Next's data cache with their own
 * revalidate lifetimes, so two users importing the same film share TMDB's
 * answer even though they do not share this response.
 *
 * Parsing stays on the CLIENT (in a Web Worker) and only these already-parsed
 * rows are sent. The user's viewing history never leaves their device as a
 * file — what crosses the wire is a title, a year and sometimes an IMDb id,
 * which is exactly what an ordinary search query already contains.
 */
export async function POST(request: Request) {
  const limited = await enforceRateLimit(request, RATE_LIMITS.importResolve);
  if (limited) return limited;

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new BadRequestError("body must be JSON");
    }

    const rows = (body as { rows?: unknown })?.rows;
    if (!Array.isArray(rows)) throw new BadRequestError("body.rows must be an array");
    if (rows.length > IMPORT_BATCH_LIMIT) {
      throw new BadRequestError(`at most ${IMPORT_BATCH_LIMIT} rows per request`);
    }

    // Validated field by field rather than trusted: this is a public endpoint
    // and every value below feeds either an upstream query string or the
    // scorer. A malformed row is the caller's bug, so it is a 400 — the same
    // BadRequestError-is-not-a-ContentError separation the content routes draw.
    if (!rows.every(isImportRow)) {
      throw new BadRequestError("body.rows contains a malformed row");
    }

    const resolved = await resolveRows(rows, getContentProvider());

    return Response.json(
      { rows: resolved },
      // Never cached, at any layer: this is one user's library data in a
      // request body, and a shared cache entry keyed on a URL that does not
      // vary with it would be exactly the leak `no-store` exists to prevent.
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return handleRouteError(error, "importResolve");
  }
}
