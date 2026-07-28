import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils/cn";

/**
 * Loading placeholder.
 *
 * `motion-safe:animate-pulse` rather than a bare `animate-pulse`: under
 * reduced-motion the global rule in globals.css would already collapse the
 * duration, but that leaves a pulsing element frozen at whatever opacity the
 * keyframe happened to start on. Gating the animation entirely keeps it at a
 * steady, legible tone instead.
 *
 * Marked aria-hidden and paired with an aria-live status message at the
 * container level (see SkeletonGrid) so screen readers hear "Loading…" once,
 * not a dozen meaningless empty boxes.
 */
export function Skeleton({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn("bg-overlay rounded-sm motion-safe:animate-pulse", className)}
      {...rest}
    />
  );
}

export function SkeletonText({
  lines = 3,
  className,
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          key={i}
          className={cn(
            "h-3",
            // Ragged final line reads as text rather than as a solid block.
            i === lines - 1 ? "w-3/5" : "w-full",
          )}
        />
      ))}
    </div>
  );
}

/**
 * Mirrors TicketCard's geometry — 2:3 art area plus a stub of exactly
 * `--ticket-stub` height — so the grid doesn't reflow when real data lands.
 */
export function TicketCardSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("bg-surface ticket-surface overflow-hidden rounded-lg", className)}>
      <Skeleton className="aspect-[2/3] w-full rounded-none" />
      <div className="flex h-[var(--ticket-stub)] flex-col justify-center gap-2 px-3">
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-2.5 w-3/5" />
      </div>
    </div>
  );
}

/**
 * The announcing wrapper. One polite live region for the whole grid.
 */
export function SkeletonGrid({
  count = 10,
  label = "Loading titles",
  className,
}: {
  count?: number;
  label?: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={cn(
        "grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5",
        className,
      )}
    >
      <span className="sr-only">{label}</span>
      {Array.from({ length: count }, (_, i) => (
        <TicketCardSkeleton key={i} />
      ))}
    </div>
  );
}
