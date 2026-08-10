import "server-only";

import { derivePlaceholderArt } from "../shared/placeholder";
import type {
  CastMember,
  CrewMember,
  Episode,
  Genre,
  MediaType,
  Season,
  Title,
  TitleStatus,
  TitleSummary,
  WatchProvider,
} from "../types";

/* ---------------------------------------------------------------------------
 * Raw TMDB response shapes.
 *
 * Every field is optional and/or nullable — not out of paranoia, but because
 * TMDB genuinely omits or nulls most of them depending on endpoint and how
 * complete a given title's record is. Typing them honestly forces the
 * conversion functions below to handle the gaps instead of trusting them.
 * ------------------------------------------------------------------------ */

interface TmdbGenre {
  id?: number;
  name?: string | null;
}

export interface TmdbListItem {
  id?: number;
  media_type?: string;
  title?: string | null; // movies
  name?: string | null; // tv
  original_title?: string | null;
  original_name?: string | null;
  overview?: string | null;
  genre_ids?: number[];
  genres?: TmdbGenre[];
  poster_path?: string | null;
  backdrop_path?: string | null;
  release_date?: string | null;
  first_air_date?: string | null;
  vote_average?: number | null;
  vote_count?: number | null;
}

export interface TmdbPagedResponse {
  page?: number;
  results?: TmdbListItem[];
  total_pages?: number;
  total_results?: number;
}

/**
 * `/find/{external_id}` — deliberately NOT a paged response.
 *
 * It answers with several parallel arrays rather than one result list, which
 * is exactly why `findByExternalId` can distinguish an unambiguous match from
 * an ambiguous one. `tv_episode_results` and `tv_season_results` are typed
 * here even though the provider currently ignores them, so it is visible that
 * they exist and are being skipped on purpose rather than overlooked.
 */
export interface TmdbFindResponse {
  movie_results?: TmdbListItem[];
  tv_results?: TmdbListItem[];
  tv_episode_results?: TmdbListItem[];
  tv_season_results?: TmdbListItem[];
  person_results?: TmdbListItem[];
}

interface TmdbCastEntry {
  id?: number;
  name?: string | null;
  character?: string | null;
  order?: number;
  profile_path?: string | null;
}

interface TmdbCrewEntry {
  id?: number;
  name?: string | null;
  department?: string | null;
  job?: string | null;
  profile_path?: string | null;
}

/** TV-only. A stable, show-level credit — unlike `credits.crew`, which
 *  reflects whichever episode TMDB last indexed. See `toCrew`. */
interface TmdbCreatedBy {
  id?: number;
  name?: string | null;
  profile_path?: string | null;
}

export interface TmdbSeasonSummary {
  season_number?: number;
  name?: string | null;
  overview?: string | null;
  episode_count?: number;
  air_date?: string | null;
  poster_path?: string | null;
}

export interface TmdbTitleDetail extends TmdbListItem {
  runtime?: number | null; // movies
  episode_run_time?: number[]; // tv
  number_of_seasons?: number | null;
  number_of_episodes?: number | null;
  status?: string | null;
  seasons?: TmdbSeasonSummary[];
  credits?: { cast?: TmdbCastEntry[]; crew?: TmdbCrewEntry[] };
  created_by?: TmdbCreatedBy[]; // tv only
  /** MOVIES ONLY. TMDB puts `imdb_id` at the top level of a movie detail
   *  response but NOT a TV one — see `extractImdbId`. */
  imdb_id?: string | null;
  /** Present only with `append_to_response=external_ids`. The only way to get
   *  a TV show's IMDb id. */
  external_ids?: { imdb_id?: string | null };
  /** TV only, returned inline on the show detail response. Either may be null:
   *  a show that has never aired has no last, an ended one has no next. */
  last_episode_to_air?: TmdbEpisode | null;
  next_episode_to_air?: TmdbEpisode | null;
}

interface TmdbEpisode {
  id?: number;
  season_number?: number;
  episode_number?: number;
  name?: string | null;
  overview?: string | null;
  air_date?: string | null;
  runtime?: number | null;
  still_path?: string | null;
}

export interface TmdbSeasonDetail {
  episodes?: TmdbEpisode[];
}

interface TmdbWatchProviderEntry {
  provider_id?: number;
  provider_name?: string | null;
  logo_path?: string | null;
  display_priority?: number;
}

export interface TmdbWatchProviderResponse {
  results?: Record<
    string,
    {
      flatrate?: TmdbWatchProviderEntry[];
      rent?: TmdbWatchProviderEntry[];
      buy?: TmdbWatchProviderEntry[];
    }
  >;
}

