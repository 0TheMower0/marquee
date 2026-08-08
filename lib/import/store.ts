import { defineStore } from "@/lib/storage";
import type { TitleSummary } from "@/lib/content/types";

import type { CommitOptions } from "./commit";
import type { ImportRow, ImportSource, MatchBucket, ResolvedRow } from "./types";

/**
 * Persisted import jobs — what makes an import resumable across a reload,
 * and what makes re-selecting the same file a recognized no-op rather than a
 * silent doubling of someone's history.
 *
 * ============================================================================
 * THE STORAGE BUDGET IS THE BINDING CONSTRAINT HERE
 * ============================================================================
 * localStorage is ~5MB, and a resolved 3,000-row import is not small. Stored
 * naively — every row with its five scored candidates, each a full
 * `TitleSummary` carrying an `overview` paragraph — a large import is
 * comfortably several megabytes and would blow the budget for the user's
 * ACTUAL library data, which is the thing this app exists to protect.
 *
 * So the persisted shape is deliberately lossy in three ways:
 *
 *   1. `overview` is dropped from every stored summary. It is the single
 *      largest field and nothing in the import UI renders it.
 *   2. Candidates are kept ONLY for rows still awaiting a decision. Once a
 *      row is decided, the alternatives it was offered are history.
 *   3. Auto-matched rows keep their chosen title and nothing else.
 *
 * Even so, a very large import can exceed quota. That is handled honestly
 * rather than hidden: `saveJob` lets the `StorageError` propagate, and the UI
 * tells the user their progress cannot be saved and to finish in one sitting.
 * A silent failure here would be worse — the user would close the tab
 * believing they could resume.
 */

/** A `TitleSummary` with the expensive field removed. Rehydrated with an
 *  empty `overview`, which is truthful (we no longer know it) and satisfies
 *  the type without pretending to data we discarded. */
type StoredSummary = Omit<TitleSummary, "overview">;

interface StoredCandidate {
  summary: StoredSummary;
  score: number;
  reason: string;
}

interface StoredRow {
  row: ImportRow;
  bucket: MatchBucket;
  chosen: StoredSummary | null;
  skipped: boolean;
  /** Present only while the row is undecided. */
  candidates?: StoredCandidate[];
}

export type ImportJobStatus = "review" | "committing" | "done";

export interface ImportJob {
  importId: string;
  fileName: string;
  source: ImportSource;
  createdAt: Date;
  updatedAt: Date;
  status: ImportJobStatus;
  rows: StoredRow[];
  /** Index into `rows` the commit has reached. Advanced after each row
   *  succeeds, so a resumed commit starts exactly where it stopped — the
   *  cursor-walk half of the no-transactions story in `commit.ts`. */
  cursor: number;
  options: CommitOptions;
  committed: { titles: number; events: number; ratings: number };
}

function strip(summary: TitleSummary): StoredSummary {
  const { overview: _overview, ...rest } = summary;
  void _overview;
  return rest;
}

function rehydrate(summary: StoredSummary): TitleSummary {
  return { ...summary, overview: "" };
}

export function toStoredRow(resolved: ResolvedRow): StoredRow {
  const decided = resolved.skipped || resolved.chosen !== null;
  return {
    row: resolved.row,
    bucket: resolved.bucket,
    chosen: resolved.chosen ? strip(resolved.chosen) : null,
    skipped: resolved.skipped,
    // Alternatives are only worth their bytes while a human still has to
    // choose between them.
    candidates: decided
      ? undefined
      : resolved.candidates.map((candidate) => ({
          summary: strip(candidate.summary),
          score: candidate.score,
          reason: candidate.reason,
        })),
  };
}

export function fromStoredRow(stored: StoredRow): ResolvedRow {
  return {
    row: stored.row,
    bucket: stored.bucket,
    chosen: stored.chosen ? rehydrate(stored.chosen) : null,
    skipped: stored.skipped,
    candidates: (stored.candidates ?? []).map((candidate) => ({
      summary: rehydrate(candidate.summary),
      score: candidate.score,
      reason: candidate.reason,
    })),
  };
}

function isImportJob(value: unknown): value is ImportJob {
  if (typeof value !== "object" || value === null) return false;
  const job = value as Record<string, unknown>;
  return (
    typeof job.importId === "string" &&
    typeof job.fileName === "string" &&
    Array.isArray(job.rows) &&
    typeof job.cursor === "number"
  );
}

/**
 * Keyed by `importId`, which is a hash of the file's bytes — so re-selecting
 * the same export finds the same record. Version 1, and per this project's
 * standing rule a migration for it could never be deleted once written.
 */
export const importJobStore = defineStore<ImportJob>({
  namespace: "import",
  version: 1,
  validate: isImportJob,
});

export interface NewJobInput {
  importId: string;
  fileName: string;
  source: ImportSource;
  resolved: readonly ResolvedRow[];
  options: CommitOptions;
}

export function buildJob(input: NewJobInput, now: Date = new Date()): ImportJob {
  return {
    importId: input.importId,
    fileName: input.fileName,
    source: input.source,
    createdAt: now,
    updatedAt: now,
    status: "review",
    rows: input.resolved.map(toStoredRow),
    cursor: 0,
    options: input.options,
    committed: { titles: 0, events: 0, ratings: 0 },
  };
}

/**
 * Persists a job.
 *
 * ============================================================================
 * THIS DELIBERATELY DOES NOT SWALLOW A QUOTA FAILURE
 * ============================================================================
 * Everywhere else in this app a failed local write degrades quietly, because
 * losing a nicety beats interrupting the user. Here it must not: the whole
 * value of saving a job is the promise that the user can close the tab and
 * come back. Swallowing the error keeps that promise on screen while breaking
 * it in fact, and the user only finds out after losing an hour of review
 * decisions.
 *
 * So the `StorageError` propagates and the caller is expected to tell the
 * user plainly that progress cannot be saved and this import needs finishing
 * in one sitting. That is the same reasoning `takePreMergeBackup` uses for
 * aborting a merge on a failed backup write — when the write IS the safety
 * net, a silent failure is worse than a loud one.
 *
 * The import itself is unaffected: resolution and commit both work entirely
 * from in-memory state.
 */
export async function saveJob(job: ImportJob): Promise<void> {
  await importJobStore.set(job.importId, { ...job, updatedAt: new Date() });
}

/** Every saved job, newest first. */
export async function listJobs(): Promise<ImportJob[]> {
  const jobs = await importJobStore.getAll();
  return Object.values(jobs).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/**
 * A previously COMPLETED import of the same file, if there is one.
 *
 * This is the guard that makes re-importing safe for a signed-out user, who
 * has no deterministic event ids to dedupe on (see `importEventId`). The UI
 * uses it to say "you imported this on 12 August" instead of quietly writing
 * a second copy of everything.
 */
export async function findCompletedJob(importId: string): Promise<ImportJob | null> {
  const job = await importJobStore.get(importId);
  return job && job.status === "done" ? job : null;
}
