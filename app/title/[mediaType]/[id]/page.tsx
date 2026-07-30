import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ContentErrorState } from "@/components/content/content-error-state";
import { BackdropImage } from "@/components/title/backdrop-image";
import { PosterImage } from "@/components/title/poster-image";
import { SeasonList } from "@/components/tracking/season-list";
import { ShowProgressBadge } from "@/components/tracking/show-progress-badge";
import { TrackingActions } from "@/components/tracking/tracking-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FilmIcon } from "@/components/ui/icons";
import {
  Tabs,
  TabsList,
  TabsPanel,
  TabsTrigger,
} from "@/components/ui/tabs";
import { getContentProvider } from "@/lib/content";
import { ContentError, type ContentErrorKind } from "@/lib/content/errors";
import type {
  MediaType,
  Season,
  Title,
  TitleStatus,
} from "@/lib/content/types";

/** Matches the poster's w-24/sm:w-36/lg:w-44 breakpoints exactly, rather
 *  than approximating with vw — a single hero poster, unlike a grid, has a
 *  small enough number of exact-width breakpoints that there is no reason
 *  not to just state them. */
const HERO_POSTER_SIZES = "(min-width: 1024px) 176px, (min-width: 640px) 144px, 96px";

/**
 * Route params are strings from the URL and could be anything. Narrowing here
 * means the rest of the file works with a real `MediaType`, and a hand-typed
 * `/title/book/…` 404s instead of being handed to a provider that would have
 * to guess.
 */
function parseMediaType(value: string): MediaType | null {
  return value === "movie" || value === "tv" ? value : null;
}

const STATUS_LABEL: Record<TitleStatus, string> = {
  released: "Released",
  upcoming: "Upcoming",
  returning: "Returning",
  ended: "Ended",
  canceled: "Canceled",
};

