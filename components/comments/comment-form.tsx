"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { MAX_COMMENT_LENGTH } from "@/lib/comments";
import { cn } from "@/lib/utils/cn";

/**
 * The one textarea+submit shape reused for posting, replying, AND editing —
 * three call sites, one component, so the character counter, the length
 * guard, and the submit-on-cmd-enter affordance can't drift between them.
 *
 * Deliberately uncontrolled from the CALLER's perspective: this owns its own
 * draft text as local state and only hands the parent a final string on
 * submit. The parent doesn't need to see every keystroke — it needs "the user
 * submitted this," which is exactly what `onSubmit` returning a promise (so
 * this can show its own pending/error state) provides.
 */
export function CommentForm({
  initialValue = "",
  placeholder,
  submitLabel,
  autoFocus = false,
  onSubmit,
  onCancel,
}: {
  initialValue?: string;
  placeholder: string;
  submitLabel: string;
  autoFocus?: boolean;
  /** Resolves on success. REJECTS (with a user-facing message string, not an
   *  Error object — the caller has already mapped it) on failure, so this
   *  form can show the error itself rather than the parent needing to track
   *  per-form error state for every comment on the page. */
  onSubmit: (value: string) => Promise<void>;
  onCancel?: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remaining = MAX_COMMENT_LENGTH - value.length;
  const overLimit = remaining < 0;

  async function submit() {
    if (pending || value.trim().length === 0 || overLimit) return;
    setPending(true);
    setError(null);
    try {
      await onSubmit(value);
      setValue("");
    } catch (message) {
      setError(typeof message === "string" ? message : "Couldn't post that. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      <textarea
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          // Cmd/Ctrl+Enter submits — a plain Enter stays a newline, which
          // matters for a multi-line comment box far more than it would for
          // a single-line input.
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            void submit();
          }
        }}
        placeholder={placeholder}
        autoFocus={autoFocus}
        disabled={pending}
        rows={3}
        aria-invalid={error ? true : undefined}
        className={cn(
          "bg-surface border-line text-fg placeholder:text-fg-subtle text-body-sm w-full resize-y rounded-md border px-3 py-2",
          overLimit && "border-danger",
        )}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span
          className={cn(
            "text-meta-sm",
            overLimit ? "text-danger" : "text-fg-subtle",
          )}
        >
          {remaining < 200 ? `${remaining} characters left` : ""}
        </span>

        <div className="flex items-center gap-2">
          {onCancel && (
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            isLoading={pending}
            disabled={value.trim().length === 0 || overLimit}
            onClick={() => void submit()}
          >
            {submitLabel}
          </Button>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-meta text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
