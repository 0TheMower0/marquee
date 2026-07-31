/**
 * Public surface of the badges layer. Components import from here, never
 * from the individual modules — mirrors every other lib/ package.
 */
export { BADGES } from "./definitions";
export { evaluateBadges } from "./evaluate";
export type { BadgeEvaluation } from "./evaluate";
export { badgesEarnedStore } from "./store";
export type {
  BadgeCategory,
  BadgeContext,
  BadgeDefinition,
  BadgeStatus,
  EarnedBadgeRecord,
} from "./types";
