"use client";

import { useCallback, useRef, useState } from "react";

import { ProgressBar } from "@/components/tracking/progress-bar";
import { Button } from "@/components/ui/button";
import { AlertIcon, SpinnerIcon } from "@/components/ui/icons";
import type { TitleSummary } from "@/lib/content/types";
import { parseFile, resolveAll, type ResolveProgress } from "@/lib/import/client";
import { commitRow, committableRows, finishCommit } from "@/lib/import/commit";
import { importEventId } from "@/lib/import/ids";
import { resolveAmbiguous, type AmbiguousFile, type ParsedFile } from "@/lib/import/parse-file";
import {
  buildJob,
  findCompletedJob,
  saveJob,
  type ImportJob,
} from "@/lib/import/store";
import type { ImportRow, ImportSource, ResolvedRow } from "@/lib/import/types";
import { StorageError } from "@/lib/storage";
import { useSync } from "@/lib/sync/context";

import { ImportDropzone } from "./import-dropzone";
import { ImportPreview } from "./import-preview";
import { ReviewQueue } from "./review-queue";
import { SourcePicker } from "./source-picker";

/**
 * The import state machine.
 *
 * Every transition is driven by a user action or a promise continuation —
 * there is no `setState` in an effect body anywhere in this file, which is
 * both the `react-hooks/set-state-in-effect` rule and, here, the honest
 * shape: nothing about an import happens on its own.
 */

type Stage =
  | { kind: "idle" }
  | { kind: "parsing" }
  | { kind: "asking"; pending: AmbiguousFile[]; parsed: ParsedFile[]; importId: string }
  | { kind: "resolving"; progress: ResolveProgress }
  | { kind: "preview" }
  | { kind: "review" }
  | { kind: "committing"; done: number; total: number }
  | { kind: "done"; titles: number; events: number; ratings: number }
  | { kind: "error"; message: string };

