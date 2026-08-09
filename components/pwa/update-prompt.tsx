"use client";

import { Button } from "@/components/ui/button";
import { XIcon } from "@/components/ui/icons";

import { useServiceWorkerUpdate } from "./use-service-worker-update";

/**
 * "New version available — Reload." Step 3 of docs/phase-5-pwa-design.md §10.
 *
 * ============================================================================
 * DISMISSAL IS IN-MEMORY, PER-VISIT, AND NEVER STORED — DO NOT "FIX" THIS
 * ============================================================================
 * The obvious next step, the first time this looks unfinished, is to persist
 * the dismissal so it does not keep coming back — a `localStorage` flag, "don't
 * show again". **That is the bug, not a missing feature.** A user who
 * dismisses once and is then permanently pinned to an old build has hit the
 * exact failure this whole feature exists to prevent, just with an extra click
 * in front of it, and — worse — with no visible symptom pointing back at the
 * cause.
 *
 * `dismiss()` sets a plain `useState` flag in `useServiceWorkerUpdate`. It is
 * reset to `false` — not merely left alone — every time a waiting worker is
 * freshly reconfirmed: on load, right after an update install completes, and
 * on every `visibilitychange` recheck. So a dismissal suppresses the CURRENT
 * surfacing only; the next reload, tab switch back, or background update check
 * offers it again for as long as a waiting worker genuinely exists. It stops
 * appearing for exactly one reason — the update was actually applied.
 *
 * Non-blocking on purpose: no backdrop, no focus trap, `role="status"` rather
 * than `role="alertdialog"` (contrast with MergePrompt, which IS a modal for
 * a genuinely irreversible action). This is an offer, repeated, not an
 * interruption — it must never sit over content in a way that stops someone
 * doing what they came to do.
 */
export function UpdatePrompt() {
  const { show, applyUpdate, dismiss } = useServiceWorkerUpdate();

  if (!show) return null;

  return (
    <div
      role="status"
      className="bg-surface border-line fixed inset-x-4 bottom-[calc(env(safe-area-inset-bottom)+4.5rem)] z-30 mx-auto flex max-w-sm items-center gap-3 rounded-lg border p-3 shadow-lg lg:right-4 lg:bottom-4 lg:left-auto lg:inset-x-auto"
    >
      <p className="text-body-sm text-fg flex-1">
        A new version of Marquee is ready.
      </p>
      <Button size="sm" variant="primary" onClick={applyUpdate}>
        Reload
      </Button>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="text-fg-subtle hover:text-fg focus-visible:outline-accent shrink-0 rounded-sm p-1"
      >
        <XIcon className="size-4" />
      </button>
    </div>
  );
}
