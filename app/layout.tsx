import type { Metadata, Viewport } from "next";
import { Bebas_Neue, Inter } from "next/font/google";
import "./globals.css";

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
      <body className="bg-ink text-fg flex min-h-full flex-col">
        {children}
      </body>
    </html>
  );
}
