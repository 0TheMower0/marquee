"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { AlertIcon } from "@/components/ui/icons";
import type { AmbiguousFile } from "@/lib/import/parse-file";
import { SOURCE_LABEL, type ImportSource } from "@/lib/import/types";
import { cn } from "@/lib/utils/cn";

/**
 * ============================================================================
 * WHY THIS SCREEN EXISTS AT ALL
 * ============================================================================
 * Letterboxd's `watchlist.csv` and `watched.csv` have BYTE-IDENTICAL headers
 * (`Date, Name, Year, Letterboxd URI`). Inside the export ZIP the filenames
 * settle it, but a loose file the user renamed cannot be identified by any
 * amount of inspection.
 *
 * Getting it wrong is not cosmetic — it is the difference between "I plan to
 * watch this" and "I have already seen this", applied to someone's entire
 * library and tedious to undo. So `detectLetterboxdSource` returns null and
 * the question comes here, to the one party who actually knows the answer.
 *
 * There is deliberately no default selection and no "guess for me" option.
 */
const DESCRIPTION: Partial<Record<ImportSource, string>> = {
  "letterboxd-watchlist": "Films you plan to watch. Imported to your watchlist.",
  "letterboxd-watched": "Films you have already seen. Imported as watched.",
};

export function SourcePicker({
  file,
  onAnswer,
  onCancel,
}: {
  file: AmbiguousFile;
  onAnswer: (source: ImportSource) => void;
  onCancel: () => void;
}) {
  const [choice, setChoice] = useState<ImportSource | null>(null);

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div className="border-warning/40 bg-warning/10 flex gap-3 rounded-md border px-4 py-3">
        <AlertIcon className="text-warning mt-0.5 size-5 shrink-0" />
        <div>
          <p className="text-body-sm text-fg font-medium">
            We can&rsquo;t tell what <code>{file.fileName}</code> is
          </p>
          <p className="text-meta text-fg-muted mt-1">
            Letterboxd&rsquo;s watchlist and watched exports have identical
            columns. Since this file was renamed, only you can say which it is —
            and guessing would mark films as seen that you haven&rsquo;t.
          </p>
        </div>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-body-sm text-fg mb-1 font-medium">
          Which export is this?
        </legend>
        {file.choices.map((source) => (
          <label
            key={source}
            className={cn(
              "flex cursor-pointer items-start gap-3 rounded-md border p-3",
              choice === source ? "border-accent bg-accent/8" : "border-line-subtle",
            )}
          >
            <input
              type="radio"
              name="import-source"
              value={source}
              checked={choice === source}
              onChange={() => setChoice(source)}
              className="accent-accent mt-0.5 size-4"
            />
            <span>
              <span className="text-body-sm text-fg block font-medium">
                {SOURCE_LABEL[source]}
              </span>
              <span className="text-meta text-fg-subtle">{DESCRIPTION[source]}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="flex items-center gap-2">
        <Button type="button" disabled={choice === null} onClick={() => choice && onAnswer(choice)}>
          Continue
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Skip this file
        </Button>
      </div>
    </div>
  );
}
