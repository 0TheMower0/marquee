"use client";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { AlertIcon, CompassIcon } from "@/components/ui/icons";
import { Skeleton } from "@/components/ui/skeleton";
import type { SeasonEpisodeCounts, UpNextItem } from "@/lib/tracking";
import { cn } from "@/lib/utils/cn";

import { episodeCacheKey, UpNextCard, type MarkEpisodeWatched } from "./up-next-card";
import { useUpNextItems } from "./use-up-next-items";

/**
 * The "continue watching" rail for Home — Phase 3 Step 3 built the ranking
 * engine and this rail; Phase 3 Step 4 extracted the fetch/ranking logic
 * into `useUpNextItems` (shared with Library's "Continue Watching" section)
 * and added the empty state below, which used to be a bare `return null`.
 */
export function UpNextRail() {
  const {
    settled,
    hasWatchingShows,
    loadFailed,
    ready,
    upcoming,
    seasonCountsByShowId,
    markEpisodeWatched,
  } = useUpNextItems();

  // ALWAYS a skeleton while unsettled, never `null` — this reserves the slot's
  // height, and that is what fixes Home's layout shift.
  //
  // It used to return null when there were no watching shows, on the reasoning
  // that a visitor with nothing tracked should see nothing. But this rail
  // renders SOMETHING in every settled state (the rail, or the "Nothing in
  // progress" empty state), so `null` was never the final answer — it was a
  // temporary zero-height hole that filled in once localStorage resolved,
  // shoving the entire trending grid below it down the page.
  //
  // Measured from the Lighthouse trace rather than guessed at, after two wrong
  // hypotheses (skeleton card count, then font swap) each disproved by the
  // number not moving: the trending section jumped from y=147 to y=497 — 350px,
  // the height of this slot appearing — for a cumulative layout shift of 0.645
  // against a 0.1 "good" threshold.
  if (!settled) return <UpNextRailSkeleton />;

  const nothingToShow = ready.length === 0 && upcoming.length === 0;

  // Shows ARE in progress, we just could not find out what is next for any of
  // them. "Nothing in progress" would be flatly untrue, and was: with TMDB
  // unreachable this rail said exactly that while Trending, one section
  // below, correctly reported the outage.
  if (hasWatchingShows && nothingToShow && loadFailed) {
    return (
      <section aria-labelledby="up-next-heading">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="up-next-heading" className="font-display text-display-lg text-fg uppercase">
            Up Next
          </h2>
          <ScheduleLink />
        </div>
        <EmptyState
          tone="danger"
          icon={<AlertIcon />}
          title="Couldn't load what's next"
          body="Your progress is safe — we just couldn't reach the content source to check what's airing."
          className="py-8"
        />
      </section>
    );
  }

  if (!hasWatchingShows || nothingToShow) {
    return (
      <section aria-labelledby="up-next-heading">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="up-next-heading" className="font-display text-display-lg text-fg uppercase">
            Up Next
          </h2>
          <ScheduleLink />
        </div>
        {/* Trending is one scroll away on this exact page, so only Search —
            "go find something to start" — is offered here. Library's
            ContinueWatchingSection, which has no Trending nearby, offers
            both. */}
        <EmptyState
          icon={<CompassIcon />}
          title="Nothing in progress"
          body="Shows you're watching will show up here, with what's next already queued up."
          className="py-8"
          action={
            <Button href="/search" variant="outline" size="sm">
              Search titles
            </Button>
          }
        />
      </section>
    );
  }

  return (
    <section aria-labelledby="up-next-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="up-next-heading" className="font-display text-display-lg text-fg uppercase">
          Up Next
        </h2>
        <ScheduleLink />
      </div>

      <UpNextRow
        items={ready}
        seasonCountsByShowId={seasonCountsByShowId}
        markEpisodeWatched={markEpisodeWatched}
        className="mt-4"
      />

      {upcoming.length > 0 && (
        <div className="mt-6">
          <h3 className="text-meta text-fg-muted uppercase">Coming soon</h3>
          <UpNextRow
            items={upcoming}
            seasonCountsByShowId={seasonCountsByShowId}
            markEpisodeWatched={markEpisodeWatched}
            className="mt-3"
          />
        </div>
      )}
    </section>
  );
}

function UpNextRow({
  items,
  seasonCountsByShowId,
  markEpisodeWatched,
  className,
}: {
  items: UpNextItem[];
  seasonCountsByShowId: Record<string, SeasonEpisodeCounts>;
  markEpisodeWatched: MarkEpisodeWatched;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "-mx-4 flex snap-x gap-4 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8",
        className,
      )}
    >
      {items.map((item) => (
        // Fixed width lives on this wrapper, not UpNextCard itself — the
        // card is `w-full` so it also works undecorated inside a grid cell
        // (see ContinueWatchingSection).
        <div
          key={episodeCacheKey(item.entry.id, item.seasonNumber)}
          className="w-64 shrink-0 snap-start sm:w-72"
        >
          <UpNextCard
            item={item}
            seasons={seasonCountsByShowId[item.entry.id]}
            markEpisodeWatched={markEpisodeWatched}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * Entry point into `/schedule` (Phase 7) — placed on the Up Next heading row
 * specifically, not Home's page header, because this is the exact moment a
 * visitor is already looking at "what's in progress" and a fuller calendar
 * of what's coming next is the natural next question. Rendered in BOTH of
 * UpNextRail's return branches (empty and populated) so it's discoverable
 * even for someone with nothing "watching" yet but something "watched" that
 * has since aired a new episode — exactly the case Up Next itself can't show.
 */
function ScheduleLink() {
  return (
    <Button href="/schedule" variant="ghost" size="sm">
      Full schedule
    </Button>
  );
}

function UpNextRailSkeleton() {
  return (
    <section role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Loading Up Next</span>
      <Skeleton className="h-7 w-32" />
      <div className="mt-4 flex gap-4 overflow-x-hidden" aria-hidden="true">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="w-64 shrink-0 sm:w-72">
            <Skeleton className="aspect-video w-full rounded-lg" />
            <div className="mt-2 space-y-2">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
