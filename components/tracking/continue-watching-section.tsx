"use client";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SearchIcon } from "@/components/ui/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils/cn";

import { episodeCacheKey, UpNextCard } from "./up-next-card";
import { useUpNextItems } from "./use-up-next-items";

const GRID_CLASS = "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3";

/**
 * Library's fuller, untruncated view of the same Up Next engine that powers
 * the Home rail (Phase 3 Step 4) — same `useUpNextItems` data and the same
 * `UpNextCard`, a responsive grid instead of a horizontal scroller since
 * this page has the room a Home rail doesn't.
 *
 * Unlike the Home rail's empty state, this one offers BOTH Search and
 * Trending: Library has neither visible nearby, where Home already has
 * Trending one scroll down.
 */
export function ContinueWatchingSection() {
  const { settled, hasWatchingShows, ready, upcoming, seasonCountsByShowId, markEpisodeWatched } =
    useUpNextItems();

  if (!settled) return hasWatchingShows ? <ContinueWatchingSkeleton /> : null;

  const nothingToShow = ready.length === 0 && upcoming.length === 0;

  if (!hasWatchingShows || nothingToShow) {
    return (
      <EmptyState
        icon={<SearchIcon />}
        title="Nothing in progress"
        body="Shows you're watching will show up here, with what's next already queued up."
        className="py-8"
        action={
          <>
            <Button href="/search" variant="outline" size="sm">
              Search titles
            </Button>
            <Button href="/" variant="outline" size="sm">
              Browse trending
            </Button>
          </>
        }
      />
    );
  }

  return (
    <div className="mt-4 space-y-6">
      <div className={GRID_CLASS}>
        {ready.map((item) => (
          <UpNextCard
            key={episodeCacheKey(item.entry.id, item.seasonNumber)}
            item={item}
            seasons={seasonCountsByShowId[item.entry.id]}
            markEpisodeWatched={markEpisodeWatched}
          />
        ))}
      </div>

      {upcoming.length > 0 && (
        <div>
          <h3 className="text-meta text-fg-muted uppercase">Coming soon</h3>
          <div className={cn(GRID_CLASS, "mt-3")}>
            {upcoming.map((item) => (
              <UpNextCard
                key={episodeCacheKey(item.entry.id, item.seasonNumber)}
                item={item}
                seasons={seasonCountsByShowId[item.entry.id]}
                markEpisodeWatched={markEpisodeWatched}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ContinueWatchingSkeleton() {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="mt-4">
      <span className="sr-only">Loading Continue Watching</span>
      <div className={GRID_CLASS} aria-hidden="true">
        {Array.from({ length: 3 }, (_, i) => (
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
