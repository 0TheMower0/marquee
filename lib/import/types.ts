import type { MediaType, TitleSummary } from "@/lib/content/types";

/**
 * Domain types for CSV import. See `docs/phase-7-import-design.md` for the
 * reasoning behind the pipeline shape; the short version is that every parser
 * produces `ImportRow[]` and **nothing downstream knows which source a row
 * came from**. Adding TV Time or Trakt later is then one new parser and zero
 * changes to matching, review, or commit — the same discipline that keeps
 * `ContentProvider` swappable.
 */

/** Which file within which export produced a row. Kept granular (not just
 *  "imdb"/"letterboxd") because intent differs per file: a Letterboxd
 *  watchlist row means something different from a diary row. */
export type ImportSource =
  | "imdb-ratings"
  | "imdb-watchlist"
  | "letterboxd-diary"
  | "letterboxd-ratings"
  | "letterboxd-watchlist"
  | "letterboxd-watched";

export const SOURCE_LABEL: Record<ImportSource, string> = {
  "imdb-ratings": "IMDb ratings",
  "imdb-watchlist": "IMDb watchlist",
  "letterboxd-diary": "Letterboxd diary",
  "letterboxd-ratings": "Letterboxd ratings",
  "letterboxd-watchlist": "Letterboxd watchlist",
  "letterboxd-watched": "Letterboxd watched",
};

/**
 * What the row asserts about the title.
 *
 * `rating-only` exists because an IMDb ratings export says you rated something
 * — which strongly implies you watched it — while an IMDb *watchlist* export
 * says the opposite. Collapsing the two into a boolean would lose that, and
 * the commit step needs the distinction to pick a `TrackingStatus`.
 */
export type ImportIntent = "watchlist" | "watched" | "rating-only";

/** What the source claims the title IS. A hint, never trusted — it feeds the
 *  scorer (§2.2 of the design doc) rather than short-circuiting a lookup. */
export type MediaTypeHint = MediaType | "episode" | "unknown";

/**
 * One row of one CSV, normalized. The only shape the rest of the pipeline
 * sees.
 */
export interface ImportRow {
  source: ImportSource;
  /**
   * Stable across re-parses of the same file, and unique within it.
   *
   * **Includes the watch date and the line number**, deliberately: a
   * Letterboxd diary holds several legitimately different rows for one film
   * (rewatches), and two rows can even share a date. Keying on the film alone
   * would collapse real history — the same reasoning `preAccountEventId` gives
   * for using an array index rather than hashing an event's content.
   */
  sourceRowId: string;
  /** `tt0068646`. Present for IMDb exports, NEVER for Letterboxd — see §0.1
   *  of the design doc. */
  imdbId: string | null;
  title: string;
  /** IMDb watchlist exports carry this; it is a second string to try when the
   *  primary title doesn't match (foreign films are the common case). */
  originalTitle: string | null;
  year: number | null;
  /** The Letterboxd URI's film slug (`the-godfather`). A matching signal and a
   *  dedup key — never fetched. Scraping letterboxd.com was considered and
   *  rejected (design doc §0.1). */
  slug: string | null;
  mediaTypeHint: MediaTypeHint;
  /** Normalized to OUR 0–100 scale at parse time, so no downstream code has to
   *  know a source's native scale. See `normalizeImdbRating` /
   *  `normalizeLetterboxdRating`. */
  score: number | null;
  /** `YYYY-MM-DD`. When the user RATED it — not when they watched it. */
  ratedOn: string | null;
  /**
   * `YYYY-MM-DD`, a LOCAL calendar date, used verbatim as a watch-log day key.
   *
   * Never parse this into a `Date` and re-derive the day. It arrives as a
   * calendar date with no timezone attached, which is exactly what the watch
   * log stores — converting it through a `Date` reintroduces the timezone bug
   * `lib/watchlog/types.ts` exists to prevent. It needs validation, not
   * conversion.
   */
  watchedOn: string | null;
  isRewatch: boolean;
  intent: ImportIntent;
  /** 1-based line in the original file, counting the header row. Shown in the
   *  review queue so the user checks against ground truth rather than against
   *  our interpretation of it. */
  sourceLine: number;
}

/**
 * Rows per request to `/api/import/resolve`.
 *
 * Small enough that one request's server-side work is bounded (25 rows at a
 * concurrency of 4 is a handful of upstream calls), large enough that the
 * per-IP limit of 30 requests/minute clears ~750 rows a minute. Raising it
 * would not speed a large import up much — the upstream concurrency cap is
 * the real throughput limit — but it would let one request occupy the server
 * for much longer.
 */
export const IMPORT_BATCH_LIMIT = 25;

const SOURCES = new Set<string>(Object.keys(SOURCE_LABEL));
const INTENTS = new Set<string>(["watchlist", "watched", "rating-only"]);
const HINTS = new Set<string>(["movie", "tv", "episode", "unknown"]);

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

/**
 * Validates an `ImportRow` arriving from the network.
 *
 * `/api/import/resolve` is a public endpoint, and every field here feeds
 * either an upstream query string or the scorer — so this checks the shape
 * rather than trusting the client that is supposed to have produced it. The
 * client and the server are the same codebase today; that is a fact about
 * this deployment, not a security boundary.
 *
 * Deliberately does NOT reject unknown extra keys: a future field added by a
 * newer client must not 400 against an older server mid-rollout, and an
 * unrecognized key is inert here because nothing reads it.
 */
