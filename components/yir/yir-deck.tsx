"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { CompassIcon } from "@/components/ui/icons";
import { Skeleton } from "@/components/ui/skeleton";

import { shareImage, type ShareOutcome } from "./share-image";
import { useYir } from "./use-yir";
import { YirCard } from "./yir-cards";

/**
 * Year in Review — the deck.
 *
 * A vertical stack rather than a swipeable story: it is readable without
 * JavaScript gestures, works with a screen reader in document order, and can
 * be scrolled back through, which a story format actively prevents. The cards
 * are still card-shaped and read one screen at a time on a phone.
 *
 * Everything here runs from local storage. No account, no network — the whole
 * feature works offline and signed out.
 */
export function YirDeck() {
  const { ready, data, cards } = useYir();
  const [sharing, setSharing] = useState(false);
  const [outcome, setOutcome] = useState<ShareOutcome | null>(null);

  if (!ready) return <DeckSkeleton />;
  if (!data) return null;

  // An empty deck is only ever opener + closer. Rather than show two cards
  // saying nothing, this is the one case that gets a real empty state — the
  // brief's "charming, not an empty template" applies to a THIN year, not to
  // no data at all, and pretending otherwise would be the empty template.
  if (data.provenance.totalEvents === 0) {
    return (
      <EmptyState
        icon={<CompassIcon />}
        title="Nothing to review yet"
        body="Mark something watched and this fills up. It covers a rolling 12 months, so there's no waiting for December."
        action={
          <Button href="/search" variant="outline" size="sm">
            Find something to watch
          </Button>
        }
      />
    );
  }

  async function handleShare() {
    if (!data) return;
    setSharing(true);
    setOutcome(null);
    const result = await shareImage(data);
    setSharing(false);
    setOutcome(result);
    if (result !== "failed") window.setTimeout(() => setOutcome(null), 4000);
  }

  return (
    <div className="space-y-4">
      {cards.map((id) => (
        <YirCard key={id} id={id} data={data} />
      ))}

      <div className="flex flex-col items-start gap-2 pt-2">
        <Button variant="primary" onClick={() => void handleShare()} disabled={sharing} isLoading={sharing}>
          Share a card
        </Button>
        <p className="text-meta-sm text-fg-subtle max-w-prose">
          Creates an image on this device. Nothing is uploaded, and nothing is
          shared until you choose who to send it to.
        </p>

        <div aria-live="polite" className="text-meta">
          {outcome === "downloaded" && <span className="text-fg-muted">Saved to your device.</span>}
          {outcome === "failed" && (
            <span role="alert" className="text-danger">
              Couldn&rsquo;t create the image on this browser.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function DeckSkeleton() {
  return (
    <div className="space-y-4" role="status" aria-busy="true">
      <span className="sr-only">Loading your year in review</span>
      {Array.from({ length: 3 }, (_, i) => (
        <Skeleton key={i} className="h-72 w-full rounded-lg" />
      ))}
    </div>
  );
}
