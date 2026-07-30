import { ContentError } from "../errors";
import type {
  ContentProvider,
  SearchTitlesOptions,
  TrendingOptions,
} from "../provider";
import { derivePlaceholderArt } from "../shared/placeholder";
import type {
  Episode,
  ExternalRating,
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

/**
 * Deliberate artificial delay so loading skeletons are actually visible in
 * dev instead of resolving instantly — a real API never would.
 *
 * Accepts an optional `signal` so `searchTitles` can honor cancellation (see
 * the doc on `SearchTitlesOptions.signal` in provider.ts) — without this,
 * testing "cancel in-flight requests" against the *default* provider
 * wouldn't demonstrate anything, since mock mode is what runs out of the box.
 */
function simulateLatency(signal?: AbortSignal): Promise<void> {
  const ms = MIN_LATENCY_MS + Math.random() * (MAX_LATENCY_MS - MIN_LATENCY_MS);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
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
 * Real per-season episode counts and premiere dates for shows that don't
 * have individually hand-authored episodes (see episodes.ts) but shouldn't
 * be flattened into a naive even split either. "Wildly different episode
 * counts per season" is a real, well-documented fact about most of these
 * shows — Breaking Bad's first season really does have 7 episodes against
 * its last season's 16 — so there's no reason to fabricate a uniform split
 * when the real numbers are just as easy to supply, and they sum to exactly
 * the catalog's existing episodeCount for each show (verified, not assumed).
 *
 * Individual episodes within each season are still synthesized generically
 * (see synthesizeEpisodes) — only the season-level shape and premiere date
 * are real here. A show with no entry below (Grey's Anatomy) falls all the
 * way through to the naive even split, which is the deliberate "nothing
 * special" control — not every show needs to demonstrate something.
 */
const SEASON_SHAPES: Record<
  string,
  {
    episodeCounts: number[];
    premiereDates: string[];
    /** Applied uniformly to every synthesized episode of this show. */
    runtimeMinutes: number;
  }
> = {
  "breaking-bad": {
    episodeCounts: [7, 13, 13, 13, 16],
    premiereDates: [
      "2008-01-20",
      "2009-03-08",
      "2010-03-21",
      "2011-07-17",
      "2012-07-15",
    ],
    runtimeMinutes: 47,
  },
  "the-wire": {
    episodeCounts: [13, 12, 12, 13, 10],
    premiereDates: [
      "2002-06-02",
      "2003-06-01",
      "2004-09-19",
      "2006-09-10",
      "2008-01-06",
    ],
    runtimeMinutes: 59,
  },
  "game-of-thrones": {
    episodeCounts: [10, 10, 10, 10, 10, 10, 7, 6],
    premiereDates: [
      "2011-04-17",
      "2012-04-01",
      "2013-03-31",
      "2014-04-06",
      "2015-04-12",
      "2016-04-24",
      "2017-07-16",
      "2019-04-14",
    ],
    runtimeMinutes: 57,
  },
  "stranger-things": {
    episodeCounts: [8, 9, 8, 9],
    premiereDates: ["2016-07-15", "2017-10-27", "2019-07-04", "2022-05-27"],
    runtimeMinutes: 60,
  },
  "the-office-us": {
    episodeCounts: [6, 22, 25, 19, 28, 26, 26, 24, 25],
    premiereDates: [
      "2005-03-24",
      "2005-09-20",
      "2006-09-21",
      "2007-09-27",
      "2008-09-25",
      "2009-09-17",
      "2010-09-23",
      "2011-09-22",
      "2012-09-20",
    ],
    runtimeMinutes: 22,
  },
  "avatar-the-last-airbender": {
    episodeCounts: [20, 20, 21],
    premiereDates: ["2005-02-21", "2006-03-17", "2007-09-21"],
    runtimeMinutes: 23,
  },
};

/**
 * Even split of episodeCount across seasonCount, remainder front-loaded onto
 * earlier seasons (most shows taper off in later seasons, not grow). Air
 * dates are unknown at this granularity, so left null rather than guessed.
 * Used only for a show with neither a SEASON_SHAPES entry (above) nor a fully
 * hand-authored one (episodes.ts).
 */
function synthesizeSeasons(entry: CatalogEntry): Season[] {
  const shape = SEASON_SHAPES[entry.id];
  if (shape) {
    return shape.episodeCounts.map((episodeCount, i) => ({
      seasonNumber: i + 1,
      name: `Season ${i + 1}`,
      overview: `Season ${i + 1} of ${entry.name}.`,
      episodeCount,
      airDate: shape.premiereDates[i] ?? null,
      posterUrl: null,
    }));
  }

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
  // Real per-episode dates are only modeled for the 5 fully hand-authored
  // shows in episodes.ts — at this tier, only the season's own premiere
  // date (above) is real, so individual episodes stay dateless.
  const runtimeMinutes = SEASON_SHAPES[entry.id]?.runtimeMinutes ?? null;

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
      runtimeMinutes,
      stillUrl: null,
    };
  });
}

