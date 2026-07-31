/**
 * Public surface of the XP layer. Components import from here, never from
 * the individual modules — mirrors the convention in lib/tracking, lib/ratings,
 * and lib/watchlog.
 */
export {
  computeXp,
  DEFAULT_MOVIE_RUNTIME_MINUTES,
  SEASON_COMPLETE_BONUS_XP,
  SERIES_COMPLETE_BONUS_XP,
  XP_PER_EPISODE,
  XP_PER_MINUTE,
} from "./formula";
export type { XpBreakdown, XpInput } from "./formula";
export {
  LEVEL_BASE_XP,
  LEVEL_EXPONENT,
  levelForXp,
  levelProgressForXp,
  rankForLevel,
  xpForLevel,
} from "./levels";
export type { LevelProgress } from "./levels";
export { getHighestLevelSeen, seenLevelStore, setHighestLevelSeen } from "./store";
export { completedSeasonsFor, episodesWatchedFor, movieRuntimeMinutesFor } from "./resolve";