export function isImportRow(value: unknown): value is ImportRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;

  if (typeof row.source !== "string" || !SOURCES.has(row.source)) return false;
  if (typeof row.sourceRowId !== "string" || row.sourceRowId.length === 0) return false;
  if (typeof row.title !== "string") return false;
  if (!isNullableString(row.imdbId)) return false;
  if (!isNullableString(row.originalTitle)) return false;
  if (!isNullableString(row.slug)) return false;
  if (!isNullableString(row.ratedOn)) return false;
  if (!isNullableString(row.watchedOn)) return false;
  if (typeof row.mediaTypeHint !== "string" || !HINTS.has(row.mediaTypeHint)) return false;
  if (typeof row.intent !== "string" || !INTENTS.has(row.intent)) return false;
  if (typeof row.isRewatch !== "boolean") return false;

  if (row.year !== null && !(typeof row.year === "number" && Number.isInteger(row.year))) {
    return false;
  }
  if (row.score !== null && !(typeof row.score === "number" && Number.isFinite(row.score))) {
    return false;
  }
  if (!Number.isInteger(row.sourceLine)) return false;

  // Bounded so a hostile caller cannot make us build a megabyte-long upstream
  // query string out of one field.
  if (row.title.length > 500) return false;
  if (typeof row.originalTitle === "string" && row.originalTitle.length > 500) return false;

  return true;
}

/* ---------------------------------------------------------------------------
 * Matching
 * ------------------------------------------------------------------------ */

/**
 * Where a resolved row ends up. Exactly one bucket per row.
 *
 * The rule this encodes, which must not erode (design doc §2.3):
 *
 *   Only `exact` and `confident` auto-import. Everything else is a human
 *   decision.
 */
export type MatchBucket =
  /** External id resolved to exactly one result. Unambiguous. */
  | "exact"
  /** Normalized title AND year both equal, media type consistent, and no
   *  second candidate equal on both. */
  | "confident"
  /** At least one candidate, but short of `confident`. */
  | "ambiguous"
  /** Zero candidates. Review, with manual search. */
  | "unmatched"
  /** Recognized but out of scope for this step (IMDb TV episodes, shorts,
   *  video games). Surfaced in the preview so the user knows the rows exist
   *  and were not silently dropped. */
  | "unsupported";

/** Buckets that commit without asking. Deliberately a two-element list rather
 *  than a numeric threshold — a threshold is a dial, and a dial gets turned
 *  down the first time the review queue feels long. */
export const AUTO_BUCKETS: readonly MatchBucket[] = ["exact", "confident"];

export function isAutoBucket(bucket: MatchBucket): boolean {
  return AUTO_BUCKETS.includes(bucket);
}

export interface MatchCandidate {
  summary: TitleSummary;
  /** Deterministic, from `scoreCandidate`. Ordering only — never compared
   *  against a magic threshold to decide auto-import. */
  score: number;
  /**
   * Plain-language justification, e.g. "title matches exactly, year differs
   * by 3". Generated from the same signals that produced `score`, which is
   * the practical payoff of a transparent scorer over an opaque similarity
   * number: every candidate the review queue offers can explain itself.
   */
  reason: string;
}

export interface ResolvedRow {
  row: ImportRow;
  bucket: MatchBucket;
  /** Best-first. Empty for `unmatched` and `unsupported`. */
  candidates: MatchCandidate[];
  /**
   * The title this row will import as. Set automatically for `exact` and
   * `confident`; set by the user in the review queue otherwise; stays null
   * for anything unresolved.
   */
  chosen: TitleSummary | null;
  /** The user explicitly declined to import this row. Distinct from
   *  `chosen === null`, which means "not decided yet" — the commit step must
   *  never treat undecided as skipped, or closing the tab mid-review would
   *  silently discard rows. */
  skipped: boolean;
}

export function isDecided(resolved: ResolvedRow): boolean {
  return resolved.skipped || resolved.chosen !== null;
}

/* ---------------------------------------------------------------------------
 * Rating scale normalization
 *
 * Both sources land on the same 10-point grid on our 0–100 scale, which is a
 * genuine convenience rather than a coincidence worth engineering around: a
 * 4-star Letterboxd rating and an 8/10 IMDb rating both become exactly 80, so
 * someone importing from both does not end up with two subtly different
 * scales in one library.
 * ------------------------------------------------------------------------ */

/** IMDb: integer 1–10. Returns null for blank or out-of-range rather than
 *  clamping — a value we don't understand is not a rating we should invent. */
export function normalizeImdbRating(raw: string | null): number | null {
  if (!raw) return null;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < 1 || value > 10) return null;
  return Math.round(value * 10);
}

/** Letterboxd: 0.5–5.0 in half-star steps. */
export function normalizeLetterboxdRating(raw: string | null): number | null {
  if (!raw) return null;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < 0.5 || value > 5) return null;
  return Math.round(value * 20);
}

/** A 4-digit year, or null. Rejects anything outside a sane film-history
 *  range so a stray column never becomes a matching signal. */
export function parseYear(raw: string | null): number | null {
  if (!raw) return null;
  const match = /(\d{4})/.exec(raw.trim());
  if (!match) return null;
  const year = Number(match[1]);
  return year >= 1870 && year <= 2200 ? year : null;
}
