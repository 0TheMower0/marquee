import { episodesWatchedFor } from "@/lib/xp";
import { yearOf } from "@/lib/watchlog";
import type { TrackingEntry } from "@/lib/tracking";

import type { BadgeContext, BadgeDefinition } from "./types";

/**
 * Every badge's unlock threshold lives here, named, so the numbers are the
 * one thing worth arguing about later without touching predicate logic.
 */
const GENRE_HOPPER_COUNT = 5;
const FULL_SPECTRUM_COUNT = 10;
const TIME_TRAVELER_DECADES = 4;
const LONG_HAUL_EPISODES = 100;
const MARATHONER_EPISODES_IN_A_DAY = 8;
const CAUGHT_UP_MIN_WATCHED = 1;
const STREAK_WEEK_ONE = 7;
const STREAK_REGULAR = 30;
const STREAK_DEVOTED = 100;
/** Below this many time-stamped log events, Night Owl / Early Bird don't
 *  evaluate at all — one late night or one early flight shouldn't be enough
 *  to claim a "habit". */
const TIME_OF_DAY_MIN_SAMPLE = 15;
const HAS_OPINIONS_COUNT = 10;
const RATINGS_MACHINE_COUNT = 50;
const FILM_JOURNAL_NOTES_COUNT = 10;
const STRONG_OPINIONS_LOW = 5;
const STRONG_OPINIONS_HIGH = 95;
/** On a 0-100 scale — the user's score vs. TMDB's own rating scaled ×10. */
const CONTRARIAN_GAP = 40;
const DEEP_CUT_YEARS = 40;

const NIGHT_OWL_HOURS = [21, 22, 23, 0, 1, 2];
const EARLY_BIRD_HOURS = [5, 6, 7, 8];

/* ---------------------------------------------------------------------------
 * Shared helpers over BadgeContext
 * ------------------------------------------------------------------------ */

/** Entries the user has actually engaged with — "watching" or "watched" —
 *  as opposed to merely watchlisted. Exploration/discovery badges use this:
 *  genre or decade exposure doesn't require finishing a show. */
function startedEntries(context: BadgeContext): TrackingEntry[] {
  return Object.values(context.entries).filter((entry) => entry.status !== "watchlist");
}

function sumHours(hourCounts: number[], hours: number[]): number {
  return hours.reduce((total, hour) => total + (hourCounts[hour] ?? 0), 0);
}

function totalHours(hourCounts: number[]): number {
  return hourCounts.reduce((total, count) => total + count, 0);
}

/** True once a majority of a large-enough time-stamped sample falls in the
 *  given hour buckets — see TIME_OF_DAY_MIN_SAMPLE above for why "large
 *  enough" matters. */
function isConcentratedIn(context: BadgeContext, hours: number[]): boolean {
  const total = totalHours(context.hourCounts);
  if (total < TIME_OF_DAY_MIN_SAMPLE) return false;
  return sumHours(context.hourCounts, hours) > total / 2;
}

/* ---------------------------------------------------------------------------
 * The 20 badges
 * ------------------------------------------------------------------------ */

