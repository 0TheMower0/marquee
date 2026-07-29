import Link from "next/link";

import { TrackingBadge } from "@/components/tracking/tracking-badge";
import { cn } from "@/lib/utils/cn";
import { initialsFor } from "@/lib/utils/initials";
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
  const { placeholder, posterUrl, name } = title;

  return (
    <div
      className="relative aspect-[2/3] w-full overflow-hidden"
      style={{
        // Inline because the gradient is per-title data, not a design decision
        // — it cannot be expressed as a static utility class.
        backgroundImage: `linear-gradient(145deg, ${placeholder.gradientFrom}, ${placeholder.gradientTo})`,
      }}
    >
      {/* Initials sit UNDER any real poster, so mock mode gets characterful
          art and tmdb mode gets a graceful backdrop if an image 404s. */}
      <span
        aria-hidden="true"
        className="font-display absolute inset-0 flex items-center justify-center text-[3.5rem] leading-none text-white/20 select-none"
      >
        {initialsFor(name)}
      </span>

      {posterUrl && (
        // Plain <img>, not next/image: these are third-party CDN URLs that only
        // exist in tmdb mode, and routing them through the optimizer would add
        // a server hop plus remotePatterns config for no benefit — TMDB already
        // serves correctly-sized, cached derivatives (we request w500).
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={posterUrl}
          alt=""
          loading={priority ? "eager" : "lazy"}
          decoding="async"
          className="absolute inset-0 size-full object-cover"
        />
      )}

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
    </article>
  );
}
