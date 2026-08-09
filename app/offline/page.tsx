import type { Metadata } from "next";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { CompassIcon } from "@/components/ui/icons";

export const metadata: Metadata = { title: "Offline" };

/**
 * The navigation fallback when a page cannot be fetched and is not in the
 * shell cache — in practice, a dynamic route (a title page, `/profile`,
 * `/lists`) reached with no network.
 *
 * A real route rather than a synthetic Response from the worker, for two
 * reasons: it renders inside the app shell so the nav stays usable, and it
 * can be maintained like any other page instead of as an HTML string inside
 * a JS file.
 *
 * **It names what still works rather than just apologising.** In an app whose
 * entire premise is that the library already lives on the device, a generic
 * "you are offline" would be actively misleading — most of Marquee is fine
 * here, and the two links below are the proof.
 */
export default function OfflinePage() {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-12 sm:px-6 lg:px-8">
      <EmptyState
        icon={<CompassIcon />}
        title="No connection"
        body="This page needs the network. Your library, your progress and everything you've already tracked are stored on this device and still work — including marking episodes watched, which will sync once you're back online."
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button href="/library" variant="primary" size="sm">
              My Library
            </Button>
            <Button href="/schedule" variant="outline" size="sm">
              Schedule
            </Button>
          </div>
        }
      />
    </div>
  );
}
