"use client";

import Image from "next/image";
import { useState } from "react";

import { blurDataUrl } from "@/lib/utils/image";

/**
 * The detail-page hero's real backdrop photo — full-bleed, decorative, and
 * deliberately WITHOUT the monogram-fallback treatment `PosterImage` has.
 * It doesn't need one: this is Layer 2 over the hero's own gradient wash
 * (Layer 1 in page.tsx, driven by the same `--title-art-from/to` values),
 * which already IS the fallback for "no backdrop" or "failed to load" — this
 * component's only job is the photo on top of it, so on failure it renders
 * nothing and Layer 1 shows through unchanged rather than duplicating a
 * second gradient underneath it.
 */
export function BackdropImage({
  src,
  gradientFrom,
  gradientTo,
  className,
}: {
  src: string;
  gradientFrom: string;
  gradientTo: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;

  return (
    <Image
      src={src}
      alt=""
      aria-hidden="true"
      fill
      sizes="100vw"
      placeholder="blur"
      blurDataURL={blurDataUrl(gradientFrom, gradientTo)}
      onError={() => setFailed(true)}
      className={className}
    />
  );
}
