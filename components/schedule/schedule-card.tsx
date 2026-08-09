"use client";

import Link from "next/link";
import { useState } from "react";

import { PosterImage } from "@/components/title/poster-image";
import type { MarkEpisodeWatched } from "@/components/tracking/up-next-card";
import { Button } from "@/components/ui/button";
import type { SeasonEpisodeCounts } from "@/lib/tracking";
import { formatAirDate } from "@/lib/utils/dates";

import type { ScheduleItem } from "@/lib/schedule";

/** Same footprint reasoning as UP_NEXT_ART_SIZES in up-next-card.tsx — this
 *  card renders in a responsive grid (1/2/3 columns) rather than a fixed
 *  scroll slot, so it covers the wider end of that range. */
const SCHEDULE_ART_SIZES = "(min-width: 1024px) 320px, (min-width: 640px) 45vw, 90vw";

/** "Aug 12" style — `formatAirDate` already produces "Aug 12, 2026"; this
 *  drops the year, which is never useful in a feed that only ever shows the
 *  near future. */
function shortAirDate(airDate: string | null): string | null {
  const formatted = formatAirDate(airDate);
  if (!formatted) return null;
  return formatted.replace(/, \d{4}$/, "");
}

export function ScheduleCard({
  item,
  seasons,
  markEpisodeWatched,
}: {
  item: ScheduleItem;
  seasons: SeasonEpisodeCounts;
  markEpisodeWatched: MarkEpisodeWatched;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { entry, seasonNumber, episodeNumber, episode, bucket } = item;
  const summary = entry.summary;
  const dateLabel = shortAirDate(episode.airDate);

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
    <article className="bg-surface border-line-subtle w-full overflow-hidden rounded-lg border">
      <Link href={`/title/tv/${summary.id}`} className="block focus-visible:outline-offset-4">
        <div className="relative aspect-video w-full overflow-hidden">
          <PosterImage
            src={summary.posterUrl}
            alt=""
            name={summary.name}
            placeholder={summary.placeholder}
            sizes={SCHEDULE_ART_SIZES}
            initialsClassName="text-[2.5rem]"
          />
          <div className="from-surface/90 absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t to-transparent" />
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
          {episode.name ? ` — ${episode.name}` : ""}
        </p>
        <p className="text-body-sm text-fg">
          {bucket === "ready"
            ? dateLabel
              ? `Aired ${dateLabel} — not yet watched`
              : "Ready to watch"
            : dateLabel
              ? `Airs ${dateLabel}`
              : "Air date not yet announced"}
        </p>

        {bucket === "ready" && (
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
