"use client";

import { ContinueWatchingSection } from "@/components/tracking/continue-watching-section";
import { TitleGrid } from "@/components/title/title-grid";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SearchIcon } from "@/components/ui/icons";
import { SkeletonGrid } from "@/components/ui/skeleton";
import { useTracking } from "@/lib/tracking";
import type { TrackingEntry, TrackingStatus } from "@/lib/tracking";

/**
 * Watchlist and Watched are plain status grids. "Watching" isn't listed
 * here — Phase 3 Step 4 replaced that plain grid with `ContinueWatchingSection`,
 * the same Up Next engine that powers the Home rail, rendered in full rather
 * than truncated to a rail. See `LibraryView` below for where it's placed.
 */
const SECTIONS: {
  status: TrackingStatus;
  label: string;
  emptyTitle: string;
  emptyBody: string;
}[] = [
  {
    status: "watchlist",
    label: "Watchlist",
    emptyTitle: "Nothing on your watchlist",
    emptyBody: "Titles you plan to watch will show up here.",
  },
  {
    status: "watched",
    label: "Watched",
    emptyTitle: "Nothing watched yet",
    emptyBody: "Titles you mark as watched will show up here.",
  },
];

function StatusSection({
  section,
  allEntries,
}: {
  section: (typeof SECTIONS)[number];
  allEntries: TrackingEntry[];
}) {
  const items = allEntries
    .filter((entry) => entry.status === section.status)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .map((entry) => entry.summary);

  return (
    <section aria-labelledby={`${section.status}-heading`}>
      <h2
        id={`${section.status}-heading`}
        className="font-display text-display-md text-fg uppercase"
      >
        {section.label}
      </h2>

      {items.length === 0 ? (
        <EmptyState
          icon={<SearchIcon />}
          title={section.emptyTitle}
          body={section.emptyBody}
          className="py-8"
          action={
            <Button href="/search" variant="outline" size="sm">
              Search titles
            </Button>
          }
        />
      ) : (
        <TitleGrid titles={items} label={`${section.label} titles`} className="mt-4" />
      )}
    </section>
  );
}

/**
 * Client-rendered, deliberately: tracking data lives only in this browser's
 * storage, so there is nothing for a server render to fetch. Kept free of any
 * server-supplied props for the same reason a similar harness broke in
 * Phase 2 Step 1 — see the note on hydration in that step's writeup.
 */
export function LibraryView() {
  const { ready, entries } = useTracking();

  if (!ready) {
    return <SkeletonGrid count={5} label="Loading your library" className="p-6 sm:p-8" />;
  }

  const all = Object.values(entries);

  return (
    <div className="space-y-10 p-6 sm:p-8">
      <StatusSection section={SECTIONS[0]} allEntries={all} />

      {/* Sits where a plain "Watching" grid used to — same position in the
          page, same three-section rhythm (Watchlist / Watching / Watched),
          richer content. */}
      <section aria-labelledby="watching-heading">
        <h2 id="watching-heading" className="font-display text-display-md text-fg uppercase">
          Continue Watching
        </h2>
        <ContinueWatchingSection />
      </section>

      <StatusSection section={SECTIONS[1]} allEntries={all} />
    </div>
  );
}
