"use client";

import Link from "next/link";
import { useState } from "react";

import { PosterImage } from "@/components/title/poster-image";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { TitleSummary } from "@/lib/content/types";
import type { SeasonEpisodeCounts, UpNextItem } from "@/lib/tracking";

/**
 * Approximate, same reasoning as POSTER_GRID_SIZES: this card renders at a
 * fixed ~256-288px in the Home rail's scroll slots, but fluidly at up to
 * ~450px in Library's Continue Watching grid (1/2/3 columns). Covers the
 * wider of the two rather than the narrower, since over-requesting a size
 * next/image's own srcset negotiation still bounds is cheaper than a visibly
 * soft image in the grid.
 */
const UP_NEXT_ART_SIZES = "(min-width: 1024px) 320px, (min-width: 640px) 45vw, 90vw";

/**
 * The card shared by every Up Next surface — the Home rail and Library's
 * "Continue Watching" section (Phase 3 Step 4) both render this from the
 * same `useUpNextItems` data, differing only in the container around it
 * (a horizontal scroller vs a grid). Deliberately sized `w-full`, not a
 * fixed width — the rail's per-item wrapper supplies the fixed width for
 * its horizontal-scroll slots; a grid cell supplies its own.
 */

export type MarkEpisodeWatched = (
  summary: TitleSummary,
  seasons: SeasonEpisodeCounts,
  seasonNumber: number,
  episodeNumber: number,
) => Promise<void>;

export function episodeCacheKey(showId: string, seasonNumber: number): string {
  return `${showId}:${seasonNumber}`;
}

function formatMinutes(totalMinutes: number): string {
  if (totalMinutes < 60) return `~${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `~${hours}h` : `~${hours}h ${minutes}m`;
}

export function UpNextCard({
  item,
  seasons,
  markEpisodeWatched,
}: {
  item: UpNextItem;
  seasons: SeasonEpisodeCounts;
  markEpisodeWatched: MarkEpisodeWatched;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { entry, seasonNumber, episodeNumber, episode, label, isRediscovery, signals } = item;
  const summary = entry.summary;
  // Bucket, not a per-card recomputation: the caller already split ready vs
  // upcoming, so an upcoming item's episode is unaired by construction.
  const isUpcoming = signals.airingState === "airing";

  async function handleMarkWatched() {
    setPending(true);
    setError(null);
    try {
      await markEpisodeWatched(summary, seasons, seasonNumber, episodeNumber);
    } catch {
      setError("Couldn't save that change.");
      window.setTimeout(() => setError(null), 3000);
    } finally {
      setPending(false);
    }
  }

  return (
    // Deliberately NOT `ticket-surface`/`ticket-lift` — that mask assumes
    // TicketCard's exact geometry (a 2:3 poster plus a stub pinned to
    // `--ticket-stub` tall) and punches its perforation at a fixed offset
    // from the bottom edge. This card's content area is a different height,
    // so reusing the class landed the perforation mid-title-text instead of
    // on a real seam — caught by looking at the rendered page, same as the
    // tailwind-merge bug CLAUDE.md documents. Plain rounded card instead.
    <article className="bg-surface border-line-subtle w-full overflow-hidden rounded-lg border">
      <Link href={`/title/tv/${summary.id}`} className="block focus-visible:outline-offset-4">
        <div className="relative aspect-video w-full overflow-hidden">
          <PosterImage
            src={summary.posterUrl}
            alt=""
            name={summary.name}
            placeholder={summary.placeholder}
            sizes={UP_NEXT_ART_SIZES}
            initialsClassName="text-[2.5rem]"
          />
          <div className="from-surface/90 absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t to-transparent" />
          {isRediscovery && (
            <Badge variant="secondary" size="sm" className="absolute top-2 left-2">
              Pick this back up?
            </Badge>
          )}
        </div>
      </Link>

      <div className="flex flex-col gap-1.5 p-3">
        <Link href={`/title/tv/${summary.id}`} className="focus-visible:outline-offset-4">
          <h3 className="font-display text-display-sm text-fg truncate uppercase">
            {summary.name}
          </h3>
        </Link>
        <p className="text-meta-sm text-fg-subtle truncate uppercase">
          S{seasonNumber} · E{episodeNumber}
          {episode ? ` — ${episode.name}` : ""}
        </p>
        <p className="text-body-sm text-fg">{label}</p>
        {signals.estimatedMinutesToFinishSeason > 0 && (
          <p className="text-meta-sm text-fg-subtle">
            {formatMinutes(signals.estimatedMinutesToFinishSeason)} to catch up
          </p>
        )}

        {!isUpcoming && (
          <Button
            size="sm"
            variant="primary"
            isLoading={pending}
            disabled={pending}
            onClick={() => void handleMarkWatched()}
            className="mt-1 self-start"
          >
            Mark watched
          </Button>
        )}

        {error && (
          <p role="alert" className="text-danger text-meta-sm">
            {error}
          </p>
        )}
      </div>
    </article>
  );
}
