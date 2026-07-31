"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { Title } from "@/lib/content/types";
import { getStorageStatus } from "@/lib/storage";
import { toTrackingSummary, useTracking } from "@/lib/tracking";
import type { TrackingStatus } from "@/lib/tracking";

const LABEL: Record<TrackingStatus, string> = {
  watchlist: "Watchlist",
  watching: "Watching",
  watched: "Watched",
};

export function TrackingActions({ title }: { title: Title }) {
  const { ready, getEntry, setStatus, remove } = useTracking();
  const [pending, setPending] = useState<TrackingStatus | null>(null);
  const [failed, setFailed] = useState(false);

  const entry = getEntry(title.id, title.mediaType);
  const current = entry?.status ?? null;

  // "Watching" only means something for a title with episodes to be partway
  // through. A movie is watched in one sitting, and Phase 2 has no
  // in-progress/position tracking at all yet — so rather than offer a
  // "Watching" button that does nothing meaningful for a movie, it is simply
  // not shown for one.
  const statuses: TrackingStatus[] =
    title.mediaType === "tv"
      ? ["watchlist", "watching", "watched"]
      : ["watchlist", "watched"];

  async function handleClick(status: TrackingStatus) {
    if (pending) return;
    setPending(status);
    setFailed(false);
    try {
      if (current === status) {
        await remove(title.id, title.mediaType);
      } else {
        // Phase 5 Step 2: this component holds a full `Title` — the ONLY
        // caller of setStatus that does — so it's the one place able to
        // capture the XP-only fallback fields. Passed every time, even when
        // both are null (a movie with no known runtime, say): a fresh `null`
        // from a live fetch is still more current than a stale carried-over
        // value, and setStatus already carries the previous value forward on
        // its own when a caller omits `hint` entirely (see TrackingBadge).
        await setStatus(toTrackingSummary(title), status, {
          runtimeMinutes: title.runtimeMinutes,
          episodeCount: title.episodeCount,
        });
      }
    } catch {
      setFailed(true);
      window.setTimeout(() => setFailed(false), 3000);
    } finally {
      setPending(null);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Tracking status">
        {statuses.map((status) => {
          const active = current === status;
          return (
            <Button
              key={status}
              variant={active ? "primary" : "outline"}
              isLoading={pending === status}
              disabled={!ready || (pending !== null && pending !== status)}
              aria-pressed={active}
              onClick={() => handleClick(status)}
            >
              {LABEL[status]}
            </Button>
          );
        })}
      </div>

      {failed && (
        <p role="alert" className="text-danger text-body-sm mt-2">
          {getStorageStatus() === "memory"
            ? "Couldn't save — browser storage seems to be blocked, so changes won't survive a reload."
            : "Couldn't save that change. Please try again."}
        </p>
      )}
    </div>
  );
}
