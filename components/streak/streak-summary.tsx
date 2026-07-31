"use client";

import { useStreak } from "@/components/streak/use-streak";
import { Card } from "@/components/ui/card";
import { FlameIcon } from "@/components/ui/icons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The Profile-page streak card — full detail (current, longest, freezes
 * banked) alongside XpSummary, same Card/skeleton idiom.
 *
 * The zero-streak case is stated plainly rather than omitted here (unlike
 * StreakBadge on Home, which hides entirely at zero) — Profile is a page the
 * user visits specifically to check stats, so an honest "no active streak"
 * is informative rather than a nag. Still no guilt-tripping copy: no "you
 * lost your streak," just the current fact and an invitation, not a demand.
 */
export function StreakSummary() {
  const { ready, status } = useStreak();

  if (!ready) {
    return (
      <Card>
        <div className="flex items-center gap-2">
          <Skeleton className="size-5 rounded-full" />
          <Skeleton className="h-6 w-32" />
        </div>
        <Skeleton className="mt-4 h-10 w-full" />
      </Card>
    );
  }

  const hasStreak = status.currentStreak > 0;

  return (
    <Card>
      <div className="flex items-center gap-2">
        <FlameIcon className="text-accent size-5" />
        <h2 className="font-display text-display-md text-fg uppercase">Streak</h2>
      </div>

      <p className="text-body-sm text-fg-muted mt-2">
        {hasStreak
          ? `On a ${status.currentStreak}-day streak.`
          : "No active streak right now — watch something to start one."}
        {status.freezeActive && " A freeze is covering yesterday, so it's still alive."}
      </p>

      <dl className="border-line-subtle mt-4 grid grid-cols-3 gap-3 border-t pt-4">
        <Stat label="Current" value={String(status.currentStreak)} />
        <Stat label="Longest" value={String(status.longestStreak)} />
        <Stat label="Freezes banked" value={String(status.freezesAvailable)} />
      </dl>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-meta-sm text-fg-subtle uppercase">{label}</dt>
      <dd className="text-fg text-body-sm tabular-nums">{value}</dd>
    </div>
  );
}
