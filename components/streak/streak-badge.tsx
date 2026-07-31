"use client";

import { useStreak } from "@/components/streak/use-streak";
import { Badge } from "@/components/ui/badge";
import { FlameIcon } from "@/components/ui/icons";

/**
 * The ambient Home indicator — "somewhere ambient but not nagging," per the
 * brief. Deliberately minimal: current streak only (longest + freeze count
 * live on the fuller Profile card), and renders NOTHING rather than "0 day
 * streak" when there's nothing to show. A visible zero would itself be the
 * nag this component exists to avoid.
 *
 * No danger/warning styling, no countdown, no "don't lose it" copy — an
 * accent-tinted chip stating a fact, same visual language as
 * ShowProgressBadge. When a freeze is presently covering an unlogged gap,
 * that's framed as reassurance ("protected"), not a warning.
 */
export function StreakBadge() {
  const { ready, status } = useStreak();

  if (!ready || status.currentStreak === 0) return null;

  return (
    <Badge variant="accent" icon={<FlameIcon className="size-3.5" />}>
      {status.currentStreak}-day streak
      {status.freezeActive && " · protected by a freeze"}
    </Badge>
  );
}
