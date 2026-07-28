import "server-only";

import { derivePlaceholderArt } from "../shared/placeholder";
import type {
  CastMember,
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

interface TmdbCastEntry {
  id?: number;
  name?: string | null;
  character?: string | null;
  order?: number;
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
  credits?: { cast?: TmdbCastEntry[] };
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

/** Sized rather than `original` — original posters can be several MB, which
 *  would wreck the Home grid on mobile data. */
const SIZES = {
  poster: "w500",
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
    posterUrl: imageUrl(raw.poster_path, "poster"),
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
  };
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
    posterUrl: imageUrl(raw.poster_path, "poster"),
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
