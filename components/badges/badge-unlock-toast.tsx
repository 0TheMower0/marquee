"use client";

import { useEffect, useState } from "react";

import { RibbonIcon } from "@/components/ui/icons";
import type { BadgeDefinition } from "@/lib/badges";
import { cn } from "@/lib/utils/cn";

const AUTO_DISMISS_MS = 6000;

/**
 * The badge-unlock moment. Mirrors `components/profile/level-up-toast.tsx`
 * exactly — same fixed position, same motion-safe transition (reduced motion
 * needs no bespoke handling here either, for the identical reason documented
 * there), same self-dismiss timer, same real `<button>` for manual dismiss.
 *
 * Shows exactly ONE badge. `useBadges()` queues unlocks oldest-first; the
 * parent remounts this with the next badge each time `onDismiss` fires
 * (React key change forces a fresh mount, so the auto-dismiss timer and
 * enter transition both restart cleanly for the next one in a multi-unlock
 * queue) rather than this component managing a queue itself.
 */
export function BadgeUnlockToast({
  badge,
  onDismiss,
}: {
  badge: BadgeDefinition;
  onDismiss: () => void;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    const timer = window.setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [badge.id]);

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "bg-surface border-accent/40 fixed inset-x-4 bottom-6 z-50 mx-auto flex max-w-sm items-center gap-3 rounded-lg border p-4 shadow-2xl sm:inset-x-auto sm:right-6 sm:left-auto",
        "motion-safe:transition-all motion-safe:duration-[--dur-slow] motion-safe:ease-[--ease-marquee]",
        visible ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0",
      )}
    >
      <span
        aria-hidden="true"
        className="bg-accent text-on-accent flex size-10 shrink-0 items-center justify-center rounded-full"
      >
        <RibbonIcon className="size-5" />
      </span>

      <div className="min-w-0 flex-1">
        <p className="font-display text-display-sm text-accent uppercase">Badge Earned</p>
        <p className="text-body-sm text-fg truncate">{badge.name}</p>
      </div>

      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="text-fg-subtle hover:text-fg shrink-0 rounded-sm p-1 focus-visible:outline-offset-2"
      >
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" className="size-4">
          <path d="M5 5l10 10M15 5L5 15" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
