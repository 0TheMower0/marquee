import { Skeleton, SkeletonText } from "@/components/ui/skeleton";

/**
 * Mirrors the detail page's hero geometry — same poster widths at the same
 * breakpoints — so navigating in from a ticket card doesn't shift the layout
 * when the real data lands.
 */
export default function TitleDetailLoading() {
  return (
    <div role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Loading title</span>

      <div className="bg-surface/40 relative">
        <div className="mx-auto flex w-full max-w-7xl gap-4 px-4 pt-8 pb-10 sm:gap-6 sm:px-6 sm:pt-12 lg:px-8">
          <Skeleton className="aspect-[2/3] w-24 shrink-0 rounded-md sm:w-36 lg:w-44" />

          <div className="min-w-0 flex-1 space-y-3 self-end">
            <Skeleton className="h-9 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
            <div className="flex gap-2">
              <Skeleton className="h-6 w-14" />
              <Skeleton className="h-6 w-20" />
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto w-full max-w-7xl px-4 pb-12 sm:px-6 lg:px-8">
        <div className="flex gap-2">
          <Skeleton className="h-6 w-20" />
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-6 w-16" />
        </div>
        <Skeleton className="mt-8 h-6 w-32" />
        <SkeletonText lines={4} className="mt-3 max-w-prose" />
      </div>
    </div>
  );
}
