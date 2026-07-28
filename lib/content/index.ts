import "server-only";

import { mockProvider } from "./mock";
import type { ContentProvider } from "./provider";
import { tmdbProvider } from "./tmdb";

export type ContentProviderMode = "mock" | "tmdb";

/**
 * The only sanctioned way to get a content provider. UI code must never import
 * mockProvider or tmdbProvider directly; going through this function is what
 * keeps switching providers a one-line env change instead of a
 * find-and-replace across the app.
 *
 * `import "server-only"` above means importing this file from a Client
 * Component is a build error, not a runtime leak — see CLAUDE.md.
 */
export function getContentProvider(): ContentProvider {
  const mode = process.env.NEXT_PUBLIC_CONTENT_PROVIDER?.trim() || "mock";

  switch (mode) {
    case "tmdb":
      return tmdbProvider;
    case "mock":
      return mockProvider;
    default:
      // Fail loudly rather than silently falling back to mock — a typo'd env
      // var should not quietly serve different data than intended.
      throw new Error(
        `NEXT_PUBLIC_CONTENT_PROVIDER must be "mock" or "tmdb" (got "${mode}").`,
      );
  }
}
