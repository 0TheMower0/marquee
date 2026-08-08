import "server-only";

import type { MediaType } from "@/lib/content/types";

/**
 * Input validation for `app/api/content/*`.
 *
 * Every value these functions touch arrives from the browser as a string and
 * is therefore untrusted — including path segments, which look structural but
 * are just as attacker-controlled as query params. Route handlers must parse
 * through here rather than casting.
 *
 * Failures throw `BadRequestError`, which `handleRouteError` maps to 400. It
 * is deliberately NOT a `ContentError`: a malformed request is our caller's
 * bug, not a content-source failure, and collapsing the two would make
 * `ContentErrorKind` mean two different things.
 */
export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}

/** TMDB ids are numeric, mock ids are slugs. Allowlist covers both and
 *  nothing else — no dots, no slashes, no percent-encoding games. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** TMDB caps pagination at 500; anything beyond is a guaranteed dead request. */
const MAX_PAGE = 500;

/** Long enough for any real title, short enough to not be an attack vector. */
const MAX_QUERY_LENGTH = 200;

export function parseMediaType(value: string | null): MediaType {
  if (value === "movie" || value === "tv") return value;
  throw new BadRequestError(`mediaType must be "movie" or "tv"`);
}

export function parseMediaTypeOrAll(
  value: string | null,
): MediaType | "all" {
  // Absent means "all" — that is the Home grid's default, not an error.
  if (value === null || value === "") return "all";
  if (value === "all" || value === "movie" || value === "tv") return value;
  throw new BadRequestError(`mediaType must be "all", "movie" or "tv"`);
}

export function parsePage(value: string | null): number {
  if (value === null || value === "") return 1;

  // Number() would accept "1e3", " 12 ", "0x10" and Infinity. An explicit
  // integer pattern is the only way to reject those cleanly. The digit bound
  // is wider than MAX_PAGE on purpose, so an in-range-shaped but too-large
  // page gets the accurate "out of range" message rather than "not an integer".
  if (!/^\d{1,9}$/.test(value)) {
    throw new BadRequestError("page must be a positive integer");
  }
  const page = Number(value);
  if (page < 1 || page > MAX_PAGE) {
    throw new BadRequestError(`page must be between 1 and ${MAX_PAGE}`);
  }
  return page;
}

/**
 * A blank query is NOT a validation error — it returns an empty page, because
 * that is what `mockProvider` and `tmdbProvider` both do. Rejecting it here
 * would make the HTTP transport behave differently from the other two
 * implementations of the same interface, which is exactly what this layer
 * exists to prevent.
 */
export function parseQuery(value: string | null): string {
  const trimmed = (value ?? "").trim();
  if (trimmed.length > MAX_QUERY_LENGTH) {
    throw new BadRequestError(
      `query must be ${MAX_QUERY_LENGTH} characters or fewer`,
    );
  }
  return trimmed;
}

export function parseId(value: string): string {
  if (!ID_PATTERN.test(value)) {
    throw new BadRequestError("id contains unsupported characters");
  }
  return value;
}

/**
 * An IMDb id (`tt0068646`).
 *
 * Validated here rather than passed through as an opaque id, because this one
 * goes into an upstream URL path against a specific external service. Rejecting
 * a malformed value as a 400 keeps a junk value in a CSV from becoming a
 * pointless TMDB round trip whose empty result would then be indistinguishable
 * from a genuine "no such film".
 */
export function parseImdbId(value: string): string {
  if (!/^tt\d{7,10}$/i.test(value)) {
    throw new BadRequestError("imdbId must look like tt0000000");
  }
  return value.toLowerCase();
}

export function parseSeasonNumber(value: string): number {
  // Season 0 is valid — TMDB uses it for "Specials".
  if (!/^\d{1,4}$/.test(value)) {
    throw new BadRequestError("seasonNumber must be a non-negative integer");
  }
  return Number(value);
}

export function parseRegion(value: string | null): string | undefined {
  if (value === null || value === "") return undefined;
  if (!/^[A-Za-z]{2}$/.test(value)) {
    throw new BadRequestError("region must be a 2-letter country code");
  }
  return value.toUpperCase();
}
