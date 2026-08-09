import type { MetadataRoute } from "next";

/**
 * The web app manifest — Phase 5 Step 6, step 1 of the order in
 * docs/phase-5-pwa-design.md §10.
 *
 * Landed BEFORE any service worker exists, deliberately. A manifest is
 * independently useful (it is what makes the app installable at all; offline
 * support is not a prerequisite) and independently verifiable, which means an
 * install bug and a caching bug can never be confused for each other while
 * testing either.
 *
 * This is a Route Handler and is cached by default. It must stay free of
 * request-time APIs (`cookies()`, `headers()`) — reading one would make it
 * dynamic, and a per-request manifest is both pointless and a way to leak
 * something user-specific into a file the browser stores against the origin.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    // `id` pins the app's identity independently of `start_url`, so changing
    // the landing route later updates the existing installed app instead of
    // being treated as a brand new one.
    id: "/",
    name: "Marquee",
    short_name: "Marquee",
    description:
      "Track every film and series you watch. Free, ad-free, and no paywalls.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    // --ink-800, matching `viewport.themeColor` in app/layout.tsx and the
    // page background in globals.css. Both values are the same on purpose:
    // `background_color` paints the launch splash, so any difference shows up
    // as a visible flash between splash and first paint.
    background_color: "#0b0b0e",
    theme_color: "#0b0b0e",
    categories: ["entertainment", "lifestyle"],
    // Orientation is deliberately unset. Locking to portrait would be wrong
    // on a tablet and is a preference the OS already lets the user express.
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // Without a maskable icon Android composites the "any" icon onto a
      // white circle badge, which looks broken against a near-black app.
      // Rendered with extra padding — see scripts/generate-icons.mjs.
      {
        src: "/icon-512-maskable.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    // Long-press shortcuts on the installed icon. Every target is a STATIC
    // route that renders from local storage, so each one is useful offline
    // and none of them can land a cold-started app on a sign-in wall.
    shortcuts: [
      {
        name: "My Library",
        short_name: "Library",
        description: "Everything you're tracking",
        url: "/library",
      },
      {
        name: "Schedule",
        short_name: "Schedule",
        description: "New episodes waiting for you",
        url: "/schedule",
      },
      {
        name: "Search",
        short_name: "Search",
        description: "Find a film or series",
        url: "/search",
      },
    ],
  };
}
