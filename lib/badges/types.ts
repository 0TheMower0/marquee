import type { DayKey, StreakStatus } from "@/lib/watchlog";
import type { RatingEntry } from "@/lib/ratings";
import type { TrackingEntry } from "@/lib/tracking";

export type BadgeCategory = "exploration" | "completion" | "habit" | "taste" | "discovery";

/**
 * Everything a badge predicate can see, all of it already in hand from
 * lib/tracking + lib/ratings + lib/watchlog — no provider fetch is ever
 * triggered to evaluate a badge. `entries`/`ratingEntries` keep the exact
 * `${mediaType}:${id}` keying `useTracking()`/`useRatings()` already use, so
 * a predicate that needs to match a rating to its tracked title (Contrarian)
 * does one object lookup, not a scan.
 */
export interface BadgeContext {
  entries: Record<string, TrackingEntry>;
  ratingEntries: Record<string, RatingEntry>;
  streak: StreakStatus;
  /** `byHourOfDay` over the WHOLE log, 24-length, local hour buckets. */
  hourCounts: number[];
  maxEpisodesInADay: number;
  hasRepeatedMark: boolean;
  earliestDayForTitle: Record<string, DayKey>;
}

export interface BadgeDefinition {
  id: string;
  name: string;
  category: BadgeCategory;
  /** The unlock condition, in plain language. Shown for BOTH locked and
   *  unlocked badges — locked ones show this as "how to unlock it", which is
   *  the whole point per the brief: a visible condition is what makes a
   *  locked badge motivating instead of a surprise. */
  description: string;
  isUnlocked: (context: BadgeContext) => boolean;
}

/** One persisted fact per earned badge: WHEN. Nothing about the badge's own
 *  unlock logic is stored — see the doc comment on `badgesEarnedStore`. */
export interface EarnedBadgeRecord {
  earnedAt: Date;
}

export interface BadgeStatus {
  definition: BadgeDefinition;
  unlocked: boolean;
  /** Null while locked. Once set, sticky — see `evaluateBadges`. */
  earnedAt: Date | null;
}
