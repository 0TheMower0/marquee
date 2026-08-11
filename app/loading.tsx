import { SkeletonGrid } from "@/components/ui/skeleton";
import { TITLE_PAGE_SIZE } from "@/lib/utils/grid";

/**
 * Route-level fallback, distinct from the Suspense boundary inside page.tsx.
 *
 * The in-page boundary covers the data fetch on a route that has already
 * rendered. This one covers the navigation itself — the gap before any of
 * Home's markup exists on a cold load or a client-side transition into `/`.
 * It mirrors Home's header so the layout doesn't jump when the real page
 * arrives.
 */
export default function HomeLoading() {
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

      <section className="mt-8">
        <SkeletonGrid count={TITLE_PAGE_SIZE} />
      </section>
    </div>
  );
}