/* ---------------------------------------------------------------------------
 * Images
 * ------------------------------------------------------------------------ */

const IMAGE_BASE = "https://image.tmdb.org/t/p";

/**
 * Sized rather than `original` — original posters can be several MB, which
 * would wreck the Home grid on mobile data.
 *
 * Poster is split in two because "a poster" means very different pixel
 * budgets in different places: `posterCard` backs every list/grid context
 * (TicketCard, search results, similar/recommendations, the Up Next card,
 * and the TrackingEntry snapshots that echo a TitleSummary into My
 * Library) where cards render well under 320px wide even on desktop —
 * see POSTER_GRID_SIZES in lib/utils/grid.ts. `posterDetail` backs only
 * the title detail hero's single, larger poster (toTitle overrides
 * `posterUrl` again with it — see the comment there). Shipping the bigger
 * size into every grid card would be exactly the "w500 into a 100px rail
 * slot" waste this split exists to avoid.
 */
const SIZES = {
  posterCard: "w342",
  posterDetail: "w500",
  backdrop: "w1280",
  profile: "w185",
  still: "w300",
  logo: "w92",
} as const;

function imageUrl(
  path: string | null | undefined,
  size: keyof typeof SIZES,
): string | null {
  if (!path) return null;
  return `${IMAGE_BASE}/${SIZES[size]}${path}`;
}

/* ---------------------------------------------------------------------------
 * Genres
 * ------------------------------------------------------------------------ */

/**
 * TMDB's list endpoints return bare `genre_ids` with no names, so a lookup
 * table is unavoidable. Hardcoded rather than fetched from /genre/{type}/list
 * because that would add a second network round-trip (and a second failure
 * mode) to every single list request, to resolve a mapping that has been
 * stable for years.
 *
 * Movie and TV sets are merged: the eight ids they share (16 Animation,
 * 35 Comedy, 80 Crime, 99 Documentary, 18 Drama, 10751 Family, 9648 Mystery,
 * 37 Western) carry identical names in both, so there is nothing to collide.
 *
 * An unrecognised id is dropped rather than rendered as "Genre 1234" — a
 * missing chip is better than a broken-looking one.
 */
const TMDB_GENRES: Record<number, string> = {
  // Movie
  28: "Action",
  12: "Adventure",
  14: "Fantasy",
  36: "History",
  27: "Horror",
  878: "Science Fiction",
  53: "Thriller",
  10402: "Music",
  10749: "Romance",
  10752: "War",
  10770: "TV Movie",
  // TV
  10759: "Action & Adventure",
  10762: "Kids",
  10763: "News",
  10764: "Reality",
  10765: "Sci-Fi & Fantasy",
  10766: "Soap",
  10767: "Talk",
  10768: "War & Politics",
  // Shared between both
  16: "Animation",
  18: "Drama",
  35: "Comedy",
  37: "Western",
  80: "Crime",
  99: "Documentary",
  9648: "Mystery",
  10751: "Family",
};

/** Our `Genre.id` is a slug, not a provider-specific number — see the note in
 *  ../types.ts. "Sci-Fi & Fantasy" -> "sci-fi-and-fantasy". */