/* ---------------------------------------------------------------------------
 * External ratings
 * ------------------------------------------------------------------------ */

/**
 * Titles that deliberately return INCOMPLETE external ratings, so mock mode
 * can actually exercise the per-source degradation the real API forces on us.
 * Without these, every mock title would return all three sources and the
 * "one source missing" layout would only ever be reachable in tmdb mode —
 * exactly the blind spot that has bitten the last two steps.
 *
 * These are plausible as well as useful: Rotten Tomatoes genuinely has no
 * score for a lot of pre-1995 television, and Metacritic doesn't cover every
 * currently-airing show.
 */
const MOCK_RATING_OMISSIONS: Record<string, ReadonlyArray<ExternalRating["source"]>> = {
  "twin-peaks": ["rotten_tomatoes"],
  "the-bear": ["metacritic"],
  // No external ratings at all — the "OMDb has never heard of this" case,
  // where the row must fall back to showing only TMDB's own score.
  "do-the-right-thing": ["imdb", "rotten_tomatoes", "metacritic"],
};

/** FNV-1a, same approach as shared/placeholder.ts: deterministic, so a title's
 *  mock ratings never change between renders or reloads. */
function hashOf(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic offset in [-spread, +spread], derived from the title id. */
function jitter(id: string, salt: string, spread: number): number {
  const unit = (hashOf(`${id}:${salt}`) % 1000) / 1000; // 0..1
  return (unit * 2 - 1) * spread;
}

/**
 * Plausible fixed values derived from the catalog's own TMDB rating, rather
 * than hand-authored per title. Deriving keeps them COHERENT — a 9.3 film
 * can't end up with a 41% Rotten Tomatoes score, which is what makes a mock
 * dataset look obviously fake — while staying deterministic and requiring no
 * maintenance as the catalog grows.
 */
function mockRatingsFor(entry: CatalogEntry): ExternalRating[] {
  const omitted = new Set(MOCK_RATING_OMISSIONS[entry.id] ?? []);
  const base = entry.rating ?? 7;
  const ratings: ExternalRating[] = [];

  if (!omitted.has("imdb")) {
    const value = Math.min(10, Math.max(0, base + jitter(entry.id, "imdb", 0.4)));
    ratings.push({
      source: "imdb",
      value: Math.round(value * 10) / 10,
      scale: "ten",
      votes: 25_000 + (hashOf(`${entry.id}:votes`) % 1_800_000),
    });
  }

  if (!omitted.has("rotten_tomatoes")) {
    // RT skews higher than a 10-point average for well-regarded titles, and
    // its distribution is much wider — a deliberately different curve so the
    // three numbers don't look like the same value printed three ways.
    const value = Math.min(100, Math.max(0, base * 10 + jitter(entry.id, "rt", 12)));
    ratings.push({
      source: "rotten_tomatoes",
      value: Math.round(value),
      scale: "percent",
      votes: null,
    });
  }

  if (!omitted.has("metacritic")) {
    const value = Math.min(100, Math.max(0, base * 9.2 + jitter(entry.id, "mc", 8)));
    ratings.push({
      source: "metacritic",
      value: Math.round(value),
      scale: "hundred",
      votes: null,
    });
  }

  return ratings;
}

export const mockProvider: ContentProvider = {
  async searchTitles(query, options: SearchTitlesOptions = {}) {
    await simulateLatency(options.signal);
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

  async getExternalRatings(id, mediaType) {
    await simulateLatency();
    return mockRatingsFor(requireEntry(id, mediaType));
  },

  async getWatchProviders(id, mediaType) {
    await simulateLatency();
    requireEntry(id, mediaType);
    // Mock mode has no real availability data. Returning [] is honest;
    // fabricating plausible-looking streaming-service names would read as
    // real availability data. WatchProvidersSection (Phase 4 Step 3) renders
    // nothing at all when this is empty, so mock mode simply never shows a
    // "Where to Watch" section — that IS the graceful-empty-data path, not a
    // gap in it.
    return [];
  },
};
