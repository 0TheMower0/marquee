import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ContentErrorState } from "@/components/content/content-error-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getContentProvider } from "@/lib/content";
import { ContentError } from "@/lib/content/errors";
import type { MediaType, Title, TitleStatus } from "@/lib/content/types";
import { initialsFor } from "@/lib/utils/initials";

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
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={title.backdropUrl}
            alt=""
            aria-hidden="true"
            className="absolute inset-0 size-full object-cover opacity-45"
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
          <div
            className="ring-line-strong/60 relative aspect-[2/3] w-24 shrink-0 overflow-hidden rounded-md shadow-2xl ring-1 sm:w-36 lg:w-44"
            style={{
              backgroundImage: `linear-gradient(145deg, ${placeholder.gradientFrom}, ${placeholder.gradientTo})`,
            }}
          >
            {/* Same monogram fallback the ticket cards use, so a title looks
                like itself whether you're seeing it in the grid or here. */}
            <span
              aria-hidden="true"
              className="font-display absolute inset-0 flex items-center justify-center text-[2.5rem] leading-none text-white/25 select-none sm:text-[3.5rem]"
            >
              {initialsFor(title.name)}
            </span>

            {title.posterUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={title.posterUrl}
                alt={`${title.name} poster`}
                className="absolute inset-0 size-full object-cover"
              />
            )}
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

        {/* Tracking actions land in Phase 2; the detail page gets cast, seasons,
            episodes and watch providers in Phase 4. Nothing is stubbed in here
            for them on purpose — an inert "Add to watchlist" button that does
            nothing is worse than no button. */}
        <div className="mt-10">
          <Button href="/" variant="ghost">
            ← Back to trending
          </Button>
        </div>
      </div>
    </div>
  );
}
