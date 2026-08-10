import type { Metadata } from "next";

import { YirDeck } from "@/components/yir/yir-deck";

export const metadata: Metadata = { title: "Your last 12 months" };

/**
 * Year in Review — Phase 8 Step 1.
 *
 * Static: every byte of this comes from local storage on the client, so there
 * is nothing for a server render to fetch and no reason to make the route
 * dynamic. It works offline and signed out, and the service worker caches it
 * like any other static route.
 *
 * Deliberately NOT titled "2026". It is a rolling 12-month window, and the
 * label says so in the heading, the metadata title, and again on the opener
 * card with the real date range — three places, because being mistaken for a
 * calendar-year summary is the one misreading that would make every number
 * on the page wrong.
 */
export default function YearInReviewPage() {
  return (
    <div className="mx-auto w-full max-w-md px-4 py-8 sm:px-6">
      <header className="mb-6">
        <h1 className="font-display text-display-xl text-fg uppercase">Your last 12 months</h1>
        <p className="text-body text-fg-muted mt-1">
          A rolling window, not a calendar year &mdash; so there&rsquo;s always
          something here.
        </p>
      </header>

      <YirDeck />
    </div>
  );
}
