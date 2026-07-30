"use client";

import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ChevronDownIcon,
  CheckIcon,
  SkipToIcon,
  SpinnerIcon,
} from "@/components/ui/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { httpProvider } from "@/lib/content/http";
import type { Episode, Season, Title } from "@/lib/content/types";
import {
  getSeasonProgress,
  getTitleProgress,
  isEpisodeWatched,
  reconcileCoarseWatched,
  toTrackingSummary,
  useTracking,
  type SeasonEpisodeCounts,
  type WatchedEpisodes,
} from "@/lib/tracking";
import { formatAirDate, isFutureAirDate } from "@/lib/utils/dates";
import { cn } from "@/lib/utils/cn";

import { ProgressBar } from "./progress-bar";

/**
 * The Seasons tab: show-level progress, then an accordion of seasons.
 *
 * ONLY ONE SEASON'S EPISODES ARE EVER MOUNTED AT A TIME. That's what keeps
 * an 8-, 9-, or 20-season show from becoming an unusable wall — every
 * season's collapsed row is cheap (a name, a progress bar, one button), and
 * episode lists — the expensive part, with a fetch and potentially dozens of
 * rows — exist for at most one season. Collapsed seasons cost nothing beyond
 * the progress bar, which is computed from the season list alone (episode
 * COUNTS, not the episodes themselves), so nothing is fetched until a season
 * is actually opened.
 *
 * Season 0 (Specials) sorts LAST, after every numbered season — it's bonus
 * content, not the next thing after the finale — and is excluded from the
 * show-level aggregate (see getTitleProgress), though its own row still
 * reports honest progress.
 */

type EpisodeCacheEntry =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; episodes: Episode[] };

function sortForDisplay(seasons: Season[]): Season[] {
  return [...seasons].sort((a, b) => {
    if (a.seasonNumber === 0) return 1;
    if (b.seasonNumber === 0) return -1;
    return a.seasonNumber - b.seasonNumber;
  });
}

