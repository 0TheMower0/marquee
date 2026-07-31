import type { BadgeContext, BadgeDefinition, BadgeStatus, EarnedBadgeRecord } from "./types";

export interface BadgeEvaluation {
  /** Every badge, in definition order, with its current status. A badge with
   *  a ledger record is unlocked regardless of whether its condition is
   *  still live-true (see the doc comment on `badgesEarnedStore`) — that is
   *  what makes non-monotonic conditions like "Caught Up" sticky instead of
   *  flickering on and off. */
  statuses: BadgeStatus[];
  /** Ids with NO ledger record whose condition is true right now. The caller
   *  (the orchestration hook) decides what to do with these — persist them
   *  and, except on the very first-ever evaluation, queue an unlock toast. */
  newlyEarnedIds: string[];
}

/**
 * Pure — no storage, no dates from the clock. `ledger` is passed in rather
 * than read here, same split as everywhere else in this codebase (progress.ts
 * vs context.tsx, formula.ts vs use-xp.ts): this function decides WHAT is
 * newly true, the hook decides what to persist and when to celebrate.
 */
export function evaluateBadges(
  definitions: readonly BadgeDefinition[],
  context: BadgeContext,
  ledger: Readonly<Record<string, EarnedBadgeRecord>>,
): BadgeEvaluation {
  const statuses: BadgeStatus[] = [];
  const newlyEarnedIds: string[] = [];

  for (const definition of definitions) {
    const record = ledger[definition.id];
    const live = definition.isUnlocked(context);
    const unlocked = record !== undefined || live;

    if (record === undefined && live) newlyEarnedIds.push(definition.id);
    statuses.push({ definition, unlocked, earnedAt: record?.earnedAt ?? null });
  }

  return { statuses, newlyEarnedIds };
}
