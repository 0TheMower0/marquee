import type { Metadata, Viewport } from "next";
import { Bebas_Neue, Inter } from "next/font/google";
import "./globals.css";

import { BottomNav } from "@/components/shell/bottom-nav";
import { Footer } from "@/components/shell/footer";
import { Sidebar } from "@/components/shell/sidebar";
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
                BottomNav ever need it too (e.g. a library item count). */}
            <TrackingProvider>{children}</TrackingProvider>
          </main>
          <Footer />
        </div>

        <BottomNav />
      </body>
    </html>
  );
}
