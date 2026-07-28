import "server-only";

import { mockProvider } from "./mock";
import type { ContentProvider } from "./provider";

/**
 * The only sanctioned way to get a content provider. UI code must never
 * import mockProvider — or, once it exists, tmdbProvider — directly; going
 * through this function is what keeps switching providers a one-line env
 * change instead of a find-and-replace across the app.
 *
 * `import "server-only"` above means importing this file from a Client
 * Component is a build error, not a runtime leak — see CLAUDE.md.
 */
export function getContentProvider(): ContentProvider {
  const mode = process.env.NEXT_PUBLIC_CONTENT_PROVIDER ?? "mock";

  if (mode === "tmdb") {
    // tmdbProvider lands in Phase 1 Step 3. Fail loudly here rather than
    // silently falling back to mock, so a misconfigured env doesn't quietly
    // serve the wrong data.
    throw new Error(
      'NEXT_PUBLIC_CONTENT_PROVIDER is set to "tmdb", but the TMDB provider does not exist yet (Phase 1 Step 3). Set it to "mock" or unset it.',
    );
  }

  return mockProvider;
}
