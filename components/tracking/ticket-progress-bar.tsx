"use client";

import { useEffect, useRef, useState } from "react";

import { ProgressBar } from "@/components/tracking/progress-bar";
import { httpProvider } from "@/lib/content/http";
import type { TitleSummary } from "@/lib/content/types";
import { getTitleProgress, useTracking, type SeasonEpisodeCounts } from "@/lib/tracking";
import { cn } from "@/lib/utils/cn";

/**
 * TicketCard's other tracking-aware overlay (the corner badge in
 * `tracking-badge.tsx` is the first) — a thin progress bar for shows marked
 * "watching", so a dense grid can show "how far along" without a click.
 *
 * Deliberately NOT inside `.ticket-surface`: that mask is geometry-locked to
 * TicketCard's own notches/perforation, and reusing it — not just its
 * classes but anything relying on its exact offsets — on a shape it wasn't
 * measured for already garbled the up-next card once (see the comment in
 * `up-next-card.tsx`). This bar is instead an absolute sibling of the masked
 * surface, layered on top (z-10, same pattern as `TrackingBadge`) and offset
 * from `--ticket-stub` rather than placed inside it, so it can never be
 * clipped by or collide with the mask.
 *
 * `getSeasons` only — a percentage needs episode COUNTS, not per-episode
 * identity, and `getTitleProgress` already accepts just
 * `SeasonEpisodeCounts`. No episode-level fetch, unlike the Up Next engine.
 */
export function TicketProgressBar({
  title,
  className,
}: {
  title: TitleSummary;
  className?: string;
}) {
  const { ready, getEntry } = useTracking();
  const entry = ready ? getEntry(title.id, title.mediaType) : undefined;
  const isWatching = title.mediaType === "tv" && entry?.status === "watching";

  const [seasons, setSeasons] = useState<SeasonEpisodeCounts | null>(null);
  const requested = useRef(false);

  useEffect(() => {
    if (!isWatching || requested.current) return;
    requested.current = true;
    httpProvider.getSeasons(title.id).then(
      (result) =>
        setSeasons(
          result.map((season) => ({
            seasonNumber: season.seasonNumber,
            episodeCount: season.episodeCount,
          })),
        ),
      // A failed fetch just means no progress bar renders — not worth an
      // error state on a decorative overlay in a dense grid.
      () => {},
    );
  }, [isWatching, title.id]);

  if (!isWatching || !seasons) return null;

  const progress = getTitleProgress(entry, seasons);
  if (progress.totalCount === 0) return null;

  return (
    <div
      className={cn("absolute inset-x-2 z-10", className)}
      style={{ bottom: "calc(var(--ticket-stub) + 0.5rem)" }}
    >
      <ProgressBar percent={progress.percentComplete} />
    </div>
  );
}
