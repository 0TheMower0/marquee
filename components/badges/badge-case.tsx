"use client";

import { BadgeUnlockToast } from "@/components/badges/badge-unlock-toast";
import { useBadges } from "@/components/badges/use-badges";
import { Card } from "@/components/ui/card";
import { RibbonIcon } from "@/components/ui/icons";
import { Skeleton } from "@/components/ui/skeleton";
import type { BadgeCategory, BadgeStatus } from "@/lib/badges";
import { cn } from "@/lib/utils/cn";

const CATEGORY_ORDER: BadgeCategory[] = ["exploration", "completion", "habit", "taste", "discovery"];

const CATEGORY_LABELS: Record<BadgeCategory, string> = {
  exploration: "Exploration",
  completion: "Completion",
  habit: "Habit",
  taste: "Taste",
  discovery: "Discovery",
};

function formatEarnedDate(date: Date): string {
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/**
 * The Profile badge case. Locked tiles show their unlock condition (the
 * SAME `description` string used when unlocked would show an earned date) —
 * per the brief, a visible condition is what makes a locked badge motivating
 * rather than a surprise, so nothing here is ever hidden or blanked out for
 * being locked.
 */
export function BadgeCase() {
  const { ready, statuses, newlyUnlocked, dismissOldestUnlock } = useBadges();

  if (!ready) {
    return (
      <Card>
        <Skeleton className="h-7 w-32" />
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      </Card>
    );
  }

  const byCategory = new Map<BadgeCategory, BadgeStatus[]>();
  for (const status of statuses) {
    const list = byCategory.get(status.definition.category) ?? [];
    list.push(status);
    byCategory.set(status.definition.category, list);
  }
  const earnedCount = statuses.filter((s) => s.unlocked).length;

  return (
    <>
      {newlyUnlocked.length > 0 && (
        <BadgeUnlockToast
          key={newlyUnlocked[0].id}
          badge={newlyUnlocked[0]}
          onDismiss={dismissOldestUnlock}
        />
      )}

      <Card>
        <div className="flex items-baseline justify-between gap-3">
          <div className="flex items-center gap-2">
            <RibbonIcon className="text-accent size-5" />
            <h2 className="font-display text-display-md text-fg uppercase">Badges</h2>
          </div>
          <span className="text-meta text-fg-subtle uppercase tabular-nums">
            {earnedCount} / {statuses.length}
          </span>
        </div>

        <div className="mt-4 space-y-6">
          {CATEGORY_ORDER.map((category) => {
            const items = byCategory.get(category);
            if (!items || items.length === 0) return null;
            return (
              <div key={category}>
                <h3 className="text-meta-sm text-fg-subtle uppercase">{CATEGORY_LABELS[category]}</h3>
                <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                  {items.map((status) => (
                    <BadgeTile key={status.definition.id} status={status} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </>
  );
}

function BadgeTile({ status }: { status: BadgeStatus }) {
  const { definition, unlocked, earnedAt } = status;

  return (
    <div
      className={cn(
        "rounded-md border p-3",
        unlocked ? "border-accent/40 bg-accent/10" : "border-line-subtle bg-overlay opacity-70",
      )}
    >
      <RibbonIcon className={cn("size-5", unlocked ? "text-accent" : "text-fg-subtle")} />
      <p className={cn("text-body-sm mt-2 font-semibold", unlocked ? "text-fg" : "text-fg-muted")}>
        {definition.name}
      </p>
      <p className="text-meta-sm text-fg-subtle mt-1">
        {unlocked && earnedAt ? `Earned ${formatEarnedDate(earnedAt)}` : definition.description}
      </p>
    </div>
  );
}
