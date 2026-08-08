import { parseImportFile, type ParseResult } from "./parse-file";
import type { ParseRequest, ParseResponse } from "./worker";
import { IMPORT_BATCH_LIMIT, type ImportRow, type ResolvedRow } from "./types";

/**
 * Client-side orchestration: get a dropped file parsed, then get its rows
 * resolved in batches.
 *
 * Everything here is browser-only and I/O-shaped. The decisions it drives
 * (what a row IS, what it matches, what gets written) all live in pure
 * modules with tests; this file only sequences them.
 */

/* ---------------------------------------------------------------------------
 * Parsing
 * ------------------------------------------------------------------------ */

/**
 * Parses in a Worker, falling back to the main thread.
 *
 * The fallback is not defensive padding — it is the difference between "this
 * browser janks for a second" and "import is broken here". Workers can fail
 * to construct for reasons that have nothing to do with the user (a strict
 * CSP, an unusual embedding), and parsing works perfectly well without one.
 * Degrading is strictly better than refusing.
 */
export async function parseFile(file: File): Promise<ParseResult> {
  const buffer = await file.arrayBuffer();

  let worker: Worker;
  try {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  } catch {
    return parseImportFile(file.name, buffer);
  }

  try {
    return await new Promise<ParseResult>((resolve, reject) => {
      worker.addEventListener("message", (event: MessageEvent<ParseResponse>) => {
        if (event.data.ok) resolve(event.data.result);
        else reject(new Error(event.data.message));
      });
      // A worker that dies mid-parse must not leave the UI waiting forever.
      worker.addEventListener("error", () => reject(new Error("Could not read that file.")));

      const request: ParseRequest = { fileName: file.name, buffer };
      // The buffer is TRANSFERRED, not copied — a multi-megabyte export
      // should not exist twice in memory. It becomes unusable on this side,
      // which is fine: nothing reads it again after this point.
      worker.postMessage(request, [buffer]);
    });
  } finally {
    worker.terminate();
  }
}

/* ---------------------------------------------------------------------------
 * Resolution
 * ------------------------------------------------------------------------ */

export interface ResolveProgress {
  done: number;
  total: number;
}

const MAX_RETRIES = 5;

function retryDelayMs(response: Response, attempt: number): number {
  const header = response.headers.get("retry-after");
  const seconds = header ? Number(header) : NaN;
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 60_000);
  // Exponential backoff, capped — a caller stuck behind a limit should slow
  // down, not give up, because the work is resumable and the user is watching
  // a progress bar either way.
  return Math.min(1000 * 2 ** attempt, 30_000);
}

async function postBatch(rows: readonly ImportRow[], signal: AbortSignal): Promise<ResolvedRow[]> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch("/api/import/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rows }),
      signal,
    });

    if (response.ok) {
      const body = (await response.json()) as { rows: ResolvedRow[] };
      return body.rows;
    }

    // 429 is our OWN limiter pacing a large import, which is expected rather
    // than exceptional — see RATE_LIMITS.importResolve. Wait it out.
    if (response.status === 429 && attempt < MAX_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(response, attempt)));
      continue;
    }

    throw new Error(
      response.status === 429
        ? "The server is still rate limiting this import. Try again in a few minutes."
        : "Couldn't match these titles. Check your connection and try again.",
    );
  }
}

/**
 * Resolves every row, a batch at a time.
 *
 * Batches run SEQUENTIALLY on purpose. Running several concurrently would
 * multiply into the server's own per-batch concurrency cap and burn the
 * per-IP limit faster, for a throughput gain the upstream cap would not
 * actually deliver.
 */
export async function resolveAll(
  rows: readonly ImportRow[],
  onProgress: (progress: ResolveProgress) => void,
  signal: AbortSignal,
): Promise<ResolvedRow[]> {
  const resolved: ResolvedRow[] = [];

  for (let start = 0; start < rows.length; start += IMPORT_BATCH_LIMIT) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const batch = rows.slice(start, start + IMPORT_BATCH_LIMIT);
    resolved.push(...(await postBatch(batch, signal)));
    onProgress({ done: resolved.length, total: rows.length });
  }

  return resolved;
}
