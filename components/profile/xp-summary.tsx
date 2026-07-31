"use client";

import { useXp } from "@/components/profile/use-xp";
import { LevelUpToast } from "@/components/profile/level-up-toast";
import { ProgressBar } from "@/components/tracking/progress-bar";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StarIcon } from "@/components/ui/icons";

/**
 * The Profile-page XP bar. Reuses `ProgressBar` from lib/tracking's
 * components unmodified — "shared by show-level and season-level progress —
 * same visual, same math" already covers this third use directly, no new
 * progress-bar component needed.
 *
 * Renders a skeleton (not nothing) while `useXp()` settles — unlike most
 * "renders nothing until ready" patterns elsewhere in the app, THIS is the
 * one thing the Profile page is for, so a brief empty page would read as
 * broken rather than as an absent feature.
 */
export function XpSummary() {
  const { ready, breakdown, progress, justLeveledUp } = useXp();

  if (!ready) {
    return (
      <Card>
        <div className="flex items-center justify-between">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-5 w-16" />
        </div>
        <Skeleton className="mt-4 h-1.5 w-full rounded-full" />
      </Card>
    );
  }

  return (
    <>
      {justLeveledUp && <LevelUpToast level={progress.level} rank={progress.rank} />}

      <Card>
        <div className="flex items-baseline justify-between gap-3">
          <div className="flex items-center gap-2">
            <StarIcon className="text-accent size-5" />
            <h2 className="font-display text-display-md text-fg uppercase">{progress.rank}</h2>
          </div>
          <span className="text-meta text-fg-subtle uppercase">Level {progress.level}</span>
        </div>

        <ProgressBar percent={progress.percentToNextLevel} className="mt-4" />

        <p className="text-meta-sm text-fg-subtle mt-2 tabular-nums">
          {progress.xpIntoLevel.toLocaleString()} / {progress.xpForNextLevel.toLocaleString()} XP to
          Level {progress.level + 1}
        </p>

        <dl className="border-line-subtle mt-4 grid grid-cols-2 gap-3 border-t pt-4 sm:grid-cols-4">
          <Stat label="Total XP" value={breakdown.total.toLocaleString()} />
          <Stat label="From episodes" value={breakdown.fromEpisodes.toLocaleString()} />
          <Stat label="From movies" value={breakdown.fromMovies.toLocaleString()} />
          <Stat
            label="From bonuses"
            value={(breakdown.fromSeasonBonuses + breakdown.fromSeriesBonuses).toLocaleString()}
          />
        </dl>
      </Card>
    </>
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
