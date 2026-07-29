"use client";

import { useState } from "react";

import { BookmarkIcon, CheckIcon, EyeIcon } from "@/components/ui/icons";
import type { TitleSummary } from "@/lib/content/types";
import { useTracking } from "@/lib/tracking";
import { cn } from "@/lib/utils/cn";

/**
 * The quick-action corner badge on a TicketCard.
 *
 * Deliberately scoped to watchlist add/remove ONLY. "Watching" and "watched"
 * render as a plain, non-interactive indicator here rather than a control —
 * a dense grid is exactly the wrong place for a single mistap to erase
 * watched progress. Changing those requires the full control on the title
 * detail page (see `tracking-actions.tsx`), which has room to ask more
 * deliberately.
 */
export function TrackingBadge({
  title,
  className,
}: {
  title: TitleSummary;
  className?: string;
}) {
  const { ready, getEntry, setStatus, remove } = useTracking();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  // Renders nothing until the initial storage read resolves, rather than
  // flashing "not tracked" and then popping into the real state a moment
  // later — see the note on `ready` in lib/tracking/context.tsx.
  if (!ready) return null;

  const entry = getEntry(title.id, title.mediaType);

  if (entry?.status === "watching" || entry?.status === "watched") {
    const Icon = entry.status === "watched" ? CheckIcon : EyeIcon;
    return (
      <span
        aria-hidden="true"
        title={entry.status === "watched" ? "Watched" : "Watching"}
        className={cn(
          "bg-ink/80 pointer-events-none flex size-7 items-center justify-center rounded-full border backdrop-blur-sm",
          entry.status === "watched"
            ? "border-accent/40 text-accent"
            : "border-accent-2/40 text-accent-2",
          className,
        )}
      >
        <Icon className="size-4" />
      </span>
    );
  }

  const inWatchlist = entry?.status === "watchlist";

  async function handleClick() {
    if (pending) return;
    setPending(true);
    setFailed(false);
    try {
      if (inWatchlist) {
        await remove(title.id, title.mediaType);
      } else {
        await setStatus(title, "watchlist");
      }
    } catch {
      setFailed(true);
      window.setTimeout(() => setFailed(false), 2500);
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={pending}
      aria-pressed={inWatchlist}
      aria-label={
        inWatchlist
          ? `Remove ${title.name} from watchlist`
          : `Add ${title.name} to watchlist`
      }
      className={cn(
        "flex size-7 items-center justify-center rounded-full border backdrop-blur-sm transition-colors disabled:opacity-60",
        "focus-visible:outline-offset-2",
        failed
          ? "border-danger text-danger bg-ink/80"
          : inWatchlist
            ? "bg-accent text-on-accent border-transparent"
            : "bg-ink/80 border-line text-fg hover:border-accent hover:text-accent",
        className,
      )}
    >
      <BookmarkIcon className="size-4" fill={inWatchlist ? "currentColor" : "none"} />
      {failed && (
        <span role="status" aria-live="polite" className="sr-only">
          Couldn&apos;t save that change.
        </span>
      )}
    </button>
  );
}