export function ImportView() {
  const sync = useSync();
  const userId = sync?.userId ?? null;

  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [rows, setRows] = useState<ResolvedRow[]>([]);
  const [fileNames, setFileNames] = useState<string[]>([]);
  const [saveWarning, setSaveWarning] = useState<string | null>(null);
  const jobRef = useRef<ImportJob | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    jobRef.current = null;
    setRows([]);
    setFileNames([]);
    setSaveWarning(null);
    setStage({ kind: "idle" });
  }, []);

  /**
   * Persists the job, and treats a failure as information rather than an
   * error to swallow. The import continues either way — resolution and
   * commit both work from in-memory state — but the user is told plainly
   * that they cannot walk away and come back, which is the one promise a
   * failed save actually breaks.
   */
  const persist = useCallback(async (job: ImportJob) => {
    jobRef.current = job;
    try {
      await saveJob(job);
      setSaveWarning(null);
    } catch (error) {
      const quota = error instanceof StorageError && error.reason === "quota_exceeded";
      setSaveWarning(
        quota
          ? "This import is too large to save your progress. It will still work, but please finish it in one sitting — closing this tab will lose your review decisions."
          : "Your progress couldn't be saved to this browser. The import still works, but finish it in one sitting rather than coming back later.",
      );
    }
  }, []);

  const startResolve = useCallback(
    async (parsed: ParsedFile[], importId: string) => {
      const allRows: ImportRow[] = parsed.flatMap((file) => file.rows);
      if (allRows.length === 0) {
        setStage({ kind: "error", message: "That file had no rows we could read." });
        return;
      }

      const controller = new AbortController();
      abortRef.current = controller;
      setStage({ kind: "resolving", progress: { done: 0, total: allRows.length } });

      try {
        const resolved = await resolveAll(
          allRows,
          (progress) => setStage({ kind: "resolving", progress }),
          controller.signal,
        );
        setRows(resolved);
        await persist(
          buildJob({
            importId,
            fileName: parsed.map((f) => f.fileName).join(", "),
            source: parsed[0].source,
            resolved,
            options: {},
          }),
        );
        setStage({ kind: "preview" });
      } catch (error) {
        if (controller.signal.aborted) return;
        setStage({
          kind: "error",
          message: error instanceof Error ? error.message : "Matching failed.",
        });
      }
    },
    [persist],
  );

  const handleFile = useCallback(
    async (file: File) => {
      setStage({ kind: "parsing" });
      setFileNames([file.name]);

      try {
        const parse = await parseFile(file);

        const already = await findCompletedJob(parse.importId);
        if (already) {
          setStage({
            kind: "error",
            message: `You already imported this exact file on ${already.createdAt.toLocaleDateString()}. Importing it again would duplicate your history, so it has been stopped.`,
          });
          return;
        }

        setFileNames(parse.files.map((f) => f.fileName).concat(parse.ambiguous.map((f) => f.fileName)));

        if (parse.files.length === 0 && parse.ambiguous.length === 0) {
          setStage({
            kind: "error",
            message:
              parse.unrecognized.length > 0
                ? `We didn't recognize ${parse.unrecognized.join(", ")} as an IMDb or Letterboxd export.`
                : "That file isn't a supported export.",
          });
          return;
        }

        if (parse.ambiguous.length > 0) {
          setStage({
            kind: "asking",
            pending: parse.ambiguous,
            parsed: parse.files,
            importId: parse.importId,
          });
          return;
        }

        await startResolve(parse.files, parse.importId);
      } catch (error) {
        setStage({
          kind: "error",
          message: error instanceof Error ? error.message : "Could not read that file.",
        });
      }
    },
    [startResolve],
  );

  const answerAmbiguous = useCallback(
    async (source: ImportSource | null) => {
      if (stage.kind !== "asking") return;
      const [head, ...rest] = stage.pending;
      const parsed = source ? [...stage.parsed, resolveAmbiguous(head, source)] : stage.parsed;

      if (rest.length > 0) {
        setStage({ ...stage, pending: rest, parsed });
        return;
      }
      if (parsed.length === 0) {
        setStage({ kind: "error", message: "No files left to import." });
        return;
      }
      await startResolve(parsed, stage.importId);
    },
    [stage, startResolve],
  );

  const decide = useCallback(
    (index: number, decision: { chosen: TitleSummary | null; skipped: boolean }) => {
      setRows((previous) => {
        const next = previous.map((row, i) => (i === index ? { ...row, ...decision } : row));
        // Fire-and-forget: a persistence failure is already surfaced by
        // `persist`, and blocking each keystroke on a storage write would
        // make the queue feel broken.
        if (jobRef.current) {
          void persist(
            buildJob({
              importId: jobRef.current.importId,
              fileName: jobRef.current.fileName,
              source: jobRef.current.source,
              resolved: next,
              options: jobRef.current.options,
            }),
          );
        }
        return next;
      });
    },
    [persist],
  );

  const commit = useCallback(async () => {
    const toCommit = committableRows(rows);
    setStage({ kind: "committing", done: 0, total: toCommit.length });

    const totals = { titles: 0, events: 0, ratings: 0 };
    const importId = jobRef.current?.importId ?? "";

    for (let i = 0; i < toCommit.length; i += 1) {
      const resolved = toCommit[i];
      // Signed out there is no honest deterministic id, so events are written
      // without one — the established pre-account shape. See `importEventId`.
      const eventId = userId ? await importEventId(userId, importId, resolved.row) : null;

      const written = await commitRow(resolved, eventId, jobRef.current?.options ?? {});
      if (written.title) totals.titles += 1;
      if (written.event) totals.events += 1;
      if (written.rating) totals.ratings += 1;

      // Yielding every so often keeps the progress bar honest and the tab
      // responsive; a tight 3,000-iteration await loop would not repaint.
      if (i % 25 === 0) {
        setStage({ kind: "committing", done: i + 1, total: toCommit.length });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    if (jobRef.current) {
      void persist({ ...jobRef.current, status: "done", cursor: toCommit.length, committed: totals });
    }
    finishCommit();
    setStage({ kind: "done", ...totals });
  }, [rows, userId, persist]);

  /* ------------------------------------------------------------------- */

  if (stage.kind === "idle") {
    return <ImportDropzone onFile={(file) => void handleFile(file)} />;
  }

  if (stage.kind === "parsing") {
    return (
      <Busy label="Reading your file…" note="Large exports take a moment to hash and unzip." />
    );
  }

  if (stage.kind === "asking") {
    return (
      <SourcePicker
        file={stage.pending[0]}
        onAnswer={(source) => void answerAmbiguous(source)}
        onCancel={() => void answerAmbiguous(null)}
      />
    );
  }

  if (stage.kind === "resolving") {
    const percent =
      stage.progress.total === 0
        ? 0
        : Math.round((stage.progress.done / stage.progress.total) * 100);
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <Busy
          label={`Matching ${stage.progress.done} of ${stage.progress.total} rows…`}
          note="Identical titles are looked up once, and the pace is deliberately limited so this never overloads TMDB."
        />
        <ProgressBar percent={percent} />
        <Button type="button" variant="ghost" size="sm" onClick={reset}>
          Cancel
        </Button>
      </div>
    );
  }

  if (stage.kind === "preview") {
    return (
      <ImportPreview
        rows={rows}
        fileNames={fileNames}
        saveWarning={saveWarning}
        onReview={() => setStage({ kind: "review" })}
        onCommit={() => void commit()}
        onCancel={reset}
      />
    );
  }

  if (stage.kind === "review") {
    return (
      <ReviewQueue rows={rows} onDecide={decide} onFinish={() => setStage({ kind: "preview" })} />
    );
  }

  if (stage.kind === "committing") {
    const percent = stage.total === 0 ? 100 : Math.round((stage.done / stage.total) * 100);
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <Busy label={`Importing ${stage.done} of ${stage.total}…`} note="Don't close this tab." />
        <ProgressBar percent={percent} />
      </div>
    );
  }

  if (stage.kind === "done") {
    return (
      <div className="mx-auto max-w-xl space-y-4 text-center">
        <h2 className="font-display text-display-lg text-fg uppercase">Import complete</h2>
        <p className="text-body text-fg-muted">
          {stage.titles} title{stage.titles === 1 ? "" : "s"} added or updated
          {stage.ratings > 0 && `, ${stage.ratings} rating${stage.ratings === 1 ? "" : "s"}`}
          {stage.events > 0 && `, ${stage.events} watch date${stage.events === 1 ? "" : "s"}`}.
        </p>
        {/* A FULL document load, not a client-side push: the tracking and
            ratings contexts were mounted before this import ran and do not
            observe storage changes made outside them (see the multi-tab note
            in CLAUDE.md). Navigating in-app would show a stale library and
            look like the import silently failed. */}
        <Button type="button" onClick={() => window.location.assign("/library")}>
          See your library
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <div className="border-danger/40 bg-danger/10 flex gap-3 rounded-md border px-4 py-3">
        <AlertIcon className="text-danger mt-0.5 size-5 shrink-0" />
        <p className="text-body-sm text-fg">{stage.message}</p>
      </div>
      <Button type="button" variant="outline" onClick={reset}>
        Try another file
      </Button>
    </div>
  );
}

function Busy({ label, note }: { label: string; note: string }) {
  return (
    <div className="text-center" role="status" aria-live="polite">
      <SpinnerIcon className="text-accent mx-auto size-8 motion-safe:animate-spin" />
      <p className="font-display text-display-sm text-fg mt-4 uppercase">{label}</p>
      <p className="text-meta text-fg-subtle mx-auto mt-1 max-w-prose">{note}</p>
    </div>
  );
}
