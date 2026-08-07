"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { MAX_LIST_DESCRIPTION_LENGTH, MAX_LIST_NAME_LENGTH, type ListVisibility } from "@/lib/lists";

import { VisibilityPicker } from "./visibility-picker";

/**
 * Shared by create and edit — one shape, so the two forms can never drift.
 * Uncontrolled from the caller's perspective, same pattern
 * `components/comments/comment-form.tsx` uses: owns its own draft state,
 * only hands the parent a final value on submit.
 */
export function ListForm({
  initialName = "",
  initialDescription = "",
  initialVisibility = "private",
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initialName?: string;
  initialDescription?: string;
  initialVisibility?: ListVisibility;
  submitLabel: string;
  /** REJECTS with a user-facing message string on failure. */
  onSubmit: (name: string, description: string, visibility: ListVisibility) => Promise<void>;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [visibility, setVisibility] = useState<ListVisibility>(initialVisibility);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (pending || name.trim().length === 0) return;
    setPending(true);
    setError(null);
    try {
      await onSubmit(name, description, visibility);
    } catch (message) {
      setError(typeof message === "string" ? message : "Couldn't save that. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-4">
      {error && (
        <p role="alert" className="border-danger/40 bg-danger/10 text-danger rounded-md border px-3 py-2 text-body-sm">
          {error}
        </p>
      )}

      <div className="space-y-1.5">
        <label htmlFor="list-name" className="text-body-sm text-fg block font-medium">
          Name
        </label>
        <input
          id="list-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={MAX_LIST_NAME_LENGTH}
          placeholder="Friday night"
          className="bg-surface border-line text-fg placeholder:text-fg-subtle h-11 w-full rounded-md border px-3 text-body"
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="list-description" className="text-body-sm text-fg block font-medium">
          Description <span className="text-fg-subtle font-normal">(optional)</span>
        </label>
        <textarea
          id="list-description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          maxLength={MAX_LIST_DESCRIPTION_LENGTH}
          rows={2}
          placeholder="What's this list for?"
          className="bg-surface border-line text-fg placeholder:text-fg-subtle w-full resize-y rounded-md border px-3 py-2 text-body-sm"
        />
      </div>

      <VisibilityPicker value={visibility} onChange={setVisibility} />

      <div className="flex items-center gap-2">
        <Button
          type="button"
          isLoading={pending}
          disabled={name.trim().length === 0}
          onClick={() => void submit()}
        >
          {submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}