function formatRuntime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours}h ${rest}m` : `${rest}m`;
}

/** "1972 · Film · 2h 55m" — the line under the title. */
function metaLine(title: Title): string {
  const parts: string[] = [];

  if (title.year !== null) parts.push(String(title.year));
  parts.push(title.mediaType === "tv" ? "Series" : "Film");

  if (title.runtimeMinutes !== null) {
    parts.push(formatRuntime(title.runtimeMinutes));
  }
  if (title.seasonCount !== null) {
    parts.push(`${title.seasonCount} season${title.seasonCount === 1 ? "" : "s"}`);
  }
  if (title.episodeCount !== null) {
    parts.push(
      `${title.episodeCount} episode${title.episodeCount === 1 ? "" : "s"}`,
    );
  }

  return parts.join(" · ");
}

/**
 * A second `getTitle` call, which looks wasteful but isn't: in tmdb mode the
 * detail endpoint is cached for 24h (REVALIDATE.detail), so this resolves from
 * Next's data cache rather than hitting the API twice. Failures are swallowed
 * on purpose — a metadata error must never take down the page itself.
 */
export async function generateMetadata({
  params,
}: PageProps<"/title/[mediaType]/[id]">): Promise<Metadata> {
  const { mediaType: rawMediaType, id } = await params;
  const mediaType = parseMediaType(rawMediaType);
  if (!mediaType) return { title: "Not found" };

  try {
    const title = await getContentProvider().getTitle(id, mediaType);
    return {
      title: title.year ? `${title.name} (${title.year})` : title.name,
      description: title.overview || undefined,
    };
  } catch {
    return { title: "Title" };
  }
}

export default async function TitleDetailPage({
  params,
}: PageProps<"/title/[mediaType]/[id]">) {
  // Next 16: params is a Promise. Synchronous access was removed in 16 (it was
  // only deprecated in 15).
  const { mediaType: rawMediaType, id } = await params;

  const mediaType = parseMediaType(rawMediaType);
  if (!mediaType) notFound();

  let title: Title;
  try {
    title = await getContentProvider().getTitle(id, mediaType);
  } catch (error) {
    if (error instanceof ContentError) {
      // A missing title is a routing outcome, not an error screen — hand it to
      // the 404 UI so the URL behaves the way a wrong URL should.
      if (error.kind === "not_found") notFound();
      return <ContentErrorState kind={error.kind} className="min-h-[70vh]" />;
    }
    throw error;
  }

  // Fetched here, once, server-side — NOT the individual episode lists,
  // which would mean a provider call per season on a page that might have
  // 20 of them. Season/episode-count data is enough for every progress
  // number on this page; only expanding a season in <SeasonList> fetches
  // that one season's actual episodes, client-side, on demand.
  let seasons: Season[] | null = null;
  let seasonsErrorKind: ContentErrorKind | null = null;
  if (mediaType === "tv") {
    try {
      seasons = await getContentProvider().getSeasons(id);
    } catch (error) {
      if (error instanceof ContentError) {
        seasonsErrorKind = error.kind;
      } else {
        throw error;
      }
    }
  }

  const { placeholder } = title;

  return (
    /* ------------------------------------------------------------------
       PHASE 4 THEMING ROOT.
       This element is the one Phase 4 overrides. Once artwork colour
       extraction lands it will set --accent-primary / --accent-secondary
       here, and every bg-accent / text-accent / border-accent below will
       re-tint with no component changes — that is what the `inline`
       keyword on @theme in globals.css buys us (see globals.css header).

       The two --title-art-* properties below are already doing that job in
       miniature today: they are per-title values set on this wrapper and
       consumed by the hero wash further down. Phase 4 adds accents to the
       same object; it does not need a new mechanism.
       ------------------------------------------------------------------ */
    <div
      data-title-theme
      style={
        {
          "--title-art-from": placeholder.gradientFrom,
          "--title-art-to": placeholder.gradientTo,
        } as React.CSSProperties
      }
    >
      <header className="relative overflow-hidden">
        {/* Layer 1: the per-title gradient, always present. */}
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-[linear-gradient(135deg,var(--title-art-from),var(--title-art-to))]"
        />

        {/* Layer 2: the real backdrop, when the provider has one. Held at low
            opacity so the title text keeps its contrast regardless of how
            bright the artwork happens to be. */}
        {title.backdropUrl && (
          <BackdropImage
            src={title.backdropUrl}
            gradientFrom={placeholder.gradientFrom}
            gradientTo={placeholder.gradientTo}
            className="object-cover opacity-45"
          />
        )}

        {/* Layer 3: scrim into the page background, so the hero dissolves into
            the body instead of ending on a hard edge. */}
        <div
          aria-hidden="true"
          className="from-ink via-ink/85 to-ink/40 absolute inset-0 bg-gradient-to-t"
        />

        <div className="relative mx-auto flex w-full max-w-7xl gap-4 px-4 pt-8 pb-10 sm:gap-6 sm:px-6 sm:pt-12 lg:px-8">
          {/* Poster. shrink-0 + min-w-0 on the sibling is what keeps a long
              title from squeezing this to nothing at 375px. */}
          <div className="ring-line-strong/60 relative aspect-[2/3] w-24 shrink-0 overflow-hidden rounded-md shadow-2xl ring-1 sm:w-36 lg:w-44">
            <PosterImage
              src={title.posterUrl}
              alt={`${title.name} poster`}
              name={title.name}
              placeholder={placeholder}
              sizes={HERO_POSTER_SIZES}
              priority
              initialsClassName="text-[2.5rem] text-white/25 sm:text-[3.5rem]"
            />
          </div>

          <div className="min-w-0 flex-1 self-end">
            <h1 className="font-display text-display-xl text-fg uppercase">
              {title.name}
            </h1>

            {/* Original-language title, when it differs. Mixed-case, so Inter
                rather than Bebas. */}
            {title.originalName && title.originalName !== title.name && (
              <p className="text-body-sm text-fg-subtle mt-1 italic">
                {title.originalName}
              </p>
            )}

            <p className="text-meta text-fg-muted mt-2 uppercase">
              {metaLine(title)}
            </p>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              {title.rating !== null && (
                <Badge variant="accent">★ {title.rating.toFixed(1)}</Badge>
              )}
              {title.status && (
                <Badge variant="outline">{STATUS_LABEL[title.status]}</Badge>
              )}
              {seasons && seasons.length > 0 && (
                <ShowProgressBadge title={title} seasons={seasons} />
              )}
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-7xl px-4 pb-12 sm:px-6 lg:px-8">
        {title.genres.length > 0 && (
          <section aria-labelledby="genres-heading">
            <h2 id="genres-heading" className="sr-only">
              Genres
            </h2>
            <ul className="flex flex-wrap gap-2">
              {title.genres.map((genre) => (
                <li key={genre.id}>
                  <Badge variant="secondary">{genre.name}</Badge>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section aria-label="Track this title" className="mt-8">
          <TrackingActions title={title} />
        </section>

        {mediaType === "tv" ? (
          // Tabbed for TV: Overview alongside a Seasons tab, which is where
          // all the episode-level UI lives. TabsPanel already exposes each
          // panel's accessible name via its TabsTrigger, so neither panel
          // repeats a redundant heading the way the movie layout below does
          // (which has no tab to label it).
          <Tabs defaultValue="overview" className="mt-8">
            <TabsList label="Title sections">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="seasons">Seasons</TabsTrigger>
            </TabsList>

            <TabsPanel value="overview">
              <p
                className={
                  title.overview
                    ? "text-body-lg text-fg-muted max-w-prose"
                    : "text-body text-fg-subtle max-w-prose italic"
                }
              >
                {title.overview || "No overview available for this title."}
              </p>
            </TabsPanel>

            <TabsPanel value="seasons">
              {seasonsErrorKind ? (
                <ContentErrorState kind={seasonsErrorKind} className="py-10" />
              ) : seasons && seasons.length > 0 ? (
                <SeasonList title={title} seasons={seasons} />
              ) : (
                <EmptyState
                  icon={<FilmIcon />}
                  title="No season data"
                  body="Season and episode information isn't available for this title."
                  className="py-10"
                />
              )}
            </TabsPanel>
          </Tabs>
        ) : (
          <section aria-labelledby="overview-heading" className="mt-8">
            <h2
              id="overview-heading"
              className="font-display text-display-md text-fg uppercase"
            >
              Overview
            </h2>
            <p
              className={
                title.overview
                  ? "text-body-lg text-fg-muted mt-2 max-w-prose"
                  : "text-body text-fg-subtle mt-2 max-w-prose italic"
              }
            >
              {title.overview || "No overview available for this title."}
            </p>
          </section>
        )}

        {/* Cast and watch providers arrive in Phase 4. Nothing is stubbed in
            here for them on purpose. */}
        <div className="mt-10">
          <Button href="/" variant="ghost">
            ← Back to trending
          </Button>
        </div>
      </div>
    </div>
  );
}
