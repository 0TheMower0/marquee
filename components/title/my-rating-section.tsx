"use client";

import { NotesField } from "@/components/title/notes-field";
import { RatingSlider } from "@/components/title/rating-slider";
import type { MediaType } from "@/lib/content/types";
import { useRatings } from "@/lib/ratings";
import { useTracking } from "@/lib/tracking";

/**
 * Rating + notes, gated on the title being marked "watched" — "A 0-100
 * rating on any watched title" means exactly that; rating something you
 * haven't watched isn't a control this app offers.
 *
 * Renders nothing until BOTH `useTracking()` and `useRatings()` have
 * resolved their initial read, and only then decides whether to show
 * anything at all. That matters beyond avoiding a flash: `RatingSlider` and
 * `NotesField` both seed their internal state from `score`/`note` via
 * `useState(initialValue)` — a one-time read on mount. Rendering them before
 * `ratingsReady` would seed that state from nothing every time, and it would
 * never resync once the real data arrived (a `useState` initializer only
 * runs once). Gating here means by the time they mount, the data is already
 * correct — no resync effect needed.
 *
 * `key={...}` on each forces a full remount when navigating between titles
 * client-side. Without it, Next reuses the same component instance across a
 * `/title/movie/1` -> `/title/movie/2` navigation (same component type, new
 * props) and the sliders' internal `live` state would carry over from the
 * previous title for a frame.
 */
export function MyRatingSection({
  id,
  mediaType,
}: {
  id: string;
  mediaType: MediaType;
}) {
  const { ready: trackingReady, getEntry: getTrackingEntry } = useTracking();
  const { ready: ratingsReady, getEntry: getRatingEntry, setScore, setNote } = useRatings();

  if (!trackingReady || !ratingsReady) return null;

  const trackingEntry = getTrackingEntry(id, mediaType);
  if (trackingEntry?.status !== "watched") return null;

  const ratingEntry = getRatingEntry(id, mediaType);
  const scopeKey = `${mediaType}:${id}`;

  return (
    <section aria-labelledby="my-rating-heading">
      <h2 id="my-rating-heading" className="font-display text-display-md text-fg uppercase">
        My Rating
      </h2>
      <div className="mt-4">
        <RatingSlider
          key={scopeKey}
          score={ratingEntry?.score ?? null}
          onCommit={(score) => setScore(id, mediaType, score)}
        />
        <NotesField
          key={`${scopeKey}-note`}
          note={ratingEntry?.note ?? ""}
          onCommit={(note) => setNote(id, mediaType, note)}
        />
      </div>
    </section>
  );
}
