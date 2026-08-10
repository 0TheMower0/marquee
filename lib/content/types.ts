/**
 * Normalized domain types for the content layer.
 *
 * These are OUR shapes — never TMDB's raw response shapes. Every provider
 * (mock, tmdb, and whatever comes later) must produce exactly these types.
 * Nothing outside lib/content/ should ever see a TMDB field name.
 */

export type MediaType = "movie" | "tv";

export interface Genre {
  /** Stable slug, e.g. "drama". Mock and TMDB providers each own their own
   *  id -> name mapping; ids are not shared between providers. */
  id: string;
  name: string;
}

/**
 * Deterministic two-stop gradient used as poster/backdrop art when no real
 * image exists (always, in mock mode; as a fallback, in tmdb mode). Derived
 * from a hash of the title id so the same title renders the same gradient on
 * every load instead of flickering between colors on re-render.
 */
export interface PlaceholderArt {
  gradientFrom: string;
  gradientTo: string;
}

export interface CastMember {
  id: string;
  name: string;
  character: string;
  /** Billing order, ascending. Used to slice out "main cast" from the rest. */
  order: number;
  profileUrl: string | null;
}

/**
 * "creator" is TV-only (TMDB's `created_by`, a stable show-level credit).
 * "director"/"writer" are movie-only — TMDB's per-title `credits.crew` is
 * reliable for a film, but a TV show's aggregate crew reflects whichever
 * episode was fetched last, not the show as a whole, so this deliberately
 * does not attempt director/writer credits for TV. See the note in
 * tmdb/normalize.ts's `toCrew`.
 */
export type CrewRole = "creator" | "director" | "writer";

export interface CrewMember {
  id: string;
  name: string;
  role: CrewRole;
  profileUrl: string | null;
}

/**
 * A rating from somewhere other than the content provider's own community
 * score. `"tmdb"` is included in the union because the ratings row renders all
 * sources uniformly — but note `getExternalRatings()` never RETURNS a tmdb
 * entry: TMDB's score already lives on `Title.rating` and having two sources
 * of truth for one number is how they drift apart. The UI composes them.
 */
export type RatingSource = "tmdb" | "imdb" | "rotten_tomatoes" | "metacritic";

/**
 * Each source's native scale, kept rather than normalized to a common one.
 * "8.4/10", "85%" and "72/100" are how people actually recognise these
 * scores — flattening them all to a percentage would make the row less
 * informative, not more.
 */
export type RatingScale = "ten" | "percent" | "hundred";

export interface ExternalRating {
  source: RatingSource;
  /** In the source's own scale: 8.4 for IMDb, 85 for RT, 72 for Metacritic. */
  value: number;
  scale: RatingScale;
  /** Vote count where the source reports one. IMDb only, in practice. */
  votes: number | null;
}

export type WatchProviderType = "stream" | "rent" | "buy";

export interface WatchProvider {
  id: string;
  name: string;
  logoUrl: string | null;
  type: WatchProviderType;
}

export type TitleStatus =
  | "released"
  | "upcoming"
  | "returning"
  | "ended"
  | "canceled";

/**
 * The shape returned by list-producing endpoints: search, trending, similar,
 * recommendations. Deliberately lighter than `Title` — see the note on
 * `Title` below for why cast is excluded here.
 */
export interface TitleSummary {
  id: string;
  mediaType: MediaType;
  name: string;
  /** Release year (movies) or first-air year (TV). Null if unknown. */
  year: number | null;
  overview: string;
  genres: Genre[];
  posterUrl: string | null;
  placeholder: PlaceholderArt;
  /** 0–10, one decimal of real precision. Null if unrated. */
  rating: number | null;
}

/**
 * The shape returned by `getTitle` — full detail view.
 *
 * `cast` is only ever present here, not on `TitleSummary`. TMDB's list
 * endpoints (search/trending/similar/recommendations) do not include credits;
 * only requesting a single title's detail does. If `Title` were used for list
 * results too, the mock provider could cheaply fabricate full cast for every
 * card while the TMDB provider legitimately could not — the two
 * implementations would then diverge in what the *same interface* promises
 * to return, which defeats the point of the abstraction. Splitting the type
 * keeps both providers honest about what's available at each grain.
 */
export interface Title extends TitleSummary {
  originalName: string | null;
  backdropUrl: string | null;
  status: TitleStatus | null;
  /** Movies only. Null for TV. */
  runtimeMinutes: number | null;
  /** TV only. Null for movies. */
  seasonCount: number | null;
  /** TV only. Null for movies. */
  episodeCount: number | null;
  cast: CastMember[];
  /** Creator (TV) or director/writers (movie) — see the note on `CrewRole`. */
  crew: CrewMember[];
  /**
   * The most recently AIRED episode, and the next one scheduled. TV only;
   * both null for movies, and either may be null for TV (a show that has
   * never aired has no last; an ended show has no next).
   *
   * ============================================================================
   * WHY THESE ARE ON `Title` AND NOT DERIVED FROM `getSeasons`
   * ============================================================================
   * They ARE derivable — fetch every season, fetch the last season's episodes,
   * scan for the air-date boundary. That is two-plus round trips per show, and
   * Phase 7 Step 5's notification detector runs it across every show anyone
   * follows on a schedule. TMDB returns both objects inline on the show detail
   * response `getTitle` already fetches, so putting them here makes that
   * detection **one call per show** instead of three.
   *
   * `runtimeMinutes` on these is often null even when the season's own episode
   * list has it — TMDB's inline summary is thinner than the full episode
   * record. Do not treat a null here as "this episode has no runtime".
   */
  lastEpisodeToAir: Episode | null;
  nextEpisodeToAir: Episode | null;
}

export interface Season {
  seasonNumber: number;
  name: string;
  overview: string;
  episodeCount: number;
  /** ISO 8601 date string, e.g. "2008-01-20". Null if unannounced. */
  airDate: string | null;
  posterUrl: string | null;
}

export interface Episode {
  id: string;
  seasonNumber: number;
  episodeNumber: number;
  name: string;
  overview: string;
  airDate: string | null;
  runtimeMinutes: number | null;
  stillUrl: string | null;
}

export interface PagedResult<T> {
  items: T[];
  page: number;
  totalPages: number;
  totalResults: number;
}
