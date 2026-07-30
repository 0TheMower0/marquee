/**
 * Whether an ISO "YYYY-MM-DD" air date is strictly after today.
 *
 * A `null` airDate is treated as NOT unaired (i.e. markable) — most of the
 * mock catalog's synthesized episodes (see the SEASON_SHAPES tier in
 * lib/content/mock/index.ts) carry no per-episode date at all, only a real
 * season-level premiere date. Treating "unknown" the same as "hasn't aired"
 * would make most TV shows in the catalog entirely unmarkable.
 *
 * Comparison is a plain string comparison against today's date in the same
 * "YYYY-MM-DD" form — deliberately not `Date` arithmetic, which would need to
 * reason about timezones for a value that is a calendar date, not an instant.
 * An episode airing "today" counts as already aired.
 */
export function isFutureAirDate(airDate: string | null): boolean {
  if (!airDate) return false;
  const today = new Date().toISOString().slice(0, 10);
  return airDate.slice(0, 10) > today;
}

/**
 * "Jan 15, 2026" for display. `timeZone: "UTC"` matters here for the same
 * reason as above — airDate is a calendar date. Formatting it in the
 * viewer's local zone could roll a date-only string to the adjacent day near
 * midnight, showing the wrong date for no reason.
 */
export function formatAirDate(airDate: string | null): string | null {
  if (!airDate) return null;
  const parsed = new Date(airDate);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
