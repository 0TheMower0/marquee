/**
 * Public surface of the schedule layer. Components import from here, never
 * from build.ts directly — mirrors the convention in lib/tracking, lib/content.
 */
export { buildScheduleItems, groupSchedule, selectScheduleCandidates } from "./build";
export type { ScheduleBucket, ScheduleCandidate, ScheduleFeed, ScheduleItem } from "./build";
