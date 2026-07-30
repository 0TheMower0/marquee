"use client";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { CompassIcon } from "@/components/ui/icons";
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
  const { settled, hasWatchingShows, ready, upcoming, seasonCountsByShowId, markEpisodeWatched } =
    useUpNextItems();

  // Nothing tracked yet AND still loading both read as "no watching shows"
  // here — see the doc comment on `hasWatchingShows` in the hook for why
  // that's the correct read rather than an ambiguous one.
  if (!settled) return hasWatchingShows ? <UpNextRailSkeleton /> : null;

  const nothingToShow = ready.length === 0 && upcoming.length === 0;

  if (!hasWatchingShows || nothingToShow) {
    return (
      <section aria-labelledby="up-next-heading">
        <h2 id="up-next-heading" className="font-display text-display-lg text-fg uppercase">
          Up Next
        </h2>
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
      <h2 id="up-next-heading" className="font-display text-display-lg text-fg uppercase">
        Up Next
      </h2>

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
