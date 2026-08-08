"use client";

import { useRef, useState, type DragEvent } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils/cn";

/**
 * The entry point: a drop target that also works as a plain file picker.
 *
 * Accepts a Letterboxd export ZIP as downloaded, or a loose CSV. The ZIP is
 * detected by signature rather than extension inside `parseImportFile`, so
 * neither the `accept` attribute nor the file's name is load-bearing — they
 * only steer the OS picker.
 */
export function ImportDropzone({
  onFile,
  disabled = false,
}: {
  onFile: (file: File) => void;
  disabled?: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    const file = event.dataTransfer.files[0];
    if (file) onFile(file);
  }

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      className={cn(
        "flex flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-14 text-center transition-colors",
        dragging ? "border-accent bg-accent/8" : "border-line",
        disabled && "opacity-50",
      )}
    >
      <h2 className="font-display text-display-md text-fg uppercase">
        Drop your export here
      </h2>
      <p className="text-body-sm text-fg-muted mt-2 max-w-prose">
        A Letterboxd export <code className="text-accent">.zip</code>, or a single{" "}
        <code className="text-accent">.csv</code> from IMDb, Letterboxd or Trakt.
        Nothing is written until you review what was matched.
      </p>

      <input
        ref={inputRef}
        type="file"
        accept=".csv,.zip,text/csv,application/zip"
        className="sr-only"
        disabled={disabled}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onFile(file);
          // Cleared so re-selecting the SAME file fires change again — the
          // natural thing to do after fixing a problem and retrying.
          event.target.value = "";
        }}
      />

      <Button
        type="button"
        variant="outline"
        className="mt-6"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        Choose a file
      </Button>

      <p className="text-meta text-fg-subtle mt-6 max-w-prose">
        Your file is read on this device. Only titles and years are sent to the
        server, to match them against TMDB — the file itself never leaves your
        browser.
      </p>
    </div>
  );
}
