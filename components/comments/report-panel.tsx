"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { MAX_REPORT_NOTE_LENGTH, REPORT_REASONS, type ReportReason } from "@/lib/comments";
import { cn } from "@/lib/utils/cn";

/**
 * The report reason picker — an inline disclosure rather than a modal, same
 * "collapsed by default, one tap to open" idiom `ResendVerificationForm`
 * already uses on the sign-in page. A full-screen dialog for "report this
 * comment" would be disproportionate to the action; this stays in the flow of
 * the thread it's reporting.
 */
export function ReportPanel({
  onSubmit,
  onCancel,
}: {
  /** REJECTS with a user-facing message string on failure. */
  onSubmit: (reason: ReportReason, note: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!reason || pending) return;
    setPending(true);
    setError(null);
    try {
      await onSubmit(reason, note);
    } catch (message) {
      setError(typeof message === "string" ? message : "Couldn't send that report.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="border-line-subtle bg-surface mt-2 space-y-3 rounded-md border p-3">
      <fieldset className="space-y-1.5">
        <legend className="text-body-sm text-fg font-medium">Report this comment</legend>
        {REPORT_REASONS.map((option) => (
          <label key={option.value} className="flex items-center gap-2">
            <input
              type="radio"
              name="report-reason"
              value={option.value}
              checked={reason === option.value}
              onChange={() => setReason(option.value)}
              className="accent-accent size-4"
            />
            <span className="text-body-sm text-fg-muted">{option.label}</span>
          </label>
        ))}
      </fieldset>

      <textarea
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="Add a note (optional)"
        rows={2}
        maxLength={MAX_REPORT_NOTE_LENGTH}
        className="bg-ink border-line text-fg placeholder:text-fg-subtle text-body-sm w-full resize-y rounded-md border px-3 py-2"
      />

      <div className={cn("flex items-center gap-2")}>
        <Button
          type="button"
          variant="danger"
          size="sm"
          isLoading={pending}
          disabled={!reason}
          onClick={() => void submit()}
        >
          Submit report
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-meta text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
