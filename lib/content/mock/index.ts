import { ContentError } from "../errors";
import type {
  ContentProvider,
  SearchTitlesOptions,
  TrendingOptions,
} from "../provider";
import { derivePlaceholderArt } from "../shared/placeholder";
import type {
  Episode,
  MediaType,
  PagedResult,
  Season,
  Title,
  TitleSummary,
} from "../types";
import { MOCK_CATALOG, type CatalogEntry } from "./catalog";
import { MOCK_EPISODES } from "./episodes";

const PAGE_SIZE = 20;
const MIN_LATENCY_MS = 180;
const MAX_LATENCY_MS = 420;

/** Deliberate artificial delay so loading skeletons are actually visible in
 *  dev instead of resolving instantly — a real API never would. */
function simulateLatency(): Promise<void> {
  const ms = MIN_LATENCY_MS + Math.random() * (MAX_LATENCY_MS - MIN_LATENCY_MS);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hydrate(entry: CatalogEntry): Title {
  return { ...entry, placeholder: derivePlaceholderArt(entry.id) };
}

/**
 * Explicit allowlist, not a spread-and-omit: adding a field to `Title` later
 * has to be a deliberate choice made HERE, not something that leaks into list
 * results by accident. This is the one place the "no cast on list endpoints"
 * rule from ../types.ts is actually enforced — do not change this to include
 * `cast`, even though every field is sitting right there in `title`.
 */
function toSummary(title: Title): TitleSummary {
  const { id, mediaType, name, year, overview, genres, posterUrl, placeholder, rating } =
    title;
  return { id, mediaType, name, year, overview, genres, posterUrl, placeholder, rating };
}

function paginate<T>(items: T[], page: number): PagedResult<T> {
  const safePage = Math.max(1, page);
  const start = (safePage - 1) * PAGE_SIZE;
  return {
    items: items.slice(start, start + PAGE_SIZE),
    page: safePage,
    totalPages: Math.max(1, Math.ceil(items.length / PAGE_SIZE)),
    totalResults: items.length,
  };
}

function findEntry(id: string, mediaType: MediaType): CatalogEntry | undefined {
  return MOCK_CATALOG.find(
    (entry) => entry.id === id && entry.mediaType === mediaType,
  );
}

function requireEntry(id: string, mediaType: MediaType): CatalogEntry {
  const entry = findEntry(id, mediaType);
  if (!entry) {
    throw new ContentError("not_found", `No ${mediaType} title with id "${id}"`);
  }
  return entry;
}

/**
 * Even split of episodeCount across seasonCount, remainder front-loaded onto
 * earlier seasons (most shows taper off in later seasons, not grow). Air
 * dates are unknown at this granularity, so left null rather than guessed —
 * only the 2 hand-authored shows in episodes.ts have real dates.
 */
function synthesizeSeasons(entry: CatalogEntry): Season[] {
  const seasonCount = entry.seasonCount ?? 0;
  const episodeCount = entry.episodeCount ?? 0;
  const base = Math.floor(episodeCount / Math.max(1, seasonCount));
  const remainder = episodeCount - base * seasonCount;

  return Array.from({ length: seasonCount }, (_, i) => {
    const seasonNumber = i + 1;
    return {
      seasonNumber,
      name: `Season ${seasonNumber}`,
      overview: `Season ${seasonNumber} of ${entry.name}.`,
      episodeCount: base + (i < remainder ? 1 : 0),
      airDate: null,
      posterUrl: null,
    };
  });
}

function synthesizeEpisodes(entry: CatalogEntry, season: Season): Episode[] {
  return Array.from({ length: season.episodeCount }, (_, i) => {
    const episodeNumber = i + 1;
    return {
      id: `${entry.id}-s${String(season.seasonNumber).padStart(2, "0")}e${String(
        episodeNumber,
      ).padStart(2, "0")}`,
      seasonNumber: season.seasonNumber,
      episodeNumber,
      name: `Episode ${episodeNumber}`,
      overview: `Episode ${episodeNumber} of ${entry.name} season ${season.seasonNumber}.`,
      airDate: null,
      runtimeMinutes: null,
      stillUrl: null,
    };
  });
}

export const mockProvider: ContentProvider = {
  async searchTitles(query, options: SearchTitlesOptions = {}) {
    await simulateLatency();
    const q = query.trim().toLowerCase();

    // A blank query returns nothing, NOT the whole catalog. TMDB rejects an
    // empty `query` param outright, so returning everything here would make
    // the two providers behave differently for the same call — precisely the
    // drift this abstraction exists to prevent. Use getTrending() to browse.
    if (!q) {
      return { items: [], page: 1, totalPages: 1, totalResults: 0 };
    }

    const matches = MOCK_CATALOG.filter((entry) => {
      if (options.mediaType && entry.mediaType !== options.mediaType) return false;
      return (
        entry.name.toLowerCase().includes(q) ||
        (entry.originalName?.toLowerCase().includes(q) ?? false)
      );
    });
    return paginate(matches.map((entry) => toSummary(hydrate(entry))), options.page ?? 1);
  },

  async getTrending(mediaType, options: TrendingOptions = {}) {
    await simulateLatency();
    const matches = MOCK_CATALOG.filter(
      (entry) => mediaType === "all" || entry.mediaType === mediaType,
    );
    return paginate(matches.map((entry) => toSummary(hydrate(entry))), options.page ?? 1);
  },

  async getTitle(id, mediaType) {
    await simulateLatency();
    return hydrate(requireEntry(id, mediaType));
  },

  async getSeasons(showId) {
    await simulateLatency();
    const entry = requireEntry(showId, "tv");
    const authored = MOCK_EPISODES[showId];
    return authored ? authored.seasons : synthesizeSeasons(entry);
  },

  async getSeasonEpisodes(showId, seasonNumber) {
    await simulateLatency();
    const entry = requireEntry(showId, "tv");
    const authored = MOCK_EPISODES[showId];

    if (authored) {
      const episodes = authored.episodesBySeason[seasonNumber];
      if (!episodes) {
        throw new ContentError(
          "not_found",
          `Season ${seasonNumber} not found for "${showId}"`,
        );
      }
      return episodes;
    }

    const season = synthesizeSeasons(entry).find(
      (s) => s.seasonNumber === seasonNumber,
    );
    if (!season) {
      throw new ContentError(
        "not_found",
        `Season ${seasonNumber} not found for "${showId}"`,
      );
    }
    return synthesizeEpisodes(entry, season);
  },

  async getSimilar(id, mediaType) {
    await simulateLatency();
    const entry = requireEntry(id, mediaType);
    const genreIds = new Set(entry.genres.map((g) => g.id));

    return MOCK_CATALOG.filter((candidate) => candidate.id !== id)
      .map((candidate) => ({
        candidate,
        overlap: candidate.genres.filter((g) => genreIds.has(g.id)).length,
      }))
      .filter((scored) => scored.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap)
      .slice(0, 6)
      .map((scored) => toSummary(hydrate(scored.candidate)));
  },

  async getRecommendations(id, mediaType) {
    await simulateLatency();
    requireEntry(id, mediaType);

    return MOCK_CATALOG.filter(
      (candidate) => candidate.id !== id && candidate.mediaType === mediaType,
    )
      .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
      .slice(0, 6)
      .map((candidate) => toSummary(hydrate(candidate)));
  },

  async getWatchProviders(id, mediaType) {
    await simulateLatency();
    requireEntry(id, mediaType);
    // Mock mode has no real availability data. Returning [] is honest;
    // fabricating plausible-looking streaming-service names would read as
    // real availability data, and nothing renders this yet anyway (Phase 4).
    return [];
  },
};
