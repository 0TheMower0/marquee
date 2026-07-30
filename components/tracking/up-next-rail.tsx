"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { httpProvider } from "@/lib/content/http";
import type { Episode, Season, TitleSummary } from "@/lib/content/types";
import {
  buildUpNextItem,
  rankUpNext,
  selectUpNextCandidates,
  useTracking,
  type SeasonEpisodeCounts,
  type UpNextItem,
} from "@/lib/tracking";
import { cn } from "@/lib/utils/cn";
import { initialsFor } from "@/lib/utils/initials";

/**
 * The "continue watching" rail for Home — Phase 3 Step 3, the Up Next engine.
 *
 * A Client Component (needs `useTracking`), fetching through `httpProvider`
 * (never `getContentProvider`, which is server-only). Two fetch stages, each
 * guarded by a ref-based "already requested" set rather than checking
 * `useState` inside the effect body — a fetch triggered as a side effect of
 * a `setState` updater would double-fire under Strict Mode's purity check:
 *
 *   1. `getSeasons(showId)` for every TV show tracked as "watching" —
 *      enough to compute each show's next-unwatched episode via the pure
 *      `selectUpNextCandidates`.
 *   2. `getSeasonEpisodes(showId, seasonNumber)` for just the ONE season
 *      each candidate's next-unwatched episode falls in — enough for
 *      `buildUpNextItem` to know whether that episode has aired.
 *
 * Ranking (`buildUpNextItem` + `rankUpNext`) only runs once every candidate's
 * stage-2 fetch has settled (ready or error) — building it earlier would let
 * a card visibly jump between the "ready" and "coming soon" buckets (and its
 * score with it) the moment the real air date arrives.
 */

type SeasonsCacheEntry =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; seasons: Season[] };

type EpisodesCacheEntry =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; episodes: Episode[] };

type MarkEpisodeWatched = (
  summary: TitleSummary,
  seasons: SeasonEpisodeCounts,
  seasonNumber: number,
  episodeNumber: number,
) => Promise<void>;

function episodeCacheKey(showId: string, seasonNumber: number): string {
  return `${showId}:${seasonNumber}`;
}

export function UpNextRail() {
  const { ready, entries, markEpisodeWatched } = useTracking();

  const watchingIds = useMemo(
    () =>
      Object.values(entries)
        .filter((entry) => entry.mediaType === "tv" && entry.status === "watching")
        .map((entry) => entry.id),
    [entries],
  );

  const [seasonsCache, setSeasonsCache] = useState<Record<string, SeasonsCacheEntry>>({});
  const requestedSeasons = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!ready) return;
    for (const id of watchingIds) {
      if (requestedSeasons.current.has(id)) continue;
      requestedSeasons.current.add(id);
      setSeasonsCache((prev) => ({ ...prev, [id]: { status: "loading" } }));
      httpProvider.getSeasons(id).then(
        (seasons) =>
          setSeasonsCache((prev) => ({ ...prev, [id]: { status: "ready", seasons } })),
        () => setSeasonsCache((prev) => ({ ...prev, [id]: { status: "error" } })),
      );
    }
  }, [ready, watchingIds]);

  const seasonCountsByShowId = useMemo(() => {
    const out: Record<string, SeasonEpisodeCounts> = {};
    for (const [id, cacheEntry] of Object.entries(seasonsCache)) {
      if (cacheEntry.status === "ready") {
        out[id] = cacheEntry.seasons.map((season) => ({
          seasonNumber: season.seasonNumber,
          episodeCount: season.episodeCount,
        }));
      }
    }
    return out;
  }, [seasonsCache]);

  const candidates = useMemo(
    () => selectUpNextCandidates(entries, seasonCountsByShowId),
    [entries, seasonCountsByShowId],
  );

  const [episodesCache, setEpisodesCache] = useState<Record<string, EpisodesCacheEntry>>({});
  const requestedEpisodes = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const candidate of candidates) {
      const key = episodeCacheKey(candidate.entry.id, candidate.seasonNumber);
      if (requestedEpisodes.current.has(key)) continue;
      requestedEpisodes.current.add(key);
      setEpisodesCache((prev) => ({ ...prev, [key]: { status: "loading" } }));
      httpProvider.getSeasonEpisodes(candidate.entry.id, candidate.seasonNumber).then(
        (episodes) =>
          setEpisodesCache((prev) => ({ ...prev, [key]: { status: "ready", episodes } })),
        () => setEpisodesCache((prev) => ({ ...prev, [key]: { status: "error" } })),
      );
    }
  }, [candidates]);

  if (!ready || watchingIds.length === 0) return null;

  const seasonsSettling = watchingIds.some((id) => {
    const cacheEntry = seasonsCache[id];
    return !cacheEntry || cacheEntry.status === "loading";
  });
  const episodesSettling = candidates.some((candidate) => {
    const cacheEntry = episodesCache[episodeCacheKey(candidate.entry.id, candidate.seasonNumber)];
    return !cacheEntry || cacheEntry.status === "loading";
  });

  if (seasonsSettling || episodesSettling) return <UpNextRailSkeleton />;

  const items: UpNextItem[] = candidates.map((candidate) => {
    const key = episodeCacheKey(candidate.entry.id, candidate.seasonNumber);
    const cacheEntry = episodesCache[key];
    const episodes = cacheEntry?.status === "ready" ? cacheEntry.episodes : null;
    return buildUpNextItem(candidate, seasonCountsByShowId[candidate.entry.id], episodes);
  });

  const { ready: readyItems, upcoming: upcomingItems } = rankUpNext(items);

  if (readyItems.length === 0 && upcomingItems.length === 0) return null;

  return (
    <section aria-labelledby="up-next-heading">
      <h2 id="up-next-heading" className="font-display text-display-lg text-fg uppercase">
        Up Next
      </h2>

      <UpNextRow
        items={readyItems}
        seasonCountsByShowId={seasonCountsByShowId}
        markEpisodeWatched={markEpisodeWatched}
        className="mt-4"
      />

      {upcomingItems.length > 0 && (
        <div className="mt-6">
          <h3 className="text-meta text-fg-muted uppercase">Coming soon</h3>
          <UpNextRow
            items={upcomingItems}
            seasonCountsByShowId={seasonCountsByShowId}
            markEpisodeWatched={markEpisodeWatched}
            className="mt-3"
          />
        </div>
      )}
    </section>
  );
}

