export interface GenreCount {
  id: string;
  name: string;
  count: number;
}

/** The decade's first year, e.g. `1990` means "the 1990s". */
export interface DecadeCount {
  decade: number;
  count: number;
}

export interface TopShow {
  id: string;
  name: string;
  episodesWatched: number;
}

/** One 10-point score bucket, e.g. "0-9", ..., "90-100". */
export interface RatingBucket {
  label: string;
  count: number;
}

/**
 * Your own average score vs. TMDB's average rating, computed over the SAME
 * set of titles — same fairness discipline as the "Contrarian" badge: a title
 * only counts if it has BOTH a user score and a TMDB rating, so this is never
 * comparing your taste against a mismatched population.
 */
export interface RatingComparison {
  userAverage: number | null;
  tmdbAverage: number | null;
  /** How many titles the averages above are actually computed over. Null
   *  averages when this is 0. */
  sampleSize: number;
}

export interface WatchTimeSummary {
  totalMinutes: number;
  totalHours: number;
  /** One decimal place — "3.2 days of your life", not a rounded integer. */
  totalDays: number;
}

export interface PeriodCounts {
  episodes: number;
  movies: number;
}

export interface HeatmapDay {
  day: string;
  count: number;
}

export interface StatsSummary {
  watchTime: WatchTimeSummary;
  thisYear: PeriodCounts;
  allTime: PeriodCounts;
  genres: GenreCount[];
  decades: DecadeCount[];
  topShows: TopShow[];
  ratingDistribution: RatingBucket[];
  ratingComparison: RatingComparison;
}
