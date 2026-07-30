"use client";

import Image from "next/image";
import { useState } from "react";

import type { WatchProvider } from "@/lib/content/types";

/**
 * A single watch-provider logo, with a text fallback on load failure.
 *
 * Lighter than `PosterImage` on purpose — no blur-up, no gradient layer.
 * These are small (36px), TMDB-supplied brand logos rather than per-title
 * artwork, so there's no "no image" case to design around (either TMDB gave
 * us a logo path or it didn't), just the ordinary "the fetch 404s" case,
 * which `onError` covers.
 */
export function ProviderLogo({ provider }: { provider: WatchProvider }) {
  const [failed, setFailed] = useState(false);

  if (!provider.logoUrl || failed) {
    return (
      <span className="bg-overlay border-line-subtle text-fg-muted text-meta-sm inline-flex h-9 items-center rounded-md border px-2">
        {provider.name}
      </span>
    );
  }

  return (
    <Image
      src={provider.logoUrl}
      alt={provider.name}
      title={provider.name}
      width={36}
      height={36}
      className="border-line-subtle rounded-md border"
      onError={() => setFailed(true)}
    />
  );
}
