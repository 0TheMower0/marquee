/**
 * The only error shape a ContentProvider is allowed to throw. Both mockProvider
 * and tmdbProvider must map every failure onto one of these `kind`s — network
 * timeouts, malformed responses, TMDB 401s, whatever — so error UI (Step 6)
 * can be written once, switch on `kind`, and work identically against either
 * provider.
 */
export type ContentErrorKind =
  | "not_found"
  | "unauthorized"
  | "rate_limited"
  | "network"
  | "unknown";

export class ContentError extends Error {
  readonly kind: ContentErrorKind;

  constructor(kind: ContentErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ContentError";
    this.kind = kind;
  }
}
