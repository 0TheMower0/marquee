import { parseCsvTable, type CsvTable } from "./csv";
import { importIdFor } from "./ids";
import { detectSource, isAmbiguousLetterboxdTable, parseAs } from "./sources";
import { hasNoResolvablePath, unresolvableIdColumns } from "./sources/trakt";
import type { ImportRow, ImportSource } from "./types";
import { ZipError, csvEntries, looksLikeZip, readZip } from "./zip";

/**
 * Turning a dropped file into rows.
 *
 * Lives apart from `worker.ts` so it is a plain, testable function with no
 * `postMessage` in it — the worker is a thin transport around this, and the
 * main-thread fallback calls the very same code. One implementation, two ways
 * of reaching it.
 */

/** A CSV whose identity could not be settled from its header. Currently only
 *  Letterboxd's `watchlist.csv` / `watched.csv`, whose headers are
 *  byte-identical — the UI must ASK rather than guess, because the difference
 *  is "plan to watch" versus "have seen" across a whole library. */
export interface AmbiguousFile {
  fileName: string;
  /**
   * The raw CSV text, re-parsed once the user answers.
   *
   * ============================================================================
   * WHY THE TEXT AND NOT THE PARSED TABLE
   * ============================================================================
   * Holding the `CsvTable` here is the obvious optimization and it breaks the
   * worker outright: `CsvRecord` exposes `get`/`has` as METHODS, and functions
   * cannot be structured-cloned. `postMessage` throws
   * "…could not be cloned", so an ambiguous file — the exact case this type
   * exists for — took the whole import down.
   *
   * Found by live testing, not by a unit test: every module involved was
   * individually correct and the failure lived only at the worker boundary.
   * `parse-file.test.ts` now asserts a `ParseResult` survives
   * `structuredClone`, so this cannot silently return.
   *
   * The cost is re-parsing one small file after the user answers, which is
   * microseconds.
   */
  text: string;
  choices: readonly ImportSource[];
}

export interface ParsedFile {
  fileName: string;
  source: ImportSource;
  rows: ImportRow[];
}

/**
 * A file that parsed fine but whose rows cannot be matched automatically.
 *
 * Surfaced BEFORE resolution, deliberately. A community-tool Trakt export
 * configured with `trakt` or `tvdb` ids has no id we can resolve and no
 * `year` column, so every row would land in the review queue — and finding
 * that out after a multi-minute resolve, having spent the upstream budget, is
 * the worst possible moment. Re-exporting with a different id format is a
 * cheap thing to go and do, but only if you learn you need to.
 */
export interface ImportWarning {
  fileName: string;
  kind: "no-resolvable-id";
  /** Column names the export used that we cannot resolve, for the message. */
  columns: string[];
}

export interface ParseResult {
  /** Deterministic from the file's bytes. Re-selecting the same export
   *  yields the same id, which is how a repeat import is recognized. */
  importId: string;
  files: ParsedFile[];
  ambiguous: AmbiguousFile[];
  /** Files that are not a supported export at all, named so the user can see
   *  which ones were ignored rather than wondering why a count looks low. */
  unrecognized: string[];
  /** Non-fatal: the import can proceed, but the user should know first. */
  warnings: ImportWarning[];
}

export const LETTERBOXD_AMBIGUOUS_CHOICES = [
  "letterboxd-watchlist",
  "letterboxd-watched",
] as const;

function classifyTable(fileName: string, table: CsvTable) {
  const source = detectSource(table, fileName);
  if (source) return { kind: "parsed" as const, source };
  if (isAmbiguousLetterboxdTable(table)) return { kind: "ambiguous" as const };
  return { kind: "unrecognized" as const };
}

/**
 * Parses one dropped file — a loose CSV, or a Letterboxd export ZIP.
 *
 * The ZIP path is detected by SIGNATURE rather than by extension, so a file
 * the browser mislabels or the user renamed still routes correctly.
 */
export async function parseImportFile(
  fileName: string,
  buffer: ArrayBuffer,
): Promise<ParseResult> {
  const bytes = new Uint8Array(buffer);
  const importId = await importIdFor(bytes);

  const files: ParsedFile[] = [];
  const ambiguous: AmbiguousFile[] = [];
  const unrecognized: string[] = [];
  const warnings: ImportWarning[] = [];

  const sources: { name: string; text: string }[] = [];

  if (looksLikeZip(buffer)) {
    const entries = csvEntries(await readZip(buffer));
    if (entries.length === 0) {
      throw new ZipError("That ZIP contains no CSV files.");
    }
    for (const entry of entries) {
      sources.push({ name: entry.name, text: await entry.text() });
    }
  } else {
    sources.push({ name: fileName, text: new TextDecoder().decode(bytes) });
  }

  for (const { name, text } of sources) {
    const table = parseCsvTable(text);
    const outcome = classifyTable(name, table);
    if (outcome.kind === "parsed") {
      files.push({ fileName: name, source: outcome.source, rows: parseAs(table, outcome.source) });
      if (hasNoResolvablePath(table)) {
        warnings.push({
          fileName: name,
          kind: "no-resolvable-id",
          columns: unresolvableIdColumns(table),
        });
      }
    } else if (outcome.kind === "ambiguous") {
      // Only the TEXT crosses the worker boundary — see the note on
      // `AmbiguousFile.text`.
      ambiguous.push({ fileName: name, text, choices: LETTERBOXD_AMBIGUOUS_CHOICES });
    } else {
      unrecognized.push(name);
    }
  }

  return { importId, files, ambiguous, unrecognized, warnings };
}

/** Applies a user's answer to an ambiguous file. Kept here rather than in the
 *  component so the "ask, then parse" flow is one code path with the
 *  unambiguous one. */
export function resolveAmbiguous(file: AmbiguousFile, source: ImportSource): ParsedFile {
  return { fileName: file.fileName, source, rows: parseAs(parseCsvTable(file.text), source) };
}
