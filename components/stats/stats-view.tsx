"use client";

import { useStats } from "@/components/stats/use-stats";
import { BarChart } from "@/components/stats/bar-chart";
import { CalendarHeatmap } from "@/components/stats/calendar-heatmap";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-meta-sm text-fg-subtle uppercase">{label}</dt>
      <dd className="font-display text-display-sm text-fg mt-1">{value}</dd>
    </div>
  );
}

/**
 * The stats dashboard — its own route (`/profile/stats`) rather than one
 * more card on the already-long Profile page. Every chart here is hand-rolled
 * (see the doc comment on `BarChart`), so nothing on this page depends on a
 * charting library, and every color comes from a semantic token so the whole
 * page re-themes if the marquee palette itself ever changes.
 */
export function StatsView() {
  const stats = useStats();

  if (!stats.ready) {
    return (
      <div className="space-y-6 p-6 sm:p-8">
        <Skeleton className="h-8 w-48" />
        {Array.from({ length: 4 }, (_, i) => (
          <Card key={i}>
            <Skeleton className="h-6 w-32" />
            <Skeleton className="mt-4 h-24 w-full" />
          </Card>
        ))}
      </div>
    );
  }

  const { watchTime, allTime, thisYear, genres, decades, topShows, ratingDistribution, ratingComparison, heatmap, gamification } =
    stats;

  const yearIndex = heatmap.availableYears.indexOf(heatmap.year);
  const canGoEarlier = yearIndex > 0;
  const canGoLater = yearIndex >= 0 && yearIndex < heatmap.availableYears.length - 1;

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-display-lg text-fg uppercase">Stats</h1>
          <p className="text-body-sm text-fg-subtle mt-1 max-w-prose">
            Everything below is free — no paywall, no upsell. It&apos;s computed
            from what&apos;s already tracked on this device.
          </p>
        </div>
        <Button href="/profile" variant="ghost" size="sm">
          Back to Profile
        </Button>
      </div>

      {gamification.ready && (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="accent">Level {gamification.level} · {gamification.rank}</Badge>
          {gamification.currentStreak > 0 && (
            <Badge variant="accent">{gamification.currentStreak}-day streak</Badge>
          )}
          <Badge variant="neutral">
            {gamification.badgesEarned} / {gamification.badgesTotal} badges
          </Badge>
        </div>
      )}

      <Card>
        <h2 className="text-meta-sm text-fg-subtle uppercase">Total watch time</h2>
        <p className="font-display text-display-xl text-accent mt-1">
          {watchTime.totalHours.toLocaleString()} hrs
        </p>
        <p className="text-body-sm text-fg-muted mt-1">
          About {watchTime.totalDays.toLocaleString()} days of your life, give or take.
        </p>
      </Card>

      <Card>
        <h2 className="text-meta-sm text-fg-subtle uppercase">Episodes &amp; films</h2>
        <dl className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Episodes this year" value={thisYear.episodes.toLocaleString()} />
          <Stat label="Films this year" value={thisYear.movies.toLocaleString()} />
          <Stat label="Episodes all-time" value={allTime.episodes.toLocaleString()} />
          <Stat label="Films all-time" value={allTime.movies.toLocaleString()} />
        </dl>
        <p className="text-meta-sm text-fg-subtle mt-3">
          &quot;This year&quot; comes from the watch-date log, which only started
          recording in Phase 5 — anything watched before then isn&apos;t in this
          count. All-time totals come from your tracking data directly and are
          exact.
        </p>
      </Card>

      <Card>
        <h2 className="text-meta-sm text-fg-subtle uppercase">Genres</h2>
        <div className="mt-4">
          <BarChart
            data={genres.slice(0, 10).map((g) => ({ label: g.name, value: g.count }))}
            emptyMessage="Watch a few things to see your genre spread."
          />
        </div>
      </Card>

      <Card>
        <h2 className="text-meta-sm text-fg-subtle uppercase">Decades</h2>
        <div className="mt-4">
          <BarChart
            data={decades.map((d) => ({ label: `${d.decade}s`, value: d.count }))}
            accent="accent-2"
            emptyMessage="Nothing with a known release year yet."
          />
        </div>
      </Card>

      <Card>
        <h2 className="text-meta-sm text-fg-subtle uppercase">Most-watched shows</h2>
        <div className="mt-4">
          <BarChart
            data={topShows.map((s) => ({ label: s.name, value: s.episodesWatched }))}
            formatValue={(v) => `${v} ep`}
            emptyMessage="No episodes watched yet."
          />
        </div>
      </Card>

      <Card>
        <h2 className="text-meta-sm text-fg-subtle uppercase">Your ratings</h2>
        <div className="mt-4">
          <BarChart
            data={ratingDistribution.map((b) => ({ label: b.label, value: b.count }))}
            emptyMessage="Rate a few titles to see your distribution."
          />
        </div>
        {ratingComparison.sampleSize > 0 ? (
          <p className="text-body-sm text-fg-muted mt-4">
            Across {ratingComparison.sampleSize} title{ratingComparison.sampleSize === 1 ? "" : "s"} you&apos;ve
            rated, you average <span className="text-accent font-semibold">{ratingComparison.userAverage}</span> —
            TMDB averages <span className="text-fg font-semibold">{ratingComparison.tmdbAverage}</span> on the
            same titles.
          </p>
        ) : (
          <p className="text-meta-sm text-fg-subtle mt-4">
            Rate a title that also has a TMDB score to see how your taste compares.
          </p>
        )}
      </Card>

      <Card>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-meta-sm text-fg-subtle uppercase">Viewing activity — {heatmap.year}</h2>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => heatmap.setYear(heatmap.availableYears[yearIndex - 1])}
              disabled={!canGoEarlier}
              aria-label="Previous year"
              className="text-fg-subtle hover:text-fg disabled:opacity-30 rounded-sm p-1 focus-visible:outline-offset-2"
            >
              ‹
            </button>
            <button
              type="button"
              onClick={() => heatmap.setYear(heatmap.availableYears[yearIndex + 1])}
              disabled={!canGoLater}
              aria-label="Next year"
              className="text-fg-subtle hover:text-fg disabled:opacity-30 rounded-sm p-1 focus-visible:outline-offset-2"
            >
              ›
            </button>
          </div>
        </div>
        <div className="mt-4">
          <CalendarHeatmap days={heatmap.days} />
        </div>
      </Card>
    </div>
  );
}