export function SeasonList({ title, seasons }: { title: Title; seasons: Season[] }) {
  const {
    ready,
    getEntry,
    markEpisodeWatched,
    unmarkEpisodeWatched,
    markSeasonWatched,
    unmarkSeasonWatched,
    markWatchedUpToEpisode,
    markSeasonWatchedUpTo,
  } = useTracking();

  const [expandedSeason, setExpandedSeason] = useState<number | null>(null);
  const [episodeCache, setEpisodeCache] = useState<
    Record<number, EpisodeCacheEntry>
  >({});
  // Keyed "s{season}:ep:{n}" / "s{season}:upto:{n}" / "s{season}:season" —
  // see isSeasonBusy below for why the season number is embedded in the key.
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const summary = toTrackingSummary(title);
  const entry = getEntry(title.id, title.mediaType);
  const seasonCounts: SeasonEpisodeCounts = seasons.map((season) => ({
    seasonNumber: season.seasonNumber,
    episodeCount: season.episodeCount,
  }));

  // Reconciled once here for DISPLAY (per-season/per-episode watched state).
  // Mutations don't need this passed in — applyEpisodeMutation in
  // context.tsx reconciles again internally before editing.
  const watched: WatchedEpisodes =
    entry?.mediaType === "tv" ? reconcileCoarseWatched(entry, seasonCounts) : {};

  const showProgress = getTitleProgress(entry, seasonCounts);

  // A single write to one season's ranges can, in principle, race a second
  // write to a DIFFERENT control on the SAME show (context.tsx's rollback
  // snapshot is captured at call time — see the concurrency note there).
  // Scoping "busy" to the whole season rather than just the one control
  // being clicked closes that window for the common case: no two controls
  // within the same season can ever be in flight at once.
  function isSeasonBusy(seasonNumber: number): boolean {
    const prefix = `s${seasonNumber}:`;
    for (const key of pendingKeys) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  async function runAction(key: string, action: () => Promise<void>) {
    setPendingKeys((prev) => new Set(prev).add(key));
    setError(null);
    try {
      await action();
    } catch {
      setError("Couldn't save that change. Please try again.");
      window.setTimeout(() => setError(null), 3000);
    } finally {
      setPendingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  /**
   * Fetches and caches a season's episodes if they aren't already cached,
   * then returns them. Shared by expand-to-view (below) and "mark season
   * watched" (further below) — the latter needs the real per-episode air
   * dates too, not just a count, to know where to stop. Returns `null` on
   * fetch failure; the caller decides how to degrade.
   */
  async function ensureEpisodesLoaded(seasonNumber: number): Promise<Episode[] | null> {
    const cached = episodeCache[seasonNumber];
    if (cached?.status === "ready") return cached.episodes;

    setEpisodeCache((prev) => ({ ...prev, [seasonNumber]: { status: "loading" } }));
    try {
      const episodes = await httpProvider.getSeasonEpisodes(title.id, seasonNumber);
      setEpisodeCache((prev) => ({
        ...prev,
        [seasonNumber]: { status: "ready", episodes },
      }));
      return episodes;
    } catch {
      setEpisodeCache((prev) => ({ ...prev, [seasonNumber]: { status: "error" } }));
      return null;
    }
  }

  function toggleExpand(seasonNumber: number) {
    if (expandedSeason === seasonNumber) {
      setExpandedSeason(null);
      return;
    }
    setExpandedSeason(seasonNumber);
    void ensureEpisodesLoaded(seasonNumber);
  }

  /**
   * "Mark season watched" must not silently mark an unaired episode
   * watched — the same rule the per-episode toggle enforces. The pure
   * `markSeason` in lib/tracking/progress.ts has no concept of air dates
   * (it only ever sees episode COUNTS, never Episode objects), so that
   * check has to happen here, where the real episode list is available.
   *
   * If any cached-or-fetched episode in the season hasn't aired yet, this
   * marks up to the last AIRED episode instead of the whole season. A
   * season whose episodes can't be loaded (fetch failure) falls back to the
   * count-based `markSeasonWatched` — degrading to the old behavior rather
   * than blocking the action entirely.
   */
  async function handleToggleSeason(seasonNumber: number, isComplete: boolean) {
    if (isComplete) {
      await unmarkSeasonWatched(summary, seasonCounts, seasonNumber);
      return;
    }

    const episodes = await ensureEpisodesLoaded(seasonNumber);
    const lastAired = episodes
      ?.filter((episode) => !isFutureAirDate(episode.airDate))
      .reduce((max, episode) => Math.max(max, episode.episodeNumber), 0);

    if (episodes && lastAired !== undefined && lastAired < episodes.length) {
      if (lastAired === 0) return; // nothing in this season has aired yet
      // Season-scoped on purpose — see the note on markSeasonWatchedUpTo.
      // The cross-season markWatchedUpToEpisode would incorrectly also mark
      // every PRIOR season fully as a side effect of this button.
      await markSeasonWatchedUpTo(summary, seasonCounts, seasonNumber, lastAired);
      return;
    }

    await markSeasonWatched(summary, seasonCounts, seasonNumber);
  }

  function handleToggleEpisode(
    seasonNumber: number,
    episodeNumber: number,
    currentlyWatched: boolean,
  ) {
    void runAction(`s${seasonNumber}:ep:${episodeNumber}`, () =>
      currentlyWatched
        ? unmarkEpisodeWatched(summary, seasonCounts, seasonNumber, episodeNumber)
        : markEpisodeWatched(summary, seasonCounts, seasonNumber, episodeNumber),
    );
  }

  function handleMarkUpTo(seasonNumber: number, episodeNumber: number) {
    void runAction(`s${seasonNumber}:upto:${episodeNumber}`, () =>
      markWatchedUpToEpisode(summary, seasonCounts, seasonNumber, episodeNumber),
    );
  }

  return (
    <div>
      {showProgress.totalCount > 0 && (
        <div className="mb-6">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-body text-fg">
              {showProgress.watchedCount} / {showProgress.totalCount} episodes
            </p>
            <p className="text-meta text-fg-muted shrink-0">
              {showProgress.percentComplete}%
            </p>
          </div>
          <ProgressBar percent={showProgress.percentComplete} className="mt-2" />
        </div>
      )}

      {sortForDisplay(seasons).map((season) => {
        const progress = getSeasonProgress(
          watched,
          season.seasonNumber,
          season.episodeCount,
        );
        const isExpanded = expandedSeason === season.seasonNumber;
        const busy = isSeasonBusy(season.seasonNumber);

        return (
          <div
            key={season.seasonNumber}
            className="border-line-subtle border-b py-3 last:border-b-0"
          >
            <button
              type="button"
              onClick={() => toggleExpand(season.seasonNumber)}
              aria-expanded={isExpanded}
              className="flex w-full items-start gap-3 text-left"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="font-display text-display-sm text-fg truncate uppercase">
                    {season.name}
                  </h3>
                  {season.seasonNumber === 0 && (
                    <Badge size="sm" variant="outline" className="shrink-0">
                      Not counted
                    </Badge>
                  )}
                </div>
                {progress.totalCount > 0 && (
                  <>
                    <p className="text-meta-sm text-fg-muted mt-0.5">
                      {progress.watchedCount}/{progress.totalCount} watched ·{" "}
                      {progress.percentComplete}%
                    </p>
                    <ProgressBar percent={progress.percentComplete} className="mt-1.5" />
                  </>
                )}
              </div>
              <ChevronDownIcon
                className={cn(
                  "text-fg-subtle mt-1 size-5 shrink-0 transition-transform motion-safe:duration-[--dur-base]",
                  isExpanded && "rotate-180",
                )}
              />
            </button>

            {progress.totalCount > 0 && (
              <div className="mt-2 flex justify-end">
                <Button
                  size="sm"
                  variant="outline"
                  isLoading={pendingKeys.has(`s${season.seasonNumber}:season`)}
                  disabled={!ready || busy}
                  onClick={() =>
                    void runAction(`s${season.seasonNumber}:season`, () =>
                      handleToggleSeason(season.seasonNumber, progress.isComplete),
                    )
                  }
                >
                  {progress.isComplete ? "Unmark season" : "Mark season watched"}
                </Button>
              </div>
            )}

            {isExpanded && (
              <EpisodesArea
                cacheEntry={episodeCache[season.seasonNumber]}
                seasonNumber={season.seasonNumber}
                watched={watched}
                ready={ready}
                seasonBusy={busy}
                pendingKeys={pendingKeys}
                onToggleEpisode={handleToggleEpisode}
                onMarkUpTo={handleMarkUpTo}
              />
            )}
          </div>
        );
      })}

      {error && (
        <p role="alert" className="text-danger text-body-sm mt-3">
          {error}
        </p>
      )}
    </div>
  );
}

function EpisodesArea({
  cacheEntry,
  seasonNumber,
  watched,
  ready,
  seasonBusy,
  pendingKeys,
  onToggleEpisode,
  onMarkUpTo,
}: {
  cacheEntry: EpisodeCacheEntry | undefined;
  seasonNumber: number;
  watched: WatchedEpisodes;
  ready: boolean;
  seasonBusy: boolean;
  pendingKeys: Set<string>;
  onToggleEpisode: (
    seasonNumber: number,
    episodeNumber: number,
    currentlyWatched: boolean,
  ) => void;
  onMarkUpTo: (seasonNumber: number, episodeNumber: number) => void;
}) {
  if (!cacheEntry || cacheEntry.status === "loading") {
    return (
      <ul className="mt-2" aria-label="Loading episodes">
        {Array.from({ length: 3 }, (_, i) => (
          <li key={i} className="flex items-start gap-3 py-3">
            <Skeleton className="size-6 shrink-0 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </li>
        ))}
      </ul>
    );
  }

  if (cacheEntry.status === "error") {
    return (
      <p role="alert" className="text-danger text-body-sm mt-2">
        {"Couldn't load episodes for this season."}
      </p>
    );
  }

  return (
    <ul className="mt-2">
      {cacheEntry.episodes.map((episode) => {
        const unaired = isFutureAirDate(episode.airDate);
        const watchedNow = isEpisodeWatched(
          watched,
          seasonNumber,
          episode.episodeNumber,
        );
        const epKey = `s${seasonNumber}:ep:${episode.episodeNumber}`;
        const uptoKey = `s${seasonNumber}:upto:${episode.episodeNumber}`;

        return (
          <li
            key={episode.id}
            className="border-line-subtle flex items-start gap-3 border-b py-3 last:border-b-0"
          >
            <button
              type="button"
              onClick={() =>
                onToggleEpisode(seasonNumber, episode.episodeNumber, watchedNow)
              }
              disabled={!ready || unaired || seasonBusy}
              aria-pressed={watchedNow}
              aria-label={`${watchedNow ? "Unmark" : "Mark"} episode ${episode.episodeNumber}, ${episode.name}, as watched`}
              className={cn(
                "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border transition-colors disabled:opacity-40",
                watchedNow
                  ? "bg-accent border-transparent text-on-accent"
                  : "border-line text-transparent hover:border-accent",
              )}
            >
              <CheckIcon className="size-4" />
            </button>

            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  "text-body-sm truncate",
                  unaired ? "text-fg-subtle" : "text-fg",
                )}
              >
                <span className="text-fg-subtle tabular-nums">
                  {episode.episodeNumber}.
                </span>{" "}
                {episode.name}
              </p>
              <p className="text-meta-sm text-fg-subtle mt-0.5 flex flex-wrap items-center gap-1.5">
                {unaired && (
                  <Badge size="sm" variant="outline">
                    Unaired
                  </Badge>
                )}
                <span>
                  {[
                    formatAirDate(episode.airDate),
                    episode.runtimeMinutes ? `${episode.runtimeMinutes}m` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </p>
            </div>

            {!unaired && (
              <button
                type="button"
                onClick={() => onMarkUpTo(seasonNumber, episode.episodeNumber)}
                disabled={!ready || seasonBusy}
                title={`Mark watched up to episode ${episode.episodeNumber}`}
                aria-label={`Mark watched up to episode ${episode.episodeNumber}`}
                className="text-fg-subtle hover:text-accent mt-0.5 shrink-0 disabled:opacity-40"
              >
                {pendingKeys.has(uptoKey) || pendingKeys.has(epKey) ? (
                  <SpinnerIcon className="size-5 motion-safe:animate-spin" />
                ) : (
                  <SkipToIcon className="size-5" />
                )}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
