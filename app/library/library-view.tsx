"use client";

import { useState, type ReactNode } from "react";

import { ContinueWatchingSection } from "@/components/tracking/continue-watching-section";
import { TitleGrid } from "@/components/title/title-grid";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SearchIcon } from "@/components/ui/icons";
import { SkeletonGrid } from "@/components/ui/skeleton";
import { useRatings } from "@/lib/ratings";
import { useTracking } from "@/lib/tracking";
import type { TrackingEntry, TrackingStatus } from "@/lib/tracking";
import { cn } from "@/lib/utils/cn";

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

type WatchedFilter = "all" | "rated";

/**
 * Two-way toggle, styled like TrackingActions' status buttons rather than
 * introducing a new control shape for one binary choice.
 */
function RatedFilterToggle({
  value,
  onChange,
}: {
  value: WatchedFilter;
  onChange: (value: WatchedFilter) => void;
}) {
  const options: { value: WatchedFilter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "rated", label: "Rated" },
  ];

  return (
    <div role="group" aria-label="Filter watched titles" className="flex gap-1.5">
      {options.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "font-display rounded-sm border px-2.5 py-1 text-display-sm uppercase transition-colors",
              active
                ? "bg-accent text-on-accent border-transparent"
                : "bg-transparent text-fg-muted border-line hover:bg-overlay hover:text-fg",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function StatusSection({
  section,
  allEntries,
  filter,
  filterControl,
  emptyOverride,
}: {
  section: (typeof SECTIONS)[number];
  allEntries: TrackingEntry[];
  /** Optional additional predicate, applied after the status filter. Used by
   *  the Watched section for the "Rated" toggle — Watchlist has none. */
  filter?: (entry: TrackingEntry) => boolean;
  /** Rendered beside the heading. Only the Watched section has one. */
  filterControl?: ReactNode;
  /** Overrides the section's default empty-state copy — used when a FILTER,
   *  not the underlying data, is why nothing is showing ("no rated titles"
   *  reads very differently from "nothing watched yet"). */
  emptyOverride?: { title: string; body: string };
}) {
  const items = allEntries
    .filter((entry) => entry.status === section.status)
    .filter((entry) => (filter ? filter(entry) : true))
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .map((entry) => entry.summary);

  return (
    <section aria-labelledby={`${section.status}-heading`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2
          id={`${section.status}-heading`}
          className="font-display text-display-md text-fg uppercase"
        >
          {section.label}
        </h2>
        {filterControl}
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={<SearchIcon />}
          title={emptyOverride?.title ?? section.emptyTitle}
          body={emptyOverride?.body ?? section.emptyBody}
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
  const { ready, loadFailed, entries } = useTracking();
  // Ratings hydrates independently and does NOT gate the page — it's a local
  // read that resolves within a tick, same reasoning as `ready` itself. Until
  // it resolves, the Watched section simply renders unfiltered (`filter`
  // stays undefined below) rather than waiting on a second readiness flag.
  const { ready: ratingsReady, getEntry: getRatingEntry } = useRatings();
  const [watchedFilter, setWatchedFilter] = useState<WatchedFilter>("all");

  if (!ready) {
    return <SkeletonGrid count={5} label="Loading your library" className="p-6 sm:p-8" />;
  }

  // An empty library and an unreadable one look identical, and mean opposite
  // things. Saying "nothing here yet" to someone whose data simply could not
  // be read is the single most alarming thing this page can do — especially to
  // a signed-in user, who would reasonably conclude their account lost it.
  if (loadFailed) {
    return (
      <div className="p-6 sm:p-8">
        <h1 className="font-display text-display-lg text-fg uppercase">My Library</h1>
        <div
          role="alert"
          className="border-danger/40 bg-danger/10 mt-6 max-w-prose space-y-2 rounded-md border px-4 py-3"
        >
          <p className="text-body-sm text-fg font-medium">
            Couldn&rsquo;t read your library from this browser
          </p>
          <p className="text-meta text-fg-muted">
            This is a problem reading local storage, not a sign that anything
            was deleted. Nothing has been lost or overwritten — reloading, or
            opening Marquee in a normal (non-private) window, usually fixes it.
          </p>
        </div>
      </div>
    );
  }

  const all = Object.values(entries);

  const isRated = (entry: TrackingEntry) =>
    (getRatingEntry(entry.id, entry.mediaType)?.score ?? null) !== null;

  return (
    <div className="space-y-10 p-6 sm:p-8">
      <div className="flex flex-wrap justify-end gap-2">
        {/* Phase 7 Step 1 — Import lives on Library rather than Profile, even
            though it is arguably a data-management action and Profile is where
            the account card and diagnostics panel sit. Discovery beats
            taxonomy here: the moment someone most needs an importer is the
            moment they are looking at a library that does not yet have their
            history in it, and that moment happens on THIS page. */}
        <Button href="/import" variant="ghost" size="sm">
          Import
        </Button>
        {/* Phase 6 Step 6b — shared lists live at their own route rather than
            as a third tracking-status section here: a list isn't a tracking
            state, it's a named, shareable collection that can hold titles
            regardless of anyone's watched status. */}
        <Button href="/lists" variant="outline" size="sm">
          My lists
        </Button>
      </div>

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

      <StatusSection
        section={SECTIONS[1]}
        allEntries={all}
        filter={ratingsReady && watchedFilter === "rated" ? isRated : undefined}
        filterControl={
          ratingsReady ? (
            <RatedFilterToggle value={watchedFilter} onChange={setWatchedFilter} />
          ) : undefined
        }
        emptyOverride={
          watchedFilter === "rated"
            ? {
                title: "No rated titles yet",
                body: "Rate a watched title from its detail page and it'll show up here.",
              }
            : undefined
        }
      />
    </div>
  );
}