export const BADGES: BadgeDefinition[] = [
  /* Exploration ------------------------------------------------------- */
  {
    id: "genre-hopper",
    name: "Genre Hopper",
    category: "exploration",
    description: `Watch titles across ${GENRE_HOPPER_COUNT} different genres.`,
    isUnlocked: (context) => {
      const genres = new Set<string>();
      for (const entry of startedEntries(context)) {
        for (const genre of entry.summary.genres) genres.add(genre.id);
      }
      return genres.size >= GENRE_HOPPER_COUNT;
    },
  },
  {
    id: "full-spectrum",
    name: "Full Spectrum",
    category: "exploration",
    description: `Watch titles across ${FULL_SPECTRUM_COUNT} different genres.`,
    isUnlocked: (context) => {
      const genres = new Set<string>();
      for (const entry of startedEntries(context)) {
        for (const genre of entry.summary.genres) genres.add(genre.id);
      }
      return genres.size >= FULL_SPECTRUM_COUNT;
    },
  },
  {
    id: "time-traveler",
    name: "Time Traveler",
    category: "exploration",
    description: `Watch titles spanning ${TIME_TRAVELER_DECADES} different decades.`,
    isUnlocked: (context) => {
      const decades = new Set<number>();
      for (const entry of startedEntries(context)) {
        if (entry.summary.year === null) continue;
        decades.add(Math.floor(entry.summary.year / 10) * 10);
      }
      return decades.size >= TIME_TRAVELER_DECADES;
    },
  },

  /* Completion ---------------------------------------------------------- */
  {
    id: "the-long-haul",
    name: "The Long Haul",
    category: "completion",
    description: `Finish a series with ${LONG_HAUL_EPISODES}+ episodes.`,
    isUnlocked: (context) =>
      Object.values(context.entries).some(
        (entry) =>
          entry.mediaType === "tv" &&
          entry.status === "watched" &&
          episodesWatchedFor(entry) >= LONG_HAUL_EPISODES,
      ),
  },
  {
    id: "marathoner",
    name: "Marathoner",
    category: "completion",
    description: `Watch ${MARATHONER_EPISODES_IN_A_DAY}+ episodes of the same show in a single day.`,
    isUnlocked: (context) => context.maxEpisodesInADay >= MARATHONER_EPISODES_IN_A_DAY,
  },
  {
    id: "caught-up",
    name: "Caught Up",
    category: "completion",
    description: "Clear your entire watchlist down to zero.",
    isUnlocked: (context) => {
      const values = Object.values(context.entries);
      const backlog = values.filter((e) => e.status === "watchlist" || e.status === "watching").length;
      const watched = values.filter((e) => e.status === "watched").length;
      return backlog === 0 && watched >= CAUGHT_UP_MIN_WATCHED;
    },
  },

  /* Habit ----------------------------------------------------------------- */
  {
    id: "week-one",
    name: "Week One",
    category: "habit",
    description: `Reach a ${STREAK_WEEK_ONE}-day streak.`,
    isUnlocked: (context) => context.streak.longestStreak >= STREAK_WEEK_ONE,
  },
  {
    id: "regular",
    name: "Regular",
    category: "habit",
    description: `Reach a ${STREAK_REGULAR}-day streak.`,
    isUnlocked: (context) => context.streak.longestStreak >= STREAK_REGULAR,
  },
  {
    id: "devoted",
    name: "Devoted",
    category: "habit",
    description: `Reach a ${STREAK_DEVOTED}-day streak.`,
    isUnlocked: (context) => context.streak.longestStreak >= STREAK_DEVOTED,
  },
  {
    id: "comeback",
    name: "Comeback",
    category: "habit",
    description: "Use a streak freeze to bridge a missed day.",
    isUnlocked: (context) => context.streak.freezesSpentLifetime >= 1,
  },
  {
    id: "night-owl",
    name: "Night Owl",
    category: "habit",
    description: "Do most of your watching between 9pm and 3am.",
    isUnlocked: (context) => isConcentratedIn(context, NIGHT_OWL_HOURS),
  },
  {
    id: "early-bird",
    name: "Early Bird",
    category: "habit",
    description: "Do most of your watching between 5am and 9am.",
    isUnlocked: (context) => isConcentratedIn(context, EARLY_BIRD_HOURS),
  },

  /* Taste ------------------------------------------------------------------ */
  {
    id: "has-opinions",
    name: "Has Opinions",
    category: "taste",
    description: `Rate ${HAS_OPINIONS_COUNT} titles.`,
    isUnlocked: (context) =>
      Object.values(context.ratingEntries).filter((r) => r.score !== null).length >= HAS_OPINIONS_COUNT,
  },
  {
    id: "ratings-machine",
    name: "Ratings Machine",
    category: "taste",
    description: `Rate ${RATINGS_MACHINE_COUNT} titles.`,
    isUnlocked: (context) =>
      Object.values(context.ratingEntries).filter((r) => r.score !== null).length >= RATINGS_MACHINE_COUNT,
  },
  {
    id: "film-journal",
    name: "Film Journal",
    category: "taste",
    description: `Write notes on ${FILM_JOURNAL_NOTES_COUNT} titles.`,
    isUnlocked: (context) =>
      Object.values(context.ratingEntries).filter((r) => r.note.trim().length > 0).length >=
      FILM_JOURNAL_NOTES_COUNT,
  },
  {
    id: "strong-opinions",
    name: "Strong Opinions",
    category: "taste",
    description: `Give a title a rating of ${STRONG_OPINIONS_LOW} or below, or ${STRONG_OPINIONS_HIGH} or above.`,
    isUnlocked: (context) =>
      Object.values(context.ratingEntries).some(
        (r) => r.score !== null && (r.score <= STRONG_OPINIONS_LOW || r.score >= STRONG_OPINIONS_HIGH),
      ),
  },
  {
    id: "contrarian",
    name: "Contrarian",
    category: "taste",
    description: `Rate something ${CONTRARIAN_GAP}+ points away from its TMDB score.`,
    isUnlocked: (context) =>
      Object.entries(context.ratingEntries).some(([key, r]) => {
        if (r.score === null) return false;
        const tmdbRating = context.entries[key]?.summary.rating;
        if (tmdbRating === undefined || tmdbRating === null) return false;
        return Math.abs(r.score - tmdbRating * 10) >= CONTRARIAN_GAP;
      }),
  },
  {
    id: "second-helping",
    name: "Second Helping",
    category: "taste",
    description: "Mark something watched, then watch it again.",
    isUnlocked: (context) => context.hasRepeatedMark,
  },

  /* Discovery --------------------------------------------------------------- */
  {
    id: "first-to-know",
    name: "First to Know",
    category: "discovery",
    description: "Watch a title TMDB doesn't have a score for yet.",
    isUnlocked: (context) => startedEntries(context).some((entry) => entry.summary.rating === null),
  },
  {
    id: "deep-cut",
    name: "Deep Cut",
    category: "discovery",
    description: `Watch something released ${DEEP_CUT_YEARS}+ years before you watched it.`,
    isUnlocked: (context) =>
      Object.entries(context.entries).some(([key, entry]) => {
        if (entry.summary.year === null) return false;
        const loggedDay = context.earliestDayForTitle[key];
        if (loggedDay === undefined) return false;
        return Number(yearOf(loggedDay)) - entry.summary.year >= DEEP_CUT_YEARS;
      }),
  },
];
