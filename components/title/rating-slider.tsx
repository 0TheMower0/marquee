"use client";

import { useRef, useState } from "react";

/**
 * A native `<input type="range">`, not a custom-built slider.
 *
 * That was a deliberate choice for "must work well with a thumb on mobile,
 * not just a mouse": every mobile browser already has years of tuning behind
 * dragging a native range input, including correct touch-vs-scroll gesture
 * disambiguation. A hand-rolled pointer-tracking slider would have to
 * reimplement all of that to reach the same baseline. `accent-accent` themes
 * the native thumb/track to the Step 2 per-title accent color for free.
 *
 * ## Why commit on pointer-up/key-up, not on every `input` event
 *
 * React's `onChange` for a range input fires on the native `input` event —
 * i.e. continuously, on every pixel of drag — not on the native `change`
 * event, which only fires once on release. Relying on that distinction would
 * mean writing to storage on every intermediate value while dragging. So
 * `onChange` here only updates LOCAL state (instant, no I/O); the actual
 * commit is wired to `onPointerUp` (covers mouse AND touch — Pointer Events
 * unify them) and `onKeyUp` (arrow-key adjustment), with `onBlur` as a safety
 * net in case a drag ends in a way that skips pointerup. A ref tracks the
 * last-committed value so blur-after-pointerup doesn't double-write.
 */
export function RatingSlider({
  score,
  onCommit,
}: {
  score: number | null;
  onCommit: (score: number | null) => Promise<void>;
}) {
  const [live, setLive] = useState(score ?? 50);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const lastCommittedRef = useRef(score);

  async function commit(next: number | null) {
    if (next === lastCommittedRef.current) return;
    setPending(true);
    setFailed(false);
    try {
      await onCommit(next);
      lastCommittedRef.current = next;
    } catch {
      setFailed(true);
      setLive(lastCommittedRef.current ?? 50); // roll the visual back too
      window.setTimeout(() => setFailed(false), 3000);
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <div className="flex items-end justify-between">
        <div className="flex items-baseline gap-1.5">
          {score === null ? (
            // Bebas Neue's em-dash glyph renders almost invisibly at
            // text-display-2xl — confirmed live: present in the DOM
            // (getBoundingClientRect reported a real 40x80px box) but
            // essentially unseen on screen. font-display is documented as
            // valid for titles/nav/headers, not arbitrary punctuation, and
            // this is exactly the failure mode that limit exists to avoid.
            // Body text in the normal face reads correctly instead.
            <span className="text-body text-fg-subtle italic">Not rated</span>
          ) : (
            <>
              <span className="font-display text-display-2xl text-accent leading-none tabular-nums">
                {live}
              </span>
              <span className="text-meta text-fg-subtle">/ 100</span>
            </>
          )}
        </div>
        {score !== null && (
          <button
            type="button"
            onClick={() => commit(null)}
            disabled={pending}
            className="text-meta-sm text-fg-subtle hover:text-fg underline underline-offset-2 disabled:opacity-50"
          >
            Clear
          </button>
        )}
      </div>

      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={live}
        disabled={pending}
        onChange={(e) => setLive(Number(e.currentTarget.value))}
        onPointerUp={(e) => commit(Number(e.currentTarget.value))}
        onKeyUp={(e) => commit(Number(e.currentTarget.value))}
        onBlur={(e) => commit(Number(e.currentTarget.value))}
        aria-label="Your rating, 0 to 100"
        aria-valuetext={score === null ? "Not rated" : `${score} out of 100`}
        className="accent-accent mt-3 h-8 w-full cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
      />

      {score === null ? (
        <p className="text-meta-sm text-fg-subtle mt-1">
          Drag to rate, or focus the slider and use arrow keys.
        </p>
      ) : (
        <p className="sr-only" role="status" aria-live="polite">
          {pending ? "Saving your rating…" : `Rated ${score} out of 100`}
        </p>
      )}

      {failed && (
        <p role="alert" className="text-danger text-meta-sm mt-1">
          Couldn&apos;t save your rating. Please try again.
        </p>
      )}
    </div>
  );
}
