"use client";

import { ContentErrorState } from "@/components/content/content-error-state";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { CompassIcon, TvIcon } from "@/components/ui/icons";
import { Skeleton } from "@/components/ui/skeleton";
import type { ScheduleItem } from "@/lib/schedule";

import { ScheduleCard } from "./schedule-card";
import { useSchedule } from "./use-schedule";

/**
 * `/schedule` — Phase 7's new-episode feed. A calendar-style view of every
 * "watching" or "watched" show's next unwatched episode, grouped by whether
 * it's already aired (the headline "Ready to watch" section — see the note
 * on `ScheduleBucket` in lib/schedule/build.ts for why a same-day episode
 * lands here rather than in a separate "today" bucket) or still to come
 * (This Week / Later).
 *
 * Client-rendered for the same reason every other tracking-derived page is —
 * this data only exists in the browser's local storage plus a per-show TMDB
 * fetch, so a Server Component has nothing to render it from.
 */
export function ScheduleView() {
  const { settled, hasEligibleShows, loadFailed, feed, seasonCountsByShowId, markEpisodeWatched } =
    useSchedule();

  if (!settled) {
    return <ScheduleSkeleton />;
  }

  const nothingToShow =
    feed.ready.length === 0 && feed.thisWeek.length === 0 && feed.later.length === 0;

  // Nothing survived AND something failed: we genuinely do not know what has
  // aired, so say that. Claiming "you're all caught up" here would be a
  // confident falsehood produced by an outage — the exact bug this branch
  // exists to prevent. Ordered before the two empty states below so it can
  // never be reached past them.
  if (nothingToShow && loadFailed) {
    return (
      <div className="p-6 sm:p-8">
        <PageHeader />
        <ContentErrorState kind="network" className="mt-8 py-8" />
      </div>
    );
  }

  if (!hasEligibleShows) {
    return (
      <div className="p-6 sm:p-8">
        <PageHeader />
        <EmptyState
          icon={<TvIcon />}
          title="Nothing to schedule yet"
          body="Once you start a show, its next episode — and anything already waiting — shows up here."
          className="mt-8 py-8"
          action={
            <Button href="/search" variant="outline" size="sm">
              Search titles
            </Button>
          }
        />
      </div>
    );
  }

  if (nothingToShow) {
    return (
      <div className="p-6 sm:p-8">
        <PageHeader />
        <EmptyState
          icon={<CompassIcon />}
          title="You're all caught up"
          body="Nothing new has aired for anything you're tracking, and nothing's scheduled yet either."
          className="mt-8 py-8"
        />
      </div>
    );
  }

  return (
    <div className="space-y-10 p-6 sm:p-8">
      <PageHeader />

      {/* Something DID load, so the feed below is real — but it is incomplete,
          and a feed whose whole job is "what's actionable" must not let a
          silent gap read as "nothing there". Inline and calm rather than an
          error panel: the correct reaction is "scroll on, check back later",
          not "something is broken". */}
      {loadFailed && (
        <p role="status" className="text-fg-muted text-body-sm">
          Some shows couldn&rsquo;t be checked just now, so this list may be
          missing a few. Reloading usually sorts it.
        </p>
      )}

      {feed.ready.length > 0 && (
        <ScheduleSection
          heading="Ready to watch"
          items={feed.ready}
          seasonCountsByShowId={seasonCountsByShowId}
          markEpisodeWatched={markEpisodeWatched}
        />
      )}
      {feed.thisWeek.length > 0 && (
        <ScheduleSection
          heading="This week"
          items={feed.thisWeek}
          seasonCountsByShowId={seasonCountsByShowId}
          markEpisodeWatched={markEpisodeWatched}
        />
      )}
      {feed.later.length > 0 && (
        <ScheduleSection
          heading="Later"
          items={feed.later}
          seasonCountsByShowId={seasonCountsByShowId}
          markEpisodeWatched={markEpisodeWatched}
        />
      )}
    </div>
  );
}

function PageHeader() {
  return (
    <div>
      <h1 className="font-display text-display-xl text-fg uppercase">Schedule</h1>
      <p className="text-body text-fg-muted mt-1 max-w-prose">
        What&rsquo;s new for shows you&rsquo;re tracking — aired and waiting, or on the way.
      </p>
    </div>
  );
}

function ScheduleSection({
  heading,
  items,
  seasonCountsByShowId,
  markEpisodeWatched,
}: {
  heading: string;
  items: ScheduleItem[];
  seasonCountsByShowId: ReturnType<typeof useSchedule>["seasonCountsByShowId"];
  markEpisodeWatched: ReturnType<typeof useSchedule>["markEpisodeWatched"];
}) {
  return (
    <section aria-labelledby={`schedule-${heading}`}>
      <h2
        id={`schedule-${heading}`}
        className="font-display text-display-md text-fg uppercase"
      >
        {heading}
      </h2>
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item) => (
          <ScheduleCard
            key={`${item.entry.id}:${item.seasonNumber}:${item.episodeNumber}`}
            item={item}
            seasons={seasonCountsByShowId[item.entry.id]}
            markEpisodeWatched={markEpisodeWatched}
          />
        ))}
      </div>
    </section>
  );
}

function ScheduleSkeleton() {
  return (
    <div
      className="space-y-10 p-6 sm:p-8"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="sr-only">Loading your schedule</span>
      <Skeleton className="h-9 w-48" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i}>
            <Skeleton className="aspect-video w-full rounded-lg" />
            <div className="mt-2 space-y-2">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
