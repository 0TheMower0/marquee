import type { Metadata, Viewport } from "next";
import { Bebas_Neue, Inter } from "next/font/google";
import "./globals.css";

import { BottomNav } from "@/components/shell/bottom-nav";
import { Footer } from "@/components/shell/footer";
import { Sidebar } from "@/components/shell/sidebar";
import {
  HydrationFlag,
  InteractivityWarning,
} from "@/components/shell/interactivity-warning";
import { ServiceWorkerRegistration } from "@/components/pwa/service-worker-registration";
import { UpdatePrompt } from "@/components/pwa/update-prompt";
import { StorageBanner } from "@/components/storage/storage-banner";
import { MergePrompt } from "@/components/sync/merge-prompt";
import { RatingsProvider } from "@/lib/ratings";
import { SyncProvider } from "@/lib/sync";
import { TrackingProvider } from "@/lib/tracking";

/**
 * Fonts are self-hosted at build time by next/font — no runtime request to
 * Google, no layout shift, and it keeps working once the Phase 5 service worker
 * lands (a CDN font request would be an uncacheable third-party dependency).
 *
 * Bebas Neue ships a single weight. Declaring others would only trigger
 * synthetic emboldening, which mangles its condensed forms.
 */
const bebas = Bebas_Neue({
  variable: "--font-bebas",
  subsets: ["latin"],
  weight: "400",
  display: "swap",
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Marquee",
    template: "%s · Marquee",
  },
  description:
    "Track every film and series you watch. Free, ad-free, and no paywalls.",
  applicationName: "Marquee",
  icons: {
    // `app/favicon.ico` is picked up automatically by the file convention;
    // this adds the PNG set (scripts/generate-icons.mjs) for everything else.
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { url: "/icon.svg", type: "image/svg+xml" },
    ],
    // iOS does NOT read the manifest's icons for the home screen and ignores
    // `purpose: "maskable"` entirely — it applies its own rounded-square mask
    // to whatever `apple-touch-icon` points at. So this is a separate file
    // using the standard (less padded) layout, not the maskable render.
    // See docs/phase-5-pwa-design.md §5.
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    title: "Marquee",
    // The status bar draws over the app rather than as an opaque strip, which
    // is what lets the near-black page background run to the top edge instead
    // of sitting under a lighter band. Pairs with `viewportFit: "cover"`
    // below — both are needed, and either alone leaves a visible seam.
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  themeColor: "#0b0b0e",
  // Cover the iOS notch/home-indicator area so the fixed bottom nav can sit
  // flush against the screen edge rather than floating above a white bar.
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${bebas.variable} ${inter.variable} h-full antialiased`}
    >
      <body className="bg-ink text-fg min-h-full">
        {/* Server-rendered, hidden by CSS once HydrationFlag marks the
            document hydrated. This is the ONLY warning in the app that
            survives client JS never running — every other diagnostic is a
            Client Component and is silent in exactly the case it exists for.
            Placed outside every provider so nothing can prevent it rendering. */}
        <InteractivityWarning />
        <HydrationFlag />
        {/* Renders nothing. Outside every provider because it depends on none
            of them, and registration should not be gated on storage or auth
            state resolving. */}
        <ServiceWorkerRegistration />
        {/* Fixed-position, non-blocking — see its own doc comment for why
            dismissal is never persisted. Sits outside every provider for the
            same reason ServiceWorkerRegistration does. */}
        <UpdatePrompt />
        {/* Visually hidden until focused — the first Tab stop on any page,
            so a keyboard user can jump past Sidebar/BottomNav straight to
            content instead of tabbing through nav on every single page. */}
        <a
          href="#main-content"
          className="bg-accent text-on-accent sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:rounded-md focus:px-4 focus:py-2 focus:font-display focus:uppercase"
        >
          Skip to content
        </a>

        <Sidebar />

        {/* lg:pl-56 matches Sidebar's SIDEBAR_WIDTH_CLASS — the two must move
            together (see the note in components/shell/sidebar.tsx). */}
        <div className="flex min-h-full flex-col lg:pl-56">
          <main
            id="main-content"
            tabIndex={-1}
            className="flex-1 pb-24 lg:pb-0"
          >
            {/* Scoped to <main> rather than the whole body: everything that
                reads tracking state today (TicketCard, the title detail page,
                My Library) renders inside it. Move this outward if Sidebar or
                BottomNav ever need it too (e.g. a library item count).
                RatingsProvider nests inside for the same reason — its only
                readers (the title detail page, My Library's rated filter)
                are both inside <main> too. */}
            {/* SyncProvider sits OUTSIDE the two data providers: it sets the
                module-level signed-in user that lib/sync/record.ts reads, and
                that has to be in place before any mutation funnel can queue a
                write. It reads the session client-side, so mounting it here
                does NOT make routes dynamic — see the note in its own file
                about why Step 4 kept getAccount() out of this layout. */}
            <SyncProvider>
              <MergePrompt />
              {/* App-wide, above every page: a browser that will not persist
                  anything is not a per-page condition, and the failure it
                  causes (empty library, inert controls) is otherwise
                  indistinguishable from having no data. */}
              <StorageBanner />
              <TrackingProvider>
                <RatingsProvider>{children}</RatingsProvider>
              </TrackingProvider>
            </SyncProvider>
          </main>
          <Footer />
        </div>

        <BottomNav />
      </body>
    </html>
  );
}
