"use client";

import type { MediaType } from "@/lib/content/types";
import { useRatings } from "@/lib/ratings";
import { useTracking } from "@/lib/tracking";

/**
 * The "YOU" entry in the ratings row — "show my score alongside the external
 * ones so the comparison is immediate". Same chip shape as `RatingChip` in
 * ratings-row.tsx, but solid `bg-accent` rather than a bordered outline: this
 * is the one chip in the row that ISN'T a read-only external source, and the
 * fill signals that at a glance.
 *
 * This chip is purely a DISPLAY of what `MyRatingSection` (rendered further
 * down the page) already holds — both read the same `useRatings()` context,
 * so they can never disagree, and neither owns the data. Clicking/tapping it
 * does nothing beyond what it visually is; the actual editing control lives
 * in one place, not duplicated into a popover here.
 *
 * Gated on "watched" exactly like `MyRatingSection` — showing a rating slot
 * for a title you haven't marked watched would advertise a control this app
 * doesn't offer yet. Renders nothing (not a skeleton) before both contexts
 * are ready, same reasoning as the rest of this row.
 */
export function MyRatingChip({ id, mediaType }: { id: string; mediaType: MediaType }) {
  const { ready: trackingReady, getEntry: getTrackingEntry } = useTracking();
  const { ready: ratingsReady, getEntry: getRatingEntry } = useRatings();

  if (!trackingReady || !ratingsReady) return null;
  if (getTrackingEntry(id, mediaType)?.status !== "watched") return null;

  const score = getRatingEntry(id, mediaType)?.score ?? null;

  return (
    <li className="bg-accent/15 border-accent/40 flex items-center gap-2.5 rounded-lg border px-3 py-2">
      <span
        aria-hidden="true"
        className="font-display bg-accent text-on-accent flex h-6 shrink-0 items-center rounded-xs px-1.5 text-meta-sm"
      >
        YOU
      </span>
      <span className="flex flex-col leading-tight">
        <span className="text-fg text-body-sm tabular-nums">
          <span className="sr-only">Your rating: </span>
          {score === null ? (
            <span className="text-fg-subtle italic">Not rated</span>
          ) : (
            <>
              {score}
              <span className="text-fg-subtle text-meta-sm">/100</span>
            </>
          )}
        </span>
      </span>
    </li>
  );
}
