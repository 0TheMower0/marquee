"use client";

import { Badge } from "@/components/ui/badge";
import type { Season, Title } from "@/lib/content/types";
import {
  getTitleProgress,
  useTracking,
  type SeasonEpisodeCounts,
} from "@/lib/tracking";

/**
 * The "somewhere prominent" show-level progress badge, sitting in the hero
 * next to the rating/status badges rather than buried inside the Seasons
 * tab — so it's visible without a click.
 *
 * A Client Component (needs `useTracking`) rendered from the Server
 * Component hero. `seasons` is fetched once, server-side, in the detail
 * page and passed down here too — computing progress needs only episode
 * COUNTS per season, never the individual episode list, so this never
 * triggers its own fetch.
 */
export function ShowProgressBadge({
  title,
  seasons,
}: {
  title: Title;
  seasons: Season[];
}) {
  const { ready, getEntry } = useTracking();

  // Renders nothing until the initial storage read resolves, rather than
  // flashing "0/62 · 0%" and then popping to the real value a moment later.
  if (!ready) return null;

  const entry = getEntry(title.id, title.mediaType);
  const seasonCounts: SeasonEpisodeCounts = seasons.map((season) => ({
    seasonNumber: season.seasonNumber,
    episodeCount: season.episodeCount,
  }));
  const progress = getTitleProgress(entry, seasonCounts);

  if (progress.totalCount === 0) return null;
  // A show nobody has touched yet: the Seasons tab already says this.
  // Repeating "0/62 · 0%" for every untracked show in the hero is noise,
  // not information.
  if (!entry && progress.watchedCount === 0) return null;

  return (
    <Badge variant="accent">
      {progress.watchedCount} / {progress.totalCount} episodes ·{" "}
      {progress.percentComplete}%
    </Badge>
  );
}