function slugifyGenre(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toGenre(id: number | undefined, name: string | null | undefined): Genre | null {
  const resolvedName = name?.trim() || (id !== undefined ? TMDB_GENRES[id] : undefined);
  if (!resolvedName) return null;
  return { id: slugifyGenre(resolvedName), name: resolvedName };
}

function extractGenres(raw: TmdbListItem): Genre[] {
  // Detail endpoints give `genres: [{id, name}]`; list endpoints give
  // `genre_ids: [number]`. Prefer the named form when present.
  if (raw.genres?.length) {
    return raw.genres
      .map((g) => toGenre(g.id, g.name))
      .filter((g): g is Genre => g !== null);
  }
  return (raw.genre_ids ?? [])
    .map((id) => toGenre(id, undefined))
    .filter((g): g is Genre => g !== null);
}

/* ---------------------------------------------------------------------------
 * Scalars
 * ------------------------------------------------------------------------ */

/** TMDB dates are "YYYY-MM-DD", but unreleased titles frequently carry `""`
 *  or omit the field entirely. */
function parseYear(date: string | null | undefined): number | null {
  if (!date) return null;
  const year = Number.parseInt(date.slice(0, 4), 10);
  if (!Number.isFinite(year) || year < 1870 || year > 2200) return null;
  return year;
}

/** Empty strings are normalised to null so callers can rely on a single
 *  "absent" representation instead of checking both. */
function nullableString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * TMDB reports `vote_average: 0` for titles nobody has rated, which is not the
 * same as a genuine score of zero. Treated as "unrated" when the vote count
 * confirms it.
 */
function parseRating(
  voteAverage: number | null | undefined,
  voteCount: number | null | undefined,
): number | null {
  if (typeof voteAverage !== "number" || !Number.isFinite(voteAverage)) return null;
  if (typeof voteCount === "number" && voteCount <= 0) return null;
  if (voteAverage <= 0) return null;
  return Math.round(voteAverage * 10) / 10;
}

/** Guards against TMDB's `0` / `null` placeholders for unknown durations. */
function positiveIntOrNull(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(value);
}

const STATUS_MAP: Record<string, TitleStatus> = {
  released: "released",
  "returning series": "returning",
  ended: "ended",
  canceled: "canceled",
  cancelled: "canceled",
  planned: "upcoming",
  "in production": "upcoming",
  "post production": "upcoming",
  rumored: "upcoming",
  pilot: "upcoming",
};

function parseStatus(status: string | null | undefined): TitleStatus | null {
  if (!status) return null;
  return STATUS_MAP[status.trim().toLowerCase()] ?? null;
}

/* ---------------------------------------------------------------------------
 * Titles
 * ------------------------------------------------------------------------ */

/**
 * `/search/multi` and `/trending/all` mix in `person` results, which have no
 * meaning in a title tracker. Returns null for anything that isn't a movie or
 * a show so callers can filter it out.
 */
function resolveMediaType(
  raw: TmdbListItem,
  fallback?: MediaType,
): MediaType | null {
  if (raw.media_type === "movie" || raw.media_type === "tv") return raw.media_type;
  if (raw.media_type) return null; // person, collection, company, ...
  return fallback ?? null;
}

/**
 * Returns null when the item is unusable — a person result, or a record with
 * no id or no displayable name. Skipping is right here: a card with a blank
 * title is worse than one fewer card.
 */
export function toTitleSummary(
  raw: TmdbListItem,
  fallbackMediaType?: MediaType,
): TitleSummary | null {
  const mediaType = resolveMediaType(raw, fallbackMediaType);
  if (!mediaType || raw.id === undefined || raw.id === null) return null;

  const name = nullableString(mediaType === "movie" ? raw.title : raw.name);
  if (!name) return null;

  const id = String(raw.id);
  // Namespaced so movie 238 and show 238 don't land on the same gradient.
  const placeholder = derivePlaceholderArt(`${mediaType}-${id}`);

  return {
    id,
    mediaType,
    name,
    year: parseYear(mediaType === "movie" ? raw.release_date : raw.first_air_date),
    overview: nullableString(raw.overview) ?? "",
    genres: extractGenres(raw),
    posterUrl: imageUrl(raw.poster_path, "posterCard"),
    placeholder,
    rating: parseRating(raw.vote_average, raw.vote_count),
  };
}

export function toTitleSummaries(
  raw: TmdbListItem[] | undefined,
  fallbackMediaType?: MediaType,
): TitleSummary[] {
  return (raw ?? [])
    .map((item) => toTitleSummary(item, fallbackMediaType))
    .filter((item): item is TitleSummary => item !== null);
}

function toCastMember(raw: TmdbCastEntry, index: number): CastMember | null {
  const name = nullableString(raw.name);
  if (raw.id === undefined || !name) return null;
  return {
    id: String(raw.id),
    name,
    character: nullableString(raw.character) ?? "",
    // `order` is usually present but not guaranteed; fall back to array
    // position so billing order is never NaN.
    order: typeof raw.order === "number" ? raw.order : index,
    profileUrl: imageUrl(raw.profile_path, "profile"),
  };
}

const WRITING_CREW_CAP = 5;

/**
 * Key crew, deliberately scoped narrower than "everyone who worked on this":
 *
 * - TV: only `created_by`. That is the one show-level credit TMDB keeps
 *   stable; `credits.crew` on a TV show detail reflects whichever episode
 *   TMDB most recently indexed, not the series as a whole, so a "director" or
 *   "writer" pulled from it would attribute a random episode's crew to the
 *   entire show. Not attempted rather than shown wrong.
 * - Movie: `credits.crew` filtered to department "Directing" + job "Director"
 *   (excludes "Assistant Director" etc., which share the department), and
 *   department "Writing" (covers TMDB's job variants — "Writer",
 *   "Screenplay", "Story", "Teleplay" — without hardcoding each one).
 *   De-duplicated by id, since one person can hold multiple writing jobs on
 *   the same film, and capped so an extensively-adapted screenplay's credit
 *   list doesn't run unbounded.
 */
function toCrew(raw: TmdbTitleDetail, mediaType: MediaType): CrewMember[] {
  if (mediaType === "tv") {
    return (raw.created_by ?? [])
      .map((person): CrewMember | null => {
        const name = nullableString(person.name);
        if (person.id === undefined || !name) return null;
        return {
          id: String(person.id),
          name,
          role: "creator",
          profileUrl: imageUrl(person.profile_path, "profile"),
        };
      })
      .filter((member): member is CrewMember => member !== null);
  }

  const crew = raw.credits?.crew ?? [];
  // Dedup is scoped to ONE role's own list, not shared across director/writer
  // — someone who is both (Matt Reeves on The Batman: director AND one of
  // four credited writers) must appear in both lists. An earlier version of
  // this function shared one Set across both filters, which silently dropped
  // Reeves from Writers because he'd already been marked "seen" as Director.
  // Caught live against real TMDB data, not by any test — mock mode's crew is
  // hand-authored and never exercises this function at all.
  function toMembers(
    people: TmdbCrewEntry[],
    role: "director" | "writer",
  ): CrewMember[] {
    const seen = new Set<string>();
    const members: CrewMember[] = [];
    for (const person of people) {
      const name = nullableString(person.name);
      if (person.id === undefined || !name) continue;
      const id = String(person.id);
      if (seen.has(id)) continue; // e.g. one person credited "Screenplay" AND "Story"
      seen.add(id);
      members.push({ id, name, role, profileUrl: imageUrl(person.profile_path, "profile") });
    }
    return members;
  }

  const directors = toMembers(
    crew.filter((person) => person.department === "Directing" && person.job === "Director"),
    "director",
  );
  const writers = toMembers(
    crew.filter((person) => person.department === "Writing"),
    "writer",
  ).slice(0, WRITING_CREW_CAP);

  return [...directors, ...writers];
}

/**
 * The IMDb id, which is what OMDb is keyed by (`lib/content/omdb/`).
 *
 * Movies and TV differ here and it is easy to miss, because a movie appears to
 * work with no extra request: TMDB returns `imdb_id` at the TOP LEVEL of a
 * movie detail response, but a TV detail response has no such field at all —
 * a show's IMDb id only exists under `external_ids`, which requires
 * `append_to_response=external_ids`. Verified against the live API:
 *
 *   /movie/414906                          -> imdb_id: "tt1877830"
 *   /tv/87108                              -> imdb_id: undefined
 *   /tv/87108?append_to_response=external_ids -> external_ids.imdb_id: "tt7366338"
 *
 * `external_ids` is checked first so the two media types resolve through one
 * code path. Returns null when absent — plenty of obscure titles genuinely
 * have no IMDb entry, and the caller degrades to TMDB's own score.
 */
export function extractImdbId(raw: TmdbTitleDetail): string | null {
  const fromExternal = nullableString(raw.external_ids?.imdb_id);
  if (fromExternal) return fromExternal;
  return nullableString(raw.imdb_id);
}

/**
 * Throws rather than returning null: this backs `getTitle`, where the caller
 * asked for one specific title and a silent null would surface as a blank
 * page. The ContentError is raised by the caller in ./index.ts.
 */
export function toTitle(raw: TmdbTitleDetail, mediaType: MediaType): Title | null {
  const summary = toTitleSummary(raw, mediaType);
  if (!summary) return null;

  // TV runtime lives in `episode_run_time`, an array that is often empty and
  // occasionally holds several values; the first is the typical length.
  const runtimeMinutes =
    mediaType === "movie"
      ? positiveIntOrNull(raw.runtime)
      : positiveIntOrNull(raw.episode_run_time?.[0]);

  return {
    ...summary,
    originalName: nullableString(
      mediaType === "movie" ? raw.original_title : raw.original_name,
    ),
    // Overrides the summary's posterCard-sized URL with a larger one — the
    // detail hero renders one poster at up to 176px CSS width across a range
    // of device pixel ratios, not a grid full of 100-230px cards. See the
    // note on SIZES above.
    posterUrl: imageUrl(raw.poster_path, "posterDetail"),
    backdropUrl: imageUrl(raw.backdrop_path, "backdrop"),
    status: parseStatus(raw.status),
    // Runtime is per-episode for TV, which is not what `runtimeMinutes` means
    // on a Title (it documents movie length). Kept null for TV so the field
    // stays honest; per-episode runtime is exposed on Episode instead.
    runtimeMinutes: mediaType === "movie" ? runtimeMinutes : null,
    seasonCount: mediaType === "tv" ? positiveIntOrNull(raw.number_of_seasons) : null,
    episodeCount: mediaType === "tv" ? positiveIntOrNull(raw.number_of_episodes) : null,
    cast: (raw.credits?.cast ?? [])
      .map(toCastMember)
      .filter((member): member is CastMember => member !== null)
      .sort((a, b) => a.order - b.order),
    crew: toCrew(raw, mediaType),
    lastEpisodeToAir:
      mediaType === "tv" ? toInlineEpisode(raw.last_episode_to_air, summary.id) : null,
    nextEpisodeToAir:
      mediaType === "tv" ? toInlineEpisode(raw.next_episode_to_air, summary.id) : null,
  };
}

/**
 * The `last_episode_to_air` / `next_episode_to_air` objects TMDB returns
 * inline on a show detail response.
 *
 * Routed through `toEpisodes` rather than mapped separately so a change to how
 * an episode is normalized cannot silently apply to a season's episode list
 * but not to these two — the same "one mapper, no second copy" reasoning the
 * import layer's duplicated-predicate bug taught (Phase 7 Step 3).
 */
function toInlineEpisode(
  raw: TmdbEpisode | null | undefined,
  showId: string,
): Episode | null {
  if (!raw) return null;
  return toEpisodes([raw], showId, raw.season_number ?? 0)[0] ?? null;
}

/* ---------------------------------------------------------------------------
 * Seasons and episodes
 * ------------------------------------------------------------------------ */

export function toSeason(raw: TmdbSeasonSummary): Season | null {
  if (typeof raw.season_number !== "number") return null;
  return {
    seasonNumber: raw.season_number,
    name: nullableString(raw.name) ?? `Season ${raw.season_number}`,
    overview: nullableString(raw.overview) ?? "",
    episodeCount: positiveIntOrNull(raw.episode_count) ?? 0,
    airDate: nullableString(raw.air_date),
    posterUrl: imageUrl(raw.poster_path, "posterCard"),
  };
}

export function toSeasons(raw: TmdbSeasonSummary[] | undefined): Season[] {
  return (raw ?? [])
    .map(toSeason)
    .filter((season): season is Season => season !== null)
    .sort((a, b) => a.seasonNumber - b.seasonNumber);
}

export function toEpisodes(
  raw: TmdbEpisode[] | undefined,
  showId: string,
  seasonNumber: number,
): Episode[] {
  return (raw ?? [])
    .map((episode): Episode | null => {
      if (typeof episode.episode_number !== "number") return null;
      const resolvedSeason =
        typeof episode.season_number === "number"
          ? episode.season_number
          : seasonNumber;
      return {
        id:
          episode.id !== undefined
            ? String(episode.id)
            : `${showId}-s${resolvedSeason}e${episode.episode_number}`,
        seasonNumber: resolvedSeason,
        episodeNumber: episode.episode_number,
        name: nullableString(episode.name) ?? `Episode ${episode.episode_number}`,
        overview: nullableString(episode.overview) ?? "",
        airDate: nullableString(episode.air_date),
        runtimeMinutes: positiveIntOrNull(episode.runtime),
        stillUrl: imageUrl(episode.still_path, "still"),
      };
    })
    .filter((episode): episode is Episode => episode !== null)
    .sort((a, b) => a.episodeNumber - b.episodeNumber);
}

/* ---------------------------------------------------------------------------
 * Watch providers
 * ------------------------------------------------------------------------ */

/**
 * A provider legitimately appears more than once when a title is both
 * streamable and rentable there — those are distinct offers, so they stay as
 * separate entries distinguished by `type` rather than being deduplicated.
 *
 * Reminder: TMDB sources this from JustWatch, and displaying it obliges us to
 * show a "Powered by JustWatch" credit. See CLAUDE.md.
 */
export function toWatchProviders(
  raw: TmdbWatchProviderResponse,
  region: string,
): WatchProvider[] {
  const forRegion = raw.results?.[region];
  if (!forRegion) return [];

  const groups = [
    { entries: forRegion.flatrate, type: "stream" as const },
    { entries: forRegion.rent, type: "rent" as const },
    { entries: forRegion.buy, type: "buy" as const },
  ];

  const providers: WatchProvider[] = [];
  for (const { entries, type } of groups) {
    for (const entry of entries ?? []) {
      const name = nullableString(entry.provider_name);
      if (entry.provider_id === undefined || !name) continue;
      providers.push({
        id: String(entry.provider_id),
        name,
        logoUrl: imageUrl(entry.logo_path, "logo"),
        type,
      });
    }
  }
  return providers;
}
