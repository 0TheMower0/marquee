"use client";

import Image from "next/image";
import { useState } from "react";

import type { PlaceholderArt } from "@/lib/content/types";
import { cn } from "@/lib/utils/cn";
import { blurDataUrl } from "@/lib/utils/image";
import { initialsFor } from "@/lib/utils/initials";

/**
 * Shared poster rendering for every place a title's artwork appears at
 * portrait-ish scale: TicketCard's grid art, the title detail hero poster,
 * and the Up Next card's art slot.
 *
 * A CLIENT component specifically because graceful load-failure handling
 * needs `onError`, an event handler — and a Server Component cannot pass an
 * event-handler prop to next/image (or anything else) across the boundary.
 * That is also why this owns its own `failed` state rather than the parent
 * owning it: the parent is a Server Component at every call site today.
 *
 * The gradient + monogram is the FALLBACK, not a loading state — it renders
 * whenever there is no `src` at all (mock mode, always) or the real image
 * failed to load (tmdb mode, occasionally). While a real image IS loading,
 * `placeholder="blur"` shows a blurred version of that SAME gradient (see
 * lib/utils/image.ts) so there is no pop between "no image yet" and "image
 * arrived" — one visual, two levels of sharpness.
 *
 * Renders as a Fragment, not a wrapping div: every call site already has its
 * own `relative overflow-hidden` container sized for its context (a 2:3
 * ticket card, a 16:9 rail card, a fixed-width hero poster), and this only
 * ever fills whatever that container is — an extra nested div here would be
 * pure ceremony.
 */
export function PosterImage({
  src,
  alt,
  name,
  placeholder,
  sizes,
  priority = false,
  initialsClassName,
}: {
  src: string | null;
  alt: string;
  name: string;
  placeholder: PlaceholderArt;
  sizes: string;
  priority?: boolean;
  initialsClassName?: string;
}) {
  const [failed, setFailed] = useState(false);
  const showImage = src !== null && !failed;

  return (
    <>
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          backgroundImage: `linear-gradient(145deg, ${placeholder.gradientFrom}, ${placeholder.gradientTo})`,
        }}
      />

      {!showImage && (
        <span
          aria-hidden="true"
          className={cn(
            "font-display absolute inset-0 flex items-center justify-center text-[3.5rem] leading-none text-white/20 select-none",
            initialsClassName,
          )}
        >
          {initialsFor(name)}
        </span>
      )}

      {showImage && (
        <Image
          src={src}
          alt={alt}
          fill
          sizes={sizes}
          priority={priority}
          placeholder="blur"
          blurDataURL={blurDataUrl(placeholder.gradientFrom, placeholder.gradientTo)}
          onError={() => setFailed(true)}
          className="object-cover"
        />
      )}
    </>
  );
}