function UpNextRow({
  items,
  seasonCountsByShowId,
  markEpisodeWatched,
  className,
}: {
  items: UpNextItem[];
  seasonCountsByShowId: Record<string, SeasonEpisodeCounts>;
  markEpisodeWatched: MarkEpisodeWatched;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "-mx-4 flex snap-x gap-4 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8",
        className,
      )}
    >
      {items.map((item) => (
        <UpNextCard
          key={episodeCacheKey(item.entry.id, item.seasonNumber)}
          item={item}
          seasons={seasonCountsByShowId[item.entry.id]}
          markEpisodeWatched={markEpisodeWatched}
        />
      ))}
    </div>
  );
}

function formatMinutes(totalMinutes: number): string {
  if (totalMinutes < 60) return `~${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `~${hours}h` : `~${hours}h ${minutes}m`;
}

function UpNextCard({
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
  // Bucket, not a per-card recomputation: the parent already split ready vs
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
    <article className="bg-surface border-line-subtle w-64 shrink-0 snap-start overflow-hidden rounded-lg border sm:w-72">
      <Link href={`/title/tv/${summary.id}`} className="block focus-visible:outline-offset-4">
        <div
          className="relative aspect-video w-full overflow-hidden"
          style={{
            backgroundImage: `linear-gradient(145deg, ${summary.placeholder.gradientFrom}, ${summary.placeholder.gradientTo})`,
          }}
        >
          <span
            aria-hidden="true"
            className="font-display absolute inset-0 flex items-center justify-center text-[2.5rem] leading-none text-white/20 select-none"
          >
            {initialsFor(summary.name)}
          </span>
          {summary.posterUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={summary.posterUrl}
              alt=""
              loading="lazy"
              decoding="async"
              className="absolute inset-0 size-full object-cover"
            />
          )}
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

function UpNextRailSkeleton() {
  return (
    <section role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Loading Up Next</span>
      <Skeleton className="h-7 w-32" />
      <div className="mt-4 flex gap-4 overflow-x-hidden" aria-hidden="true">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="w-64 shrink-0 sm:w-72">
            <Skeleton className="aspect-video w-full rounded-lg" />
            <div className="mt-2 space-y-2">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
