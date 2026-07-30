"use client";

import { useEffect, useRef, useState } from "react";

const DEBOUNCE_MS = 800;
const MAX_LENGTH = 2000;

/**
 * Free-text notes, autosaving — there is no Save button anywhere else that
 * mutates tracking/rating state in this app, and adding one here would be
 * the odd one out.
 *
 * Two commit paths, both landing on the same `commit()`:
 *   - a debounce timer, reset on every keystroke, so a fast typist never
 *     triggers a write per character;
 *   - `onBlur`, as an immediate flush — a user who tabs away or clicks
 *     "Watched" right after typing should not lose the last ~800ms of debounce
 *     if they don't wait around.
 *
 * Neither path can protect against closing the tab mid-debounce-window with
 * no blur at all; that gap is accepted as a real but narrow limitation of a
 * no-explicit-save design, same tradeoff the codebase already made for
 * search debouncing.
 */
export function NotesField({
  note,
  onCommit,
}: {
  note: string;
  onCommit: (note: string) => Promise<void>;
}) {
  const [value, setValue] = useState(note);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const timerRef = useRef<number | null>(null);
  const lastCommittedRef = useRef(note);

  // Cleanup only — this must not fire the debounced write on unmount (e.g.
  // navigating away). onBlur already covers "save before leaving the field";
  // firing here too would double-commit.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  async function commit(next: string) {
    if (next === lastCommittedRef.current) return;
    setStatus("saving");
    try {
      await onCommit(next);
      lastCommittedRef.current = next;
      setStatus("saved");
      window.setTimeout(() => setStatus((s) => (s === "saved" ? "idle" : s)), 1500);
    } catch {
      setStatus("error");
    }
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const next = e.target.value;
    setValue(next);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => commit(next), DEBOUNCE_MS);
  }

  function handleBlur() {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    void commit(value);
  }

  return (
    <div className="mt-6">
      <label htmlFor="my-notes" className="text-meta text-fg-muted uppercase">
        Notes
      </label>
      <textarea
        id="my-notes"
        value={value}
        onChange={handleChange}
        onBlur={handleBlur}
        maxLength={MAX_LENGTH}
        rows={4}
        placeholder="Private notes about this title — not shared, not synced."
        className="bg-surface border-line text-fg placeholder:text-fg-subtle focus-visible:border-accent mt-2 w-full resize-y rounded-md border p-3 text-body-sm outline-none"
      />
      <div className="mt-1 flex items-center justify-between">
        <p role="status" aria-live="polite" className="text-meta-sm text-fg-subtle">
          {status === "saving" && "Saving…"}
          {status === "saved" && "Saved"}
          {status === "error" && (
            <span role="alert" className="text-danger">
              Couldn&apos;t save your notes. Please try again.
            </span>
          )}
        </p>
        <p className="text-meta-sm text-fg-subtle tabular-nums">
          {value.length}/{MAX_LENGTH}
        </p>
      </div>
    </div>
  );
}
