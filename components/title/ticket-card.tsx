import Link from "next/link";

import { TicketProgressBar } from "@/components/tracking/ticket-progress-bar";
import { TrackingBadge } from "@/components/tracking/tracking-badge";
import { PosterImage } from "@/components/title/poster-image";
import { cn } from "@/lib/utils/cn";
import { POSTER_GRID_SIZES } from "@/lib/utils/grid";
import type { TitleSummary } from "@/lib/content/types";

/**
 * The signature element: a movie ticket with a tear-off stub.
 *
 * Structure matters here, and the nesting is not arbitrary:
 *
 *   <Link>              <- focusable. NO mask, so the focus ring survives.
 *     .ticket-lift      <- hover transform (motion-gated in globals.css)
 *       .ticket-surface <- THE MASK. Notches + perforation punched here.
 *         art (2:3)
 *         stub (exactly --ticket-stub tall)
 *
 * A mask clips everything its element paints, including the outline. Masking
 * the <a> itself would silently delete the keyboard focus ring — so the mask
 * lives strictly on an inner, non-interactive element.
 */

interface TicketCardProps {
  title: TitleSummary;
  /** `null` suppresses the link wrapper entirely, for static/preview display. */
  href?: string | null;
  className?: string;
  /** First rows in the Home grid should not lazy-load their art. */
  priority?: boolean;
}

function TicketArt({ title, priority }: { title: TitleSummary; priority?: boolean }) {
  return (
    <div className="relative aspect-[2/3] w-full overflow-hidden">
      <PosterImage
        src={title.posterUrl}
        alt=""
        name={title.name}
        placeholder={title.placeholder}
        sizes={POSTER_GRID_SIZES}
        priority={priority}
      />

      {/* Scrim so stub text never collides with a bright poster edge. */}
      <div className="from-surface/90 absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t to-transparent" />
    </div>
  );
}

function TicketStub({ title }: { title: TitleSummary }) {
  const meta = [
    title.year?.toString(),
    title.mediaType === "tv" ? "Series" : "Film",
  ].filter(Boolean);

  return (
    // Height is pinned to --ticket-stub because the mask in globals.css places
    // the perforation exactly that far from the bottom edge. If this height
    // drifts, the holes stop landing on the divider.
    <div className="flex h-[var(--ticket-stub)] flex-col justify-center gap-1 px-3">
      <h3 className="font-display text-display-sm text-fg truncate uppercase">
        {title.name}
      </h3>
      <div className="flex items-center justify-between gap-2">
        <p className="text-meta-sm text-fg-subtle truncate uppercase">
          {meta.join(" · ")}
        </p>
        {title.rating !== null && (
          <span className="text-meta-sm text-accent shrink-0 tabular-nums">
            ★ {title.rating.toFixed(1)}
          </span>
        )}
      </div>
    </div>
  );
}

export function TicketCard({
  title,
  href,
  className,
  priority = false,
}: TicketCardProps) {
  const inner = (
    <div className="ticket-lift">
      <div className="ticket-surface bg-surface rounded-lg">
        <TicketArt title={title} priority={priority} />
        <TicketStub title={title} />
      </div>
    </div>
  );

  const resolvedHref =
    href === null
      ? null
      : (href ?? `/title/${title.mediaType}/${title.id}`);

  return (
    <article className={cn("relative block", className)}>
      {resolvedHref ? (
        <Link
          href={resolvedHref}
          // rounded-lg + offset keeps the focus ring hugging the ticket shape
          // rather than drawing a box far outside it.
          className="block rounded-lg focus-visible:outline-offset-4"
        >
          {/* No aria-hidden wrapper here on purpose. `truncate` is CSS-only,
              so the full title stays in the DOM; letting the link derive its
              accessible name from the real content yields
              "The Godfather 1972 · Film ★ 9.2" and keeps the <h3> in the
              heading outline. */}
          {inner}
        </Link>
      ) : (
        inner
      )}

      {/* A SIBLING of the Link, never nested inside it — a <button> inside an
          <a> is invalid HTML and double-fires navigation on click. Sitting on
          top physically (z-10) means a click on the badge itself lands on the
          badge, not the Link underneath; everywhere else on the card still
          navigates normally. */}
      <TrackingBadge title={title} className="absolute top-2 right-2 z-10" />

      {/* Also a sibling, for the same masking reason — see the comment in
          ticket-progress-bar.tsx. Renders nothing unless this title is
          "watching", so untracked/watchlist/watched cards are unaffected. */}
      <TicketProgressBar title={title} />
    </article>
  );
}
