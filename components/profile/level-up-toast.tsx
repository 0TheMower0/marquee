"use client";

import { useEffect, useState } from "react";

import { StarIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils/cn";

const AUTO_DISMISS_MS = 6000;

/**
 * The level-up moment. Mounted by `XpSummary` only when `useXp()` reports
 * `justLeveledUp` — a one-shot signal, so this component's whole lifetime is
 * "show once, then go away," never re-triggered by a re-render.
 *
 * Reduced motion needs no bespoke handling here: `motion-safe:` gates the
 * transition classes below (matching the exact idiom `ProgressBar` already
 * uses), and CLAUDE.md's global `@media (prefers-reduced-motion: reduce)`
 * rule in globals.css independently collapses every transition duration to
 * 0.01ms as a second safety net — the content still appears instantly either
 * way, only the slide/fade is skipped.
 *
 * Auto-dismisses after 6s; a real `<button>` also dismisses it immediately.
 * Deliberately not a clickable `<div>` — this codebase's own rule is
 * "semantic HTML... no div soup," and a div-with-onClick is neither
 * keyboard-focusable nor screen-reader-operable.
 */
export function LevelUpToast({ level, rank }: { level: number; rank: string }) {
  const [visible, setVisible] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // One tick after mount, so the transition below actually animates from
    // its initial (offset, transparent) state rather than starting already
    // at its final one.
    const raf = requestAnimationFrame(() => setVisible(true));
    const timer = window.setTimeout(() => setDismissed(true), AUTO_DISMISS_MS);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, []);

  if (dismissed) return null;

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
        <StarIcon className="size-5" />
      </span>

      <div className="min-w-0 flex-1">
        <p className="font-display text-display-sm text-accent uppercase">Level Up!</p>
        <p className="text-body-sm text-fg truncate">
          You&apos;re now a <span className="font-semibold">{rank}</span> — Level {level}
        </p>
      </div>

      <button
        type="button"
        onClick={() => setDismissed(true)}
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
