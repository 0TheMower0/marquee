import { defineStore } from "@/lib/storage";

import type { EarnedBadgeRecord } from "./types";

/**
 * One record per earned badge, keyed by badge id, holding only WHEN it was
 * earned. Mirrors `lib/xp/store.ts`'s `seenLevelStore` exactly, and for the
 * same reason: badge unlock CONDITIONS are pure functions in definitions.ts
 * and need no migration to add or change — this store exists solely to make
 * badges sticky (a non-monotonic condition like "Caught Up" can go false
 * again without un-earning the badge) and to give the unlock toast a
 * reliable one-shot moment, the same problem `seenLevelStore` solves for
 * level-ups.
 *
 * `Store.keys()` returns exactly the set of earned badge ids, so "which
 * badges are earned" never needs a value read — the same keys()-only payoff
 * lib/watchlog leans on throughout Phase 5.
 */
function isEarnedBadgeRecord(data: unknown): data is EarnedBadgeRecord {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as EarnedBadgeRecord).earnedAt instanceof Date
  );
}

export const badgesEarnedStore = defineStore<EarnedBadgeRecord>({
  namespace: "badges-earned",
  version: 1,
  migrations: {},
  validate: isEarnedBadgeRecord,
});
