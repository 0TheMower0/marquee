import { Suspense } from "react";

import { ContentErrorState } from "@/components/content/content-error-state";
import { TitleGrid } from "@/components/title/title-grid";
import { EmptyState } from "@/components/ui/empty-state";
import { CompassIcon } from "@/components/ui/icons";
import { SkeletonGrid } from "@/components/ui/skeleton";
import { getContentProvider } from "@/lib/content";
import { ContentError } from "@/lib/content/errors";
import type { PagedResult, TitleSummary } from "@/lib/content/types";

/**
 * `mediaType: "all"` on purpose. Films and series share one rail rather than
 * sitting behind a tab choice — the whole pitch of Marquee is that it doesn't
 * make you pick which of the two you're tracking today.
 */
async function TrendingGrid() {
  let trending: PagedResult<TitleSummary>;

  // Only the await belongs inside the try. Building JSX in here would be a
  // trap: React doesn't render the returned element until after this function
  // has already returned, so a render error inside TitleGrid would sail past
  // this catch — the error boundary in error.tsx is what handles those.
  // (eslint's react-hooks/error-boundaries enforces exactly this.)
  try {
    trending = await getContentProvider().getTrending("all");
  } catch (error) {
    // Providers are contractually allowed to throw only ContentError, so a
    // ContentError is an *expected* failure with known, kind-specific copy.
    // Anything else is a bug — rethrow it to error.tsx rather than dressing it
    // up as a content problem.
    if (error instanceof ContentError) {
      return <ContentErrorState kind={error.kind} />;
    }
    throw error;
  }

  if (trending.items.length === 0) {
    return (
      <EmptyState
        icon={<CompassIcon />}
        title="Nothing trending"
        body="The content source returned no results. That's unusual — try again in a moment."
      />
    );
  }

  return (
    <TitleGrid
      titles={trending.items}
      label="Trending titles"
      // Roughly the first visible row across breakpoints (2 cols at 375px,
      // 5 at xl); everything after stays lazy.
      priorityCount={5}
    />
  );
}

export default function HomePage() {
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <header>
        <h1 className="font-display text-display-xl text-fg uppercase">
          Trending now
        </h1>
        <p className="text-body text-fg-muted mt-1 max-w-prose">
          Films and series people are watching this week — in one place, not two
          apps.
        </p>
      </header>

      {/* The header paints immediately and the grid streams in behind it.
          Without this boundary the whole route would block on the provider,
          including in mock mode, which simulates latency deliberately. */}
      <section className="mt-8">
        <Suspense fallback={<SkeletonGrid count={10} />}>
          <TrendingGrid />
        </Suspense>
      </section>
    </div>
  );
}
